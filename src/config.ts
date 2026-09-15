/**
 * Configuration: loads .env and resolves the Saxo environment (SIM vs LIVE).
 *
 * Sources (Saxo developer portal, "Environments"):
 *   SIM  auth: https://sim.logonvalidation.net   API: https://gateway.saxobank.com/sim/openapi
 *   LIVE auth: https://live.logonvalidation.net  API: https://gateway.saxobank.com/openapi
 *
 * LIVE is deliberately hard to enable: SAXO_ENV=live is refused unless
 * SAXO_ALLOW_LIVE=1 is also set. During development you should never need it.
 */
import { config as loadDotenv } from "dotenv";
import path from "node:path";

// Load .env from the current working directory. `quiet` keeps dotenv from
// printing to stdout, which would corrupt the MCP stdio protocol stream.
loadDotenv({ quiet: true });

export type SaxoEnv = "sim" | "live";

export interface SaxoEndpoints {
  /** OAuth authorize + token host. */
  authBase: string;
  /** OpenAPI gateway root, including the /openapi prefix. */
  apiBase: string;
}

const ENDPOINTS: Record<SaxoEnv, SaxoEndpoints> = {
  sim: {
    authBase: "https://sim.logonvalidation.net",
    apiBase: "https://gateway.saxobank.com/sim/openapi",
  },
  live: {
    authBase: "https://live.logonvalidation.net",
    apiBase: "https://gateway.saxobank.com/openapi",
  },
};

export interface AppConfig {
  env: SaxoEnv;
  endpoints: SaxoEndpoints;
  appKey: string;
  redirectUri: string;
  tokenFile: string;
}

export class ConfigError extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      `Missing ${name}. Copy .env.example to .env and fill it in (see README).`
    );
  }
  return value;
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const get = (name: string) => overrides[name] ?? process.env[name];

  const envRaw = (get("SAXO_ENV") ?? "sim").trim().toLowerCase();
  if (envRaw !== "sim" && envRaw !== "live") {
    throw new ConfigError(`SAXO_ENV must be "sim" or "live", got "${envRaw}".`);
  }
  if (envRaw === "live" && get("SAXO_ALLOW_LIVE") !== "1") {
    throw new ConfigError(
      'SAXO_ENV=live is refused. This server is meant to be developed and tested against SIM. ' +
        "If you really intend to read a LIVE account, also set SAXO_ALLOW_LIVE=1."
    );
  }
  const env: SaxoEnv = envRaw;

  const appKey = overrides.SAXO_APP_KEY ?? requireEnv("SAXO_APP_KEY");
  const redirectUri = (get("SAXO_REDIRECT_URI") ?? "http://localhost:8765/callback").trim();

  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new ConfigError(`SAXO_REDIRECT_URI is not a valid URL: ${redirectUri}`);
  }
  if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new ConfigError(
      "SAXO_REDIRECT_URI must be a http://localhost:<port>/... URL so the local callback server can catch it."
    );
  }

  const tokenFile = path.resolve(get("SAXO_TOKEN_FILE") ?? ".saxo-tokens.json");

  return { env, endpoints: ENDPOINTS[env], appKey, redirectUri, tokenFile };
}
