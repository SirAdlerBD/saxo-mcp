#!/usr/bin/env node
/**
 * `npm run whoami` : quick end-to-end check that auth works, without an MCP
 * client. Loads tokens, refreshes if needed, and prints the client + accounts.
 */
import { loadConfig, ConfigError } from "./config.js";
import { TokenManager, AuthRequiredError } from "./auth/tokenManager.js";
import { TokenStore } from "./auth/tokenStore.js";
import { SaxoClient } from "./saxo/client.js";
import { PortfolioApi } from "./saxo/portfolio.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SaxoClient(config, new TokenManager(config, new TokenStore(config.tokenFile)));
  const api = new PortfolioApi(client);
  const [info, accounts] = await Promise.all([api.clientInfo(), api.accounts()]);
  console.log(`Environment : ${config.env.toUpperCase()}`);
  console.log(`Client      : ${info.Name ?? "?"} (ClientId ${info.ClientId ?? "?"}, default currency ${info.DefaultCurrency ?? "?"})`);
  console.log(`ClientKey   : ${info.ClientKey}`);
  console.log("Accounts    :");
  for (const a of accounts.Data) {
    console.log(`  - ${a.AccountId ?? "?"}  ${a.Currency ?? ""}  ${a.AccountType ?? ""}  AccountKey=${a.AccountKey}` + (a.AccountKey === info.DefaultAccountKey ? "  (default)" : ""));
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof AuthRequiredError) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
