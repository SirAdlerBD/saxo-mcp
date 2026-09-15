/**
 * Builds the MCP server with all read-only tools registered.
 * Separated from index.ts so tests can construct a server with a fake fetch.
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

export function createServer(config: AppConfig, fetchImpl: typeof fetch = fetch): McpServer {
  const tokens = new TokenManager(config, new TokenStore(config.tokenFile), fetchImpl);
  const client = new SaxoClient(config, tokens, fetchImpl);
  const portfolio = new PortfolioApi(client);
  const marketData = new MarketDataApi(client);

  const server = new McpServer(
    { name: "saxo-mcp", version: "0.1.0" },
    {
      instructions:
        `Read-only access to a Saxo Bank account (${config.env.toUpperCase()} environment). ` +
        "Tools can list balances, positions, open orders, history and market data. " +
        "Nothing here can place, modify or cancel orders. If a tool reports AUTHENTICATION REQUIRED, " +
        "tell the user to run `npm run login` in the saxo-mcp directory.",
    }
  );

  registerPortfolioTools(server, portfolio);
  registerMarketDataTools(server, marketData, portfolio);
  return server;
}
