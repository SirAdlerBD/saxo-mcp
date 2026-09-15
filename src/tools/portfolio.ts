/**
 * Portfolio tools. All read-only: they list and describe, never act.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PortfolioApi } from "../saxo/portfolio.js";
import { READ_ONLY_ANNOTATIONS, accountKeyParam, defaultRange, isoDate, run, wholeClientParam } from "./shared.js";

export function registerPortfolioTools(server: McpServer, api: PortfolioApi, tradingEnabled = false): void {
  server.registerTool(
    "get_account_summary",
    {
      title: "Account summary",
      description:
        "Basic information about the logged-in Saxo user, the client entity and all its accounts " +
        "(AccountKey, currency, type). Call this first: other tools take an optional AccountKey from here.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () =>
      run(async () => {
        const [user, client, accounts] = await Promise.all([api.user(), api.clientInfo(), api.accounts()]);
        return {
          environment: "Values come from the environment configured in SAXO_ENV (sim during development).",
          trading: tradingEnabled
            ? "ENABLED (SAXO_TRADING=enabled): order tools are available and act on this account."
            : "DISABLED (hard block): this server cannot place, modify or cancel orders.",
          user,
          client,
          accounts: accounts.Data,
        };
      })
  );

  server.registerTool(
    "get_balances",
    {
      title: "Balances",
      description:
        "Cash balance, total account value, margin available/used, unrealised P&L and open position/order counts " +
        "for one account (default) or the whole client.",
      inputSchema: { accountKey: accountKeyParam, wholeClient: wholeClientParam },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ accountKey, wholeClient }) => run(() => api.balances(accountKey, wholeClient))
  );

  server.registerTool(
    "get_positions",
    {
      title: "Open positions",
      description:
        "Open positions with open price, current price, exposure and profit/loss. " +
        'view="individual" (default) lists every position; view="net" nets positions per instrument.',
      inputSchema: {
        accountKey: accountKeyParam,
        wholeClient: wholeClientParam,
        view: z.enum(["individual", "net"]).optional().describe("individual (default) or net"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ accountKey, wholeClient, view }) =>
      run(async () => {
        const res = view === "net" ? await api.netPositions(accountKey, wholeClient) : await api.positions(accountKey, wholeClient);
        return { count: res.Data.length, positions: res.Data };
      })
  );

  server.registerTool(
    "get_orders",
    {
      title: "Open orders (view only)",
      description:
        "LISTS currently open/working orders (type, amount, price, status, duration). " +
        "This is strictly a viewing tool: this server cannot place, modify or cancel orders.",
      inputSchema: { accountKey: accountKeyParam, wholeClient: wholeClientParam },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ accountKey, wholeClient }) =>
      run(async () => {
        const res = await api.openOrders(accountKey, wholeClient);
        return { count: res.Data.length, orders: res.Data };
      })
  );

  server.registerTool(
    "get_account_history",
    {
      title: "Account performance history",
      description:
        "Historical account performance. report=summary (default) returns key figures, returns, allocation and trade " +
        "statistics for the period; report=timeseries returns day-by-day account value / balance / time-weighted return " +
        "series. Choose a standardPeriod (Month, Quarter, Year, AllTime) or an explicit fromDate/toDate.",
      inputSchema: {
        report: z.enum(["summary", "timeseries"]).optional(),
        standardPeriod: z.enum(["Month", "Quarter", "Year", "AllTime"]).optional(),
        fromDate: isoDate.optional(),
        toDate: isoDate.optional(),
        accountKey: accountKeyParam,
        wholeClient: wholeClientParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ report, standardPeriod, fromDate, toDate, accountKey, wholeClient }) =>
      run(() => {
        const range = standardPeriod ? { standardPeriod } : fromDate && toDate ? { fromDate, toDate } : { standardPeriod: "Month" as const };
        return report === "timeseries"
          ? api.performanceTimeseries(range, accountKey, wholeClient)
          : api.performanceSummary(range, accountKey, wholeClient);
      })
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Transaction / trade history",
      description:
        "Historical transaction log. type=trades (default): executed trades. type=bookings: cash bookings such as " +
        "deposits, withdrawals, dividends, fees and settlements. type=order_activities: audit trail of order events " +
        "(placed, filled, cancelled). Defaults to the last 30 days.",
      inputSchema: {
        type: z.enum(["trades", "bookings", "order_activities"]).optional(),
        fromDate: isoDate.optional(),
        toDate: isoDate.optional(),
        accountKey: accountKeyParam,
        wholeClient: wholeClientParam,
        top: z.number().int().min(1).max(1000).optional().describe("Max rows to return (default 200)."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ type, fromDate, toDate, accountKey, wholeClient, top }) =>
      run(async () => {
        const d = defaultRange();
        const from = fromDate ?? d.fromDate;
        const to = toDate ?? d.toDate;
        const res =
          type === "bookings"
            ? await api.bookingsReport(from, to, accountKey, wholeClient, top)
            : type === "order_activities"
              ? await api.orderActivities(from, to, accountKey, wholeClient, top)
              : await api.tradesReport(from, to, accountKey, wholeClient, top);
        return { type: type ?? "trades", fromDate: from, toDate: to, count: res.Data?.length ?? 0, data: res.Data ?? res };
      })
  );
}
