/**
 * Bearer token authentication for the HTTP transport.
 *
 * Every request (except the unauthenticated /healthz probe) must present
 * MCP_ACCESS_TOKEN in ONE of two places, or it is answered with 401 before any
 * MCP or Saxo code runs:
 *
 *   1. Authorization: Bearer <token>        (primary)
 *   2. ?token=<token> in the query string   (for MCP clients whose connector UI
 *                                            cannot set custom headers)
 *
 * Either being valid is sufficient. Both go through the same check: SHA-256
 * both sides, then timingSafeEqual, so response time does not leak how many
 * leading bytes matched. The token value is never logged, echoed, or included
 * in any error message. The HTTP server also strips the query parameter from
 * the URL before handing the request on, so nothing downstream sees it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MIN_TOKEN_LENGTH = 32;
export const TOKEN_QUERY_PARAM = "token";

export class BearerAuth {
  private readonly expectedDigest: Buffer;

  constructor(token: string) {
    if (typeof token !== "string" || token.trim().length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `MCP_ACCESS_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. Generate one with: openssl rand -hex 32`
      );
    }
    this.expectedDigest = createHash("sha256").update(token.trim()).digest();
  }

  /** Timing-safe comparison of a raw presented token against the configured one. */
  verifyToken(presented: string | undefined | null): boolean {
    if (!presented) return false;
    const digest = createHash("sha256").update(presented).digest();
    return timingSafeEqual(digest, this.expectedDigest);
  }

  /** True when the Authorization header carries exactly the configured token. */
  verify(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader) return false;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader);
    if (!match) return false;
    return this.verifyToken(match[1]);
  }

  /** True when the request URL carries ?token=<configured token>. */
  verifyQuery(requestUrl: string | undefined): boolean {
    if (!requestUrl) return false;
    const q = requestUrl.indexOf("?");
    if (q === -1) return false;
    return this.verifyToken(new URLSearchParams(requestUrl.slice(q + 1)).get(TOKEN_QUERY_PARAM));
  }

  /**
   * Middleware-style guard. Returns true if the request may proceed (valid
   * header OR valid query token); otherwise writes a 401 and returns false.
   */
  guard(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.verify(req.headers.authorization) || this.verifyQuery(req.url)) return true;
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="saxo-mcp"',
    });
    res.end(
      JSON.stringify({
        error: "unauthorized",
        message: `A valid Authorization: Bearer token (or ?${TOKEN_QUERY_PARAM}= query parameter) is required.`,
      })
    );
    return false;
  }
}

/** Remove the token query parameter from a request URL so it never reaches logs or downstream handlers. */
export function stripTokenFromUrl(requestUrl: string | undefined): string | undefined {
  if (!requestUrl) return requestUrl;
  const q = requestUrl.indexOf("?");
  if (q === -1) return requestUrl;
  const params = new URLSearchParams(requestUrl.slice(q + 1));
  if (!params.has(TOKEN_QUERY_PARAM)) return requestUrl;
  params.delete(TOKEN_QUERY_PARAM);
  const rest = params.toString();
  return requestUrl.slice(0, q) + (rest ? `?${rest}` : "");
}
