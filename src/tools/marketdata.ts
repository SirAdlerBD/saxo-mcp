/**
 * Market data tools. Search first to obtain a UIC, then use it everywhere else.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHART_HORIZONS, type ChartHorizon, type MarketDataApi } from "../saxo/marketdata.js";
import type { PortfolioApi } from "../saxo/portfolio.js";
import { READ_ONLY_ANNOTATIONS, assetTypeParam, run, uicParam } from "./shared.js";

export function registerMarketDataTools(server: McpServer, api: MarketDataApi, portfolio: PortfolioApi): void {
  server.registerTool(
    "search_instruments",
    {
      title: "Search instruments",
      description:
        "Look up instruments by name, ticker or ISIN and get their Saxo UIC + AssetType, which the other market data " +
        "tools need. Returns Identifier (the UIC), Symbol, Description, AssetType, ExchangeId and CurrencyCode.",
      inputSchema: {
        keywords: z.string().min(1).describe('Name, ticker or ISIN, e.g. "Apple", "AAPL", "EURUSD".'),
        assetTypes: z
          .string()
          .optional()
          .describe('Comma-separated AssetType filter, e.g. "Stock" or "Stock,Etf" or "FxSpot". Omit for all.'),
        exchangeId: z.string().optional().describe('Exchange filter, e.g. "NASDAQ", "NYSE", "XETR".'),
        top: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        includeNonTradable: z.boolean().optional(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ keywords, assetTypes, exchangeId, top, includeNonTradable }) =>
      run(async () => {
        // AccountKey lets Saxo filter to instruments tradable on the account; fall back to no filter if unavailable.
        const accountKey = await portfolio.context
          .keys()
          .then((k) => k.accountKey)
          .catch(() => undefined);
        const res = await api.searchInstruments({ keywords, assetTypes, exchangeId, top, accountKey, includeNonTradable });
        return {
          count: res.Data.length,
          hint: "Use Identifier as `uic` and AssetType as `assetType` in the other tools.",
          instruments: res.Data,
        };
      })
  );

  server.registerTool(
    "get_instrument_details",
    {
      title: "Instrument details",
      description:
        "Contract specification for one instrument: description, currency, exchange, tick size / price decimals, " +
        "lot and minimum trade size, trading sessions (trading hours) and other reference data.",
      inputSchema: {
        uic: uicParam,
        assetType: assetTypeParam,
        includeTradingSchedule: z.boolean().optional().describe("Also fetch the trading schedule (default true)."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ uic, assetType, includeTradingSchedule }) =>
      run(async () => {
        const accountKey = await portfolio.context
          .keys()
          .then((k) => k.accountKey)
          .catch(() => undefined);
        const details = await api.instrumentDetails(uic, assetType, accountKey);
        if (includeTradingSchedule === false) return details;
        const tradingSchedule = await api.tradingSchedule(uic, assetType).catch((err: Error) => ({ unavailable: err.message }));
        return { ...details, TradingSchedule: tradingSchedule };
      })
  );

  server.registerTool(
    "get_instrument_price",
    {
      title: "Current price quote",
      description:
        "Current informational quote for an instrument: bid, ask, mid, last traded, day open/high/low, net and " +
        "percent change, market open flag and whether the price is delayed. Read-only; never creates an order.",
      inputSchema: { uic: uicParam, assetType: assetTypeParam },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ uic, assetType }) =>
      run(async () => {
        const accountKey = await portfolio.context
          .keys()
          .then((k) => k.accountKey)
          .catch(() => undefined);
        return api.infoPrice(uic, assetType, accountKey);
      })
  );

  server.registerTool(
    "get_chart_data",
    {
      title: "Historical OHLC bars",
      description:
        "Historical price bars (open/high/low/close, volume where available; FX returns bid/ask OHLC). " +
        `horizon is the bar size in minutes: ${CHART_HORIZONS.join(", ")} (1440 = daily, 10080 = weekly, 43200 = monthly). ` +
        "Up to 1200 bars per call; pass time + mode to page further back.",
      inputSchema: {
        uic: uicParam,
        assetType: assetTypeParam,
        horizon: z.number().int().refine((h): h is ChartHorizon => (CHART_HORIZONS as readonly number[]).includes(h), {
          message: `horizon must be one of ${CHART_HORIZONS.join(", ")}`,
        }),
        count: z.number().int().min(1).max(1200).optional().describe("Number of bars (default Saxo: 1200)."),
        time: z.string().optional().describe("ISO-8601 timestamp anchor, e.g. 2024-01-31T00:00:00Z."),
        mode: z.enum(["From", "UpTo"]).optional().describe("Bars From or UpTo `time` (default UpTo)."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ uic, assetType, horizon, count, time, mode }) =>
      run(async () => {
        const res = await api.chart({ uic, assetType, horizon: horizon as ChartHorizon, count, time, mode });
        return { count: res.Data?.length ?? 0, chartInfo: res.ChartInfo, displayAndFormat: res.DisplayAndFormat, bars: res.Data };
      })
  );
}
