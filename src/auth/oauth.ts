/**
 * Saxo OAuth 2.0 "Authorization Code Grant with PKCE" client.
 *
 * Endpoints (Saxo developer portal, "OAuth: Authorization Code Grant (PKCE)"):
 *   GET  {authBase}/authorize   -> the login page the user visits in a browser
 *   POST {authBase}/token       -> exchange a code, or refresh, for tokens
 *
 * Both token requests are `application/x-www-form-urlencoded` POSTs and are
 * authenticated by the app key (`client_id`) plus the PKCE verifier. No app
 * secret is involved, which is the whole point of PKCE for a CLI/desktop app.
 *
 * Saxo quirk worth knowing: the refresh request must also carry the original
 * `code_verifier`, so the verifier is stored next to the refresh token.
 */
import type { SaxoEndpoints } from "../config.js";

export interface TokenResponse {
  access_token: string;
  token_type: string;
  /** Access-token lifetime in seconds (Saxo SIM: typically 20 minutes). */
  expires_in: number;
  refresh_token: string;
  /** Refresh-token lifetime in seconds (Saxo: typically 1 hour). */
  refresh_token_expires_in?: number;
  base_uri?: string | null;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface AuthorizeUrlParams {
  appKey: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

export function buildAuthorizeUrl(endpoints: SaxoEndpoints, p: AuthorizeUrlParams): string {
  const url = new URL("/authorize", endpoints.authBase);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.appKey);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Redact anything that looks like a token before an error message can be logged. */
function safeBody(body: string): string {
  return body
    .replace(/("?(access_token|refresh_token)"?\s*[:=]\s*"?)[^",&\s]+/gi, "$1<redacted>")
    .slice(0, 400);
}

async function postToken(
  endpoints: SaxoEndpoints,
  form: Record<string, string>,
  fetchImpl: typeof fetch = fetch
): Promise<TokenResponse> {
  const res = await fetchImpl(new URL("/token", endpoints.authBase), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new OAuthError(`Saxo token endpoint returned HTTP ${res.status}: ${safeBody(text)}`, res.status, safeBody(text));
  }
  let json: TokenResponse;
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    throw new OAuthError("Saxo token endpoint returned a non-JSON body.", res.status);
  }
  if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string") {
    throw new OAuthError("Saxo token response is missing access_token or refresh_token.", res.status);
  }
  return json;
}

/** Step 3 of the flow: swap the one-time authorization code for tokens. */
export function exchangeCode(
  endpoints: SaxoEndpoints,
  p: { appKey: string; redirectUri: string; code: string; codeVerifier: string },
  fetchImpl?: typeof fetch
): Promise<TokenResponse> {
  return postToken(
    endpoints,
    {
      grant_type: "authorization_code",
      client_id: p.appKey,
      code: p.code,
      redirect_uri: p.redirectUri,
      code_verifier: p.codeVerifier,
    },
    fetchImpl
  );
}

/** Get a fresh access token (and a fresh refresh token) without user interaction. */
export function refreshTokens(
  endpoints: SaxoEndpoints,
  p: { appKey: string; refreshToken: string; codeVerifier: string },
  fetchImpl?: typeof fetch
): Promise<TokenResponse> {
  return postToken(
    endpoints,
    {
      grant_type: "refresh_token",
      client_id: p.appKey,
      refresh_token: p.refreshToken,
      code_verifier: p.codeVerifier,
    },
    fetchImpl
  );
}
