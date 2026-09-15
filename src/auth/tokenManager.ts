/**
 * TokenManager: hands out a valid access token, refreshing when needed.
 *
 * Saxo access tokens are short-lived (about 20 minutes on SIM) and refresh
 * tokens last longer (about an hour, and each refresh issues a new one). So:
 *
 *   - If the stored access token is still valid (with a safety margin), use it.
 *   - Otherwise POST a refresh. Concurrent tool calls share one in-flight
 *     refresh (`refreshing` promise) so we never race and burn a refresh token.
 *   - If the refresh token itself is expired or rejected, throw
 *     AuthRequiredError with instructions to run `npm run login` again.
 *
 * Because every refresh returns a new refresh token, the file is rewritten on
 * each refresh. Token values are never logged.
 */
import type { AppConfig } from "../config.js";
import { OAuthError, refreshTokens, type TokenResponse } from "./oauth.js";
import { TokenStore, type StoredTokens } from "./tokenStore.js";

/** Refresh this many ms before the access token actually expires. */
const ACCESS_SKEW_MS = 60_000;

export class AuthRequiredError extends Error {
  constructor(reason: string) {
    super(
      `${reason} Re-authenticate by running \`npm run login\` in the saxo-mcp directory, then retry.`
    );
    this.name = "AuthRequiredError";
  }
}

export function tokensFromResponse(
  env: StoredTokens["env"],
  res: TokenResponse,
  codeVerifier: string,
  now = Date.now()
): StoredTokens {
  return {
    env,
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    accessExpiresAt: now + res.expires_in * 1000,
    refreshExpiresAt:
      typeof res.refresh_token_expires_in === "number" ? now + res.refresh_token_expires_in * 1000 : undefined,
    codeVerifier,
    baseUri: res.base_uri ?? undefined,
  };
}

export class TokenManager {
  private cached: StoredTokens | null = null;
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  /** Returns a valid bearer token, refreshing transparently if required. */
  async getAccessToken(): Promise<string> {
    const tokens = await this.load();
    if (tokens.accessExpiresAt - ACCESS_SKEW_MS > this.now()) {
      return tokens.accessToken;
    }
    return (await this.refresh()).accessToken;
  }

  /**
   * Called by the HTTP client when Saxo answers 401 even though we thought the
   * token was valid (e.g. it was revoked server-side). One forced refresh,
   * then give up with a clear message.
   */
  async forceRefresh(): Promise<string> {
    return (await this.refresh()).accessToken;
  }

  private async load(): Promise<StoredTokens> {
    if (this.cached) return this.cached;
    const tokens = await this.store.read();
    if (!tokens) {
      throw new AuthRequiredError(`No Saxo tokens found at ${this.store.path}.`);
    }
    if (tokens.env !== this.config.env) {
      throw new AuthRequiredError(
        `Stored tokens are for the "${tokens.env}" environment but SAXO_ENV is "${this.config.env}".`
      );
    }
    this.cached = tokens;
    return tokens;
  }

  private refresh(): Promise<StoredTokens> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<StoredTokens> {
    const current = await this.load();
    if (current.refreshExpiresAt !== undefined && current.refreshExpiresAt <= this.now()) {
      throw new AuthRequiredError("The Saxo refresh token has expired.");
    }
    let res: TokenResponse;
    try {
      res = await refreshTokens(
        this.config.endpoints,
        { appKey: this.config.appKey, refreshToken: current.refreshToken, codeVerifier: current.codeVerifier },
        this.fetchImpl
      );
    } catch (err) {
      if (err instanceof OAuthError && err.status !== undefined && err.status >= 400 && err.status < 500) {
        // 400/401 from the token endpoint means the refresh token is no longer usable.
        throw new AuthRequiredError(`Saxo rejected the refresh token (HTTP ${err.status}).`);
      }
      throw err;
    }
    const next = tokensFromResponse(this.config.env, res, current.codeVerifier, this.now());
    await this.store.write(next);
    this.cached = next;
    console.error(`[saxo-mcp] access token refreshed (valid for ${res.expires_in}s)`);
    return next;
  }
}
