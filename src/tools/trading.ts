/**
 * Trading tools. Registered ONLY when SAXO_TRADING=enabled. Even then every
 * request passes SaxoClient's hard block, which re-checks the switch.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PortfolioApi } from "../saxo/portfolio.js";
import type { NewOrder, TradingApi } from "../saxo/trading.js";
import { assetTypeParam, run, uicParam } from "./shared.js";

const TRADING_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const orderFields = {
  uic: uicParam,
  assetType: assetTypeParam,
  amount: z.number().positive().describe("Quantity (shares/contracts) or notional for FX."),
  orderType: z.enum(["Market", "Limit", "Stop", "StopLimit", "StopIfTraded", "TrailingStop", "TrailingStopIfTraded"]),
  orderPrice: z.number().positive().optional().describe("Limit or stop price. Required for every orderType except Market."),
  stopLimitPrice: z.number().positive().optional().describe("Limit price once a StopLimit order triggers."),
  trailingStopDistanceToMarket: z.number().positive().optional(),
  trailingStopStep: z.number().positive().optional(),
  durationType: z
    .enum(["DayOrder", "GoodTillCancel", "GoodTillDate", "ImmediateOrCancel", "FillOrKill", "AtTheOpening", "AtTheClose"])
    .optional()
    .describe("Default DayOrder."),
  expirationDateTime: z.string().optional().describe("Required for GoodTillDate, e.g. 2024-12-31T17:00:00."),
  externalReference: z.string().max(50).optional().describe("Your own correlation id, echoed back by Saxo."),
  accountKey: z.string().optional().describe("AccountKey to trade on. Omit for the default account."),
};

function validateOrderShape(o: { orderType: string; orderPrice?: number; durationType?: string; expirationDateTime?: string }): void {
  if (o.orderType !== "Market" && o.orderPrice === undefined) {
    throw new Error(`orderPrice is required for orderType ${o.orderType}.`);
  }
  if (o.durationType === "GoodTillDate" && !o.expirationDateTime) {
    throw new Error("expirationDateTime is required for durationType GoodTillDate.");
  }
}

async function buildOrder(
  portfolio: PortfolioApi,
  a: z.infer<z.ZodObject<typeof orderFields>> & { buySell: "Buy" | "Sell" }
): Promise<NewOrder> {
  validateOrderShape(a);
  const { accountKey } = await portfolio.context.keys(a.accountKey);
  const durationType = a.durationType ?? "DayOrder";
  return {
    AccountKey: accountKey,
    Uic: a.uic,
    AssetType: a.assetType,
    BuySell: a.buySell,
    Amount: a.amount,
    OrderType: a.orderType,
    OrderPrice: a.orderPrice,
    StopLimitPrice: a.stopLimitPrice,
    TrailingstopDistanceToMarket: a.trailingStopDistanceToMarket,
    TrailingStopStep: a.trailingStopStep,
    OrderDuration:
      durationType === "GoodTillDate"
        ? { DurationType: durationType, ExpirationDateTime: a.expirationDateTime, ExpirationDateContainsTime: true }
        : { DurationType: durationType },
    ManualOrder: true,
    ExternalReference: a.externalReference,
  };
}

export function registerTradingTools(server: McpServer, api: TradingApi, portfolio: PortfolioApi): void {
  server.registerTool(
    "precheck_order",
    {
      title: "Precheck an order (dry run)",
      description:
        "Validate an order WITHOUT placing it: returns estimated costs, margin impact and any validation errors. " +
        "Use this before place_order and show the result to the user.",
      inputSchema: { buySell: z.enum(["Buy", "Sell"]), ...orderFields },
      annotations: { ...TRADING_ANNOTATIONS, destructiveHint: false, readOnlyHint: true },
    },
    async (a) => run(async () => api.precheckOrder(await buildOrder(portfolio, a)))
  );

  server.registerTool(
    "place_order",
    {
      title: "Place an order (REAL ACTION)",
      description:
        "Places a new order on the account. This commits the user to a trade. Only call it after the user has " +
        "explicitly confirmed the exact instrument, side, amount, order type, price and duration. " +
        "Prefer precheck_order first.",
      inputSchema: {
        buySell: z.enum(["Buy", "Sell"]),
        ...orderFields,
        confirm: z.literal(true).describe("Must be true. Confirms the user explicitly approved this exact order."),
      },
      annotations: TRADING_ANNOTATIONS,
    },
    async (a) =>
      run(async () => {
        const order = await buildOrder(portfolio, a);
        const result = await api.placeOrder(order);
        return { placed: true, order, result };
      })
  );

  server.registerTool(
    "modify_order",
    {
      title: "Modify an open order (REAL ACTION)",
      description:
        "Changes amount, price, type or duration of an existing open order. Get the OrderId from get_orders. " +
        "All order fields must be supplied (Saxo replaces the order definition). Requires explicit user confirmation.",
      inputSchema: {
        orderId: z.string().min(1),
        ...orderFields,
        confirm: z.literal(true).describe("Must be true. Confirms the user explicitly approved this change."),
      },
      annotations: TRADING_ANNOTATIONS,
    },
    async (a) =>
      run(async () => {
        validateOrderShape(a);
        const { accountKey } = await portfolio.context.keys(a.accountKey);
        const durationType = a.durationType ?? "DayOrder";
        const result = await api.modifyOrder({
          OrderId: a.orderId,
          AccountKey: accountKey,
          Uic: a.uic,
          AssetType: a.assetType,
          Amount: a.amount,
          OrderType: a.orderType,
          OrderPrice: a.orderPrice,
          StopLimitPrice: a.stopLimitPrice,
          TrailingstopDistanceToMarket: a.trailingStopDistanceToMarket,
          TrailingStopStep: a.trailingStopStep,
          OrderDuration:
            durationType === "GoodTillDate"
              ? { DurationType: durationType, ExpirationDateTime: a.expirationDateTime, ExpirationDateContainsTime: true }
              : { DurationType: durationType },
          ExternalReference: a.externalReference,
        });
        return { modified: true, orderId: a.orderId, result };
      })
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel an open order (REAL ACTION)",
      description: "Cancels an open order by OrderId (from get_orders). Requires explicit user confirmation.",
      inputSchema: {
        orderId: z.string().min(1),
        accountKey: z.string().optional().describe("AccountKey the order belongs to. Omit for the default account."),
        confirm: z.literal(true).describe("Must be true. Confirms the user explicitly approved cancelling this order."),
      },
      annotations: TRADING_ANNOTATIONS,
    },
    async ({ orderId, accountKey }) =>
      run(async () => {
        const keys = await portfolio.context.keys(accountKey);
        const result = await api.cancelOrder(orderId, keys.accountKey);
        return { cancelled: true, orderId, result };
      })
  );
}
