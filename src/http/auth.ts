/**
 * Bearer token authentication for the HTTP transport.
 *
 * Every request (except the unauthenticated /healthz probe) must carry
 *   Authorization: Bearer <MCP_ACCESS_TOKEN>
 * or it is answered with 401 before any MCP or Saxo code runs.
 *
 * The comparison hashes both sides with SHA-256 and uses timingSafeEqual so
 * the response time does not leak how many leading bytes matched. The token
 * value is never logged, echoed, or included in any error message.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MIN_TOKEN_LENGTH = 32;

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

  /** True when the Authorization header carries exactly the configured token. */
  verify(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader) return false;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader);
    if (!match) return false;
    const presented = createHash("sha256").update(match[1]).digest();
    return timingSafeEqual(presented, this.expectedDigest);
  }

  /**
   * Middleware-style guard. Returns true if the request may proceed; otherwise
   * writes a 401 and returns false.
   */
  guard(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.verify(req.headers.authorization)) return true;
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="saxo-mcp"',
    });
    res.end(JSON.stringify({ error: "unauthorized", message: "A valid Authorization: Bearer token is required." }));
    return false;
  }
}
