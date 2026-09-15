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
  console.error(`[saxo-mcp] ready (env=${config.env}, tokens=${config.tokenFile})`);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`[saxo-mcp] configuration error: ${err.message}`);
  } else {
    console.error(`[saxo-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
  process.exit(1);
});
