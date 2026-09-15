/**
 * Builds the MCP server with all tools registered.
 *
 * Two layers:
 *   - createDeps(): the Saxo side (token manager, HTTP client, APIs). This is
 *     process-wide state. There must be exactly ONE TokenManager per process,
 *     because every refresh invalidates the previous refresh token; two
 *     managers refreshing independently would lock each other out.
 *   - createServerWithDeps(): an McpServer wired to those deps. An McpServer
 *     can only be connected to one transport, so the HTTP entry point builds
 *     one per session while sharing a single set of deps.
 *
 * createServer() keeps the original one-call signature used by the stdio
 * entry point (src/index.ts), which is unchanged.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { TokenManager } from "./auth/tokenManager.js";
import { TokenStore } from "./auth/tokenStore.js";
import { SaxoClient } from "./saxo/client.js";
import { PortfolioApi } from "./saxo/portfolio.js";
import { MarketDataApi } from "./saxo/marketdata.js";
import { registerPortfolioTools } from "./tools/portfolio.js";
import { registerMarketDataTools } from "./tools/marketdata.js";
import { TradingApi } from "./saxo/trading.js";
import { registerTradingTools } from "./tools/trading.js";

export interface SaxoDeps {
  tokens: TokenManager;
  client: SaxoClient;
  portfolio: PortfolioApi;
  marketData: MarketDataApi;
  trading: TradingApi;
}

export function createDeps(config: AppConfig, fetchImpl: typeof fetch = fetch): SaxoDeps {
  const tokens = new TokenManager(config, new TokenStore(config.tokenFile), fetchImpl);
  const client = new SaxoClient(config, tokens, fetchImpl);
  return {
    tokens,
    client,
    portfolio: new PortfolioApi(client),
    marketData: new MarketDataApi(client),
    trading: new TradingApi(client),
  };
}

export function createServer(config: AppConfig, fetchImpl: typeof fetch = fetch): McpServer {
  return createServerWithDeps(config, createDeps(config, fetchImpl));
}

export function createServerWithDeps(config: AppConfig, deps: SaxoDeps): McpServer {
  const { portfolio, marketData, trading } = deps;

  const tradingNote = config.tradingEnabled
    ? "TRADING IS ENABLED: precheck_order, place_order, modify_order and cancel_order are available. " +
      "They act on a real account. Never call place_order, modify_order or cancel_order without the user's explicit, " +
      "specific confirmation of every parameter, and run precheck_order first whenever possible. "
    : "Trading is disabled (hard block): nothing here can place, modify or cancel orders. If the user asks to trade, " +
      "explain that the server owner must set SAXO_TRADING=enabled and restart. ";

  const server = new McpServer(
    { name: "saxo-mcp", version: "0.1.0" },
    {
      instructions:
        `Access to a Saxo Bank account (${config.env.toUpperCase()} environment). ` +
        "Tools can list balances, positions, open orders, history and market data. " +
        tradingNote +
        "If a tool reports AUTHENTICATION REQUIRED, tell the user to run `npm run login` in the saxo-mcp directory.",
    }
  );

  registerPortfolioTools(server, portfolio, config.tradingEnabled);
  registerMarketDataTools(server, marketData, portfolio);
  if (config.tradingEnabled) {
    registerTradingTools(server, trading, portfolio);
  }
  return server;
}
