/**
 * PKCE (Proof Key for Code Exchange, RFC 7636) helpers.
 *
 * Why PKCE exists
 * ---------------
 * In the classic OAuth "authorization code" flow the browser is redirected
 * back to your app with a short-lived `code`, and your app swaps that code
 * for tokens using a client secret. A native/CLI app cannot keep a secret
 * (anyone can read it out of the binary or repo), so PKCE replaces it with a
 * one-time secret that only exists in memory for the duration of one login:
 *
 *   1. Generate a random `code_verifier` (this file).
 *   2. Send SHA-256(code_verifier), base64url-encoded, as `code_challenge`
 *      in the authorize URL. Saxo stores the challenge next to the code.
 *   3. When exchanging the code, send the original `code_verifier`. Saxo
 *      hashes it and checks it matches the challenge it saw in step 2.
 *
 * Someone who intercepts the redirect (and therefore the code) cannot use it,
 * because they never saw the verifier. Saxo also requires the same verifier on
 * refresh-token requests, so we persist it alongside the tokens.
 */
import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** base64url without padding, as required by RFC 7636. */
export function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 32 random bytes -> 43 base64url characters. RFC 7636 requires 43..128
 * characters from [A-Za-z0-9-._~]; base64url output satisfies that.
 */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function computeCodeChallenge(codeVerifier: string): string {
  return base64url(createHash("sha256").update(codeVerifier, "ascii").digest());
}

export function generatePkcePair(): PkcePair {
  const codeVerifier = generateCodeVerifier();
  return { codeVerifier, codeChallenge: computeCodeChallenge(codeVerifier) };
}

/** Random, unguessable `state` value used to bind the callback to this login attempt (CSRF protection). */
export function generateState(): string {
  return base64url(randomBytes(24));
}
