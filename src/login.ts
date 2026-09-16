#!/usr/bin/env node
/**
 * `npm run login` : interactive one-time authentication.
 *
 * The MCP server itself runs headless over stdio and cannot pop a browser, so
 * login is a separate command. It performs the full PKCE dance and writes the
 * token file; afterwards the server only ever refreshes.
 *
 * Steps:
 *   1. Generate PKCE verifier + challenge and a random `state`.
 *   2. Start a loopback HTTP server on the redirect URI's port.
 *   3. Print (and try to open) the Saxo authorize URL.
 *   4. Receive code+state on the callback, verify state.
 *   5. POST the code + verifier to /token, store the tokens (mode 0600).
 *
 * Headless VPS tip: run this on the VPS, open the printed URL on your laptop
 * while an SSH tunnel forwards the callback port:
 *     ssh -L 8765:localhost:8765 user@your-vps
 */
import { exec } from "node:child_process";
import { loadConfig, ConfigError } from "./config.js";
import { generatePkcePair, generateState } from "./auth/pkce.js";
import { buildAuthorizeUrl, exchangeCode } from "./auth/oauth.js";
import { waitForCallback } from "./auth/callbackServer.js";
import { TokenStore } from "./auth/tokenStore.js";
import { tokensFromResponse } from "./auth/tokenManager.js";

function tryOpenBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start \"\"" : "xdg-open";
  exec(`${cmd} "${url}"`, (err) => {
    if (err) console.error("(Could not open a browser automatically; paste the URL manually.)");
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new TokenStore(config.tokenFile);

  console.error(`Saxo environment : ${config.env.toUpperCase()}`);
  console.error(`Redirect URI     : ${config.redirectUri}`);
  console.error(`Token file       : ${config.tokenFile}`);

  const { codeVerifier, codeChallenge } = generatePkcePair();
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(config.endpoints, {
    appKey: config.appKey,
    redirectUri: config.redirectUri,
    codeChallenge,
    state,
  });

  // Start listening BEFORE showing the URL so the redirect can never race us.
  const callback = waitForCallback({ redirectUri: config.redirectUri, expectedState: state });

  console.error(`\nOpen this URL in a browser and log in with your Saxo ${config.env.toUpperCase()} credentials:\n`);
  console.error(`  ${authorizeUrl}\n`);
  console.error("Waiting for the redirect back to the local callback server (5 minute timeout)...");
  if (!process.env.SAXO_NO_BROWSER) tryOpenBrowser(authorizeUrl);

  const { code } = await callback;
  console.error("Received authorization code, exchanging it for tokens...");

  const tokenResponse = await exchangeCode(config.endpoints, {
    appKey: config.appKey,
    redirectUri: config.redirectUri,
    code,
    codeVerifier,
  });

  await store.write(tokensFromResponse(config.env, tokenResponse, codeVerifier));
  console.error(
    `\nLogin successful. Access token valid for ${tokenResponse.expires_in}s` +
      (tokenResponse.refresh_token_expires_in ? `, refresh token for ${tokenResponse.refresh_token_expires_in}s.` : ".")
  );
  console.error(`Tokens written to ${config.tokenFile} (mode 0600). They are never printed.`);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
  } else {
    console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});
