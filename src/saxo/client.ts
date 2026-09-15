/**
 * HTTP client for the Saxo OpenAPI: read-only by default, trading only when
 * explicitly enabled.
 *
 * Reads are enforced structurally, not by convention:
 *   - `get()` has no method parameter. It can only emit GET.
 *   - Every GET path is checked against READ_ONLY_PREFIXES before a request is
 *     built. Anything under /trade/ is rejected, with a single explicit
 *     exception for GET /trade/v1/infoprices, Saxo's informational quote
 *     endpoint (bid/ask/last). It cannot place, change or cancel anything; it
 *     is the only way to read a live quote over REST, which is why it is
 *     allow-listed by exact path rather than by prefix.
 *   - Streaming "subscriptions" paths are rejected too (they are POST/DELETE
 *     resources and this server has no use for them).
 *
 * Trading (the hard block):
 *   - `post()`, `patch()` and `delete()` exist for order placement, modification
 *     and cancellation, but they throw TradingDisabledError unless the client
 *     was constructed with `tradingEnabled: true`, which only happens when the
 *     environment says SAXO_TRADING=enabled. This is checked on every call, so
 *     even if a trading tool were somehow registered, no order can leave the
 *     process while trading is disabled.
 *   - Even when enabled, write requests are restricted to the order endpoints
 *     listed in TRADING_WRITE_PATHS. Nothing else can be written.
 *
 * Errors: a 401 triggers exactly one forced token refresh and retry. If that
 * still fails the caller receives AuthRequiredError telling the user to log in
 * again. Other HTTP errors are surfaced as SaxoApiError with Saxo's message.
 */
import type { AppConfig } from "../config.js";
import { AuthRequiredError, type TokenManager } from "../auth/tokenManager.js";

const READ_ONLY_PREFIXES = ["/port/", "/ref/", "/chart/", "/hist/", "/cs/v1/reports/", "/cs/v1/audit/", "/root/v1/sessions/"];
const READ_ONLY_EXACT = ["/trade/v1/infoprices", "/trade/v1/infoprices/list"];

/** The only paths a write method may ever target, per HTTP verb. */
const TRADING_WRITE_PATHS: Record<"POST" | "PATCH" | "DELETE", RegExp> = {
  POST: /^\/trade\/v2\/orders(\/precheck)?$/,
  PATCH: /^\/trade\/v2\/orders$/,
  DELETE: /^\/trade\/v2\/orders\/[A-Za-z0-9,_-]+$/,
};

export class ReadOnlyViolationError extends Error {
  constructor(path: string) {
    super(`Refusing request to "${path}": this server only calls read endpoints of the Saxo OpenAPI.`);
    this.name = "ReadOnlyViolationError";
  }
}

export class TradingDisabledError extends Error {
  constructor() {
    super(
      "TRADING IS DISABLED on this server (hard block). No order can be placed, modified or cancelled. " +
        "To enable it deliberately, set SAXO_TRADING=enabled in .env and restart the server."
    );
    this.name = "TradingDisabledError";
  }
}

export class SaxoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "SaxoApiError";
  }
}

export type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

export function assertReadOnlyPath(path: string): void {
  if (!path.startsWith("/")) throw new ReadOnlyViolationError(path);
  const clean = path.split("?")[0].replace(/\/+$/, "");
  if (/subscriptions/i.test(clean)) throw new ReadOnlyViolationError(path);
  if (READ_ONLY_EXACT.includes(clean)) return;
  if (clean.startsWith("/trade/")) throw new ReadOnlyViolationError(path);
  if (READ_ONLY_PREFIXES.some((prefix) => clean.startsWith(prefix))) return;
  throw new ReadOnlyViolationError(path);
}

export function assertTradingPath(method: "POST" | "PATCH" | "DELETE", path: string): void {
  const clean = path.split("?")[0].replace(/\/+$/, "");
  if (!TRADING_WRITE_PATHS[method].test(clean)) {
    throw new ReadOnlyViolationError(`${method} ${path}`);
  }
}

export function buildUrl(apiBase: string, path: string, query: Query = {}, skipReadGuard = false): string {
  if (!skipReadGuard) assertReadOnlyPath(path);
  const url = new URL(apiBase.replace(/\/$/, "") + path);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function extractMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const msg = b.Message ?? b.message ?? b.ErrorCode ?? b.error;
    if (typeof msg === "string") return `${msg} (HTTP ${status})`;
  }
  return `Saxo OpenAPI returned HTTP ${status}`;
}

export interface WriteOptions {
  /** Sent as X-Request-ID so Saxo can de-duplicate an accidental double submit. */
  requestId?: string;
}

export class SaxoClient {
  readonly tradingEnabled: boolean;

  constructor(
    private readonly config: AppConfig,
    private readonly tokens: TokenManager,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.tradingEnabled = config.tradingEnabled === true;
  }

  /** Perform a GET request and return the parsed JSON body. */
  async get<T = unknown>(path: string, query: Query = {}): Promise<T> {
    const url = buildUrl(this.config.endpoints.apiBase, path, query);
    return this.request<T>("GET", url, path);
  }

  /** Place an order (or precheck one). Throws TradingDisabledError unless trading is enabled. */
  post<T = unknown>(path: string, body: unknown, opts: WriteOptions = {}): Promise<T> {
    return this.write<T>("POST", path, {}, body, opts);
  }

  /** Modify an order. Throws TradingDisabledError unless trading is enabled. */
  patch<T = unknown>(path: string, body: unknown, opts: WriteOptions = {}): Promise<T> {
    return this.write<T>("PATCH", path, {}, body, opts);
  }

  /** Cancel an order. Throws TradingDisabledError unless trading is enabled. */
  delete<T = unknown>(path: string, query: Query = {}, opts: WriteOptions = {}): Promise<T> {
    return this.write<T>("DELETE", path, query, undefined, opts);
  }

  // async so guard failures surface as rejections, the same channel as HTTP errors.
  private async write<T>(method: "POST" | "PATCH" | "DELETE", path: string, query: Query, body: unknown, opts: WriteOptions): Promise<T> {
    // The hard block. Checked on every write, independent of tool registration.
    if (!this.tradingEnabled) throw new TradingDisabledError();
    assertTradingPath(method, path);
    const url = buildUrl(this.config.endpoints.apiBase, path, query, true);
    return this.request<T>(method, url, path, body, opts.requestId);
  }

  private async request<T>(method: string, url: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    let token = await this.tokens.getAccessToken();
    let res = await this.send(method, url, token, body, requestId);

    if (res.status === 401) {
      // Token rejected although we believed it valid: refresh once and retry.
      token = await this.tokens.forceRefresh();
      res = await this.send(method, url, token, body, requestId);
      if (res.status === 401) {
        throw new AuthRequiredError("Saxo rejected the access token (HTTP 401).");
      }
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text.slice(0, 500);
      }
    }

    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After") ?? res.headers.get("X-RateLimit-AppDay-Reset") ?? "a moment";
        throw new SaxoApiError(`Rate limited by Saxo; retry after ${retryAfter}.`, 429, path, parsed);
      }
      if (res.status === 403) {
        throw new SaxoApiError(
          `Forbidden (HTTP 403). The app may lack permission for this endpoint, or SIM does not expose it. Path: ${path}`,
          403,
          path,
          parsed
        );
      }
      throw new SaxoApiError(extractMessage(parsed, res.status), res.status, path, parsed);
    }
    return parsed as T;
  }

  private send(method: string, url: string, token: string, body?: unknown, requestId?: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    if (requestId) headers["X-Request-ID"] = requestId;
    return this.fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
