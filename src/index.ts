#!/usr/bin/env node
/**
 * Entry point: run the MCP server over stdio.
 *
 * stdio transport rules: stdout carries the JSON-RPC protocol and NOTHING
 * else, so all human-facing logging in this project goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[saxo-mcp] ready (env=${config.env}, trading=${config.tradingEnabled ? "ENABLED" : "disabled"}, tokens=${config.tokenFile})`
  );
  if (config.tradingEnabled) {
    console.error(
      `[saxo-mcp] WARNING: trading tools are enabled on the ${config.env.toUpperCase()} environment. ` +
        "Orders placed through this server are real for that environment. Set SAXO_TRADING=disabled to hard-block."
    );
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`[saxo-mcp] configuration error: ${err.message}`);
  } else {
    console.error(`[saxo-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
  process.exit(1);
});
