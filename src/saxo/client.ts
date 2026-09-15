/**
 * Read-only HTTP client for the Saxo OpenAPI.
 *
 * Read-only is enforced structurally, not by convention:
 *   - There is no method parameter. The only verb this client can emit is GET.
 *   - Every path is checked against READ_ONLY_PREFIXES before a request is
 *     built. Anything under /trade/ is rejected, with a single explicit
 *     exception for GET /trade/v1/infoprices, Saxo's informational quote
 *     endpoint (bid/ask/last). It cannot place, change or cancel anything; it
 *     is the only way to read a live quote over REST, which is why it is
 *     allow-listed by exact path rather than by prefix.
 *   - Streaming "subscriptions" paths are rejected too (they are POST/DELETE
 *     resources and this server has no use for them).
 *
 * Errors: a 401 triggers exactly one forced token refresh and retry. If that
 * still fails the caller receives AuthRequiredError telling the user to log in
 * again. Other HTTP errors are surfaced as SaxoApiError with Saxo's message.
 */
import type { AppConfig } from "../config.js";
import { AuthRequiredError, type TokenManager } from "../auth/tokenManager.js";

const READ_ONLY_PREFIXES = ["/port/", "/ref/", "/chart/", "/hist/", "/cs/v1/reports/", "/cs/v1/audit/", "/root/v1/sessions/"];
const READ_ONLY_EXACT = ["/trade/v1/infoprices", "/trade/v1/infoprices/list"];

export class ReadOnlyViolationError extends Error {
  constructor(path: string) {
    super(`Refusing request to "${path}": this server only calls read endpoints of the Saxo OpenAPI.`);
    this.name = "ReadOnlyViolationError";
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

export function buildUrl(apiBase: string, path: string, query: Query = {}): string {
  assertReadOnlyPath(path);
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

export class SaxoClient {
  constructor(
    private readonly config: AppConfig,
    private readonly tokens: TokenManager,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Perform a GET request and return the parsed JSON body. */
  async get<T = unknown>(path: string, query: Query = {}): Promise<T> {
    const url = buildUrl(this.config.endpoints.apiBase, path, query);
    let token = await this.tokens.getAccessToken();
    let res = await this.doGet(url, token);

    if (res.status === 401) {
      // Token rejected although we believed it valid: refresh once and retry.
      token = await this.tokens.forceRefresh();
      res = await this.doGet(url, token);
      if (res.status === 401) {
        throw new AuthRequiredError("Saxo rejected the access token (HTTP 401).");
      }
    }

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 500);
      }
    }

    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After") ?? res.headers.get("X-RateLimit-AppDay-Reset") ?? "a moment";
        throw new SaxoApiError(`Rate limited by Saxo; retry after ${retryAfter}.`, 429, path, body);
      }
      if (res.status === 403) {
        throw new SaxoApiError(
          `Forbidden (HTTP 403). The app may lack permission for this endpoint, or SIM does not expose it. Path: ${path}`,
          403,
          path,
          body
        );
      }
      throw new SaxoApiError(extractMessage(body, res.status), res.status, path, body);
    }
    return body as T;
  }

  private doGet(url: string, token: string): Promise<Response> {
    return this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  }
}
