#!/usr/bin/env node
/**
 * Entry point: run the MCP server over Streamable HTTP.
 *
 * Same tools, same Saxo logic as the stdio entry point; only the transport
 * differs. Differences from src/index.ts:
 *   - Listens on 127.0.0.1:<HTTP_PORT> (default 3000). Loopback only: the
 *     public side is a reverse proxy (Caddy) that terminates TLS.
 *   - Requires MCP_ACCESS_TOKEN on every request before any MCP handling,
 *     as "Authorization: Bearer <token>" or as "?token=<token>" for clients
 *     that cannot set headers (src/http/auth.ts). The query parameter is
 *     stripped from the URL right after the check.
 *   - Stateful sessions: each MCP client initialize() gets its own McpServer
 *     + transport, keyed by the Mcp-Session-Id header. All sessions share ONE
 *     set of Saxo deps (token manager, HTTP client) so token refreshes never
 *     race each other.
 *   - Logs go to stdout/stderr freely (there is no protocol on stdout here).
 *   - Keep-alive: every 15 minutes (and once at startup) it makes one
 *     lightweight authenticated call to Saxo (GET /port/v1/users/me) purely
 *     to drive the token manager's refresh-before-expiry logic, so an idle
 *     night does not let the ~1 h refresh token lapse. Failures are logged as
 *     warnings and never crash the process. The stdio entry point does not do
 *     this; it is not the one running unattended.
 *   - Hot reload: the token file's directory is watched; when
 *     .saxo-tokens.json is replaced (a fresh `npm run login`), the token
 *     manager adopts it without a restart.
 *
 * Endpoints:
 *   POST   /mcp      JSON-RPC requests (initialize and everything after)
 *   GET    /mcp      server-to-client SSE stream (optional for clients)
 *   DELETE /mcp      end the session
 *   GET    /healthz  unauthenticated liveness probe, returns "ok"
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, ConfigError, type AppConfig } from "./config.js";
import { createDeps, createServerWithDeps, type SaxoDeps } from "./server.js";
import { BearerAuth, stripTokenFromUrl } from "./http/auth.js";
import { AuthRequiredError } from "./auth/tokenManager.js";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1_000_000;
/** Keep-alive cadence: inside both the ~20 min access-token and ~60 min refresh-token lifetimes. */
const DEFAULT_KEEP_ALIVE_MS = 15 * 60_000;
/** Debounce for token-file change events (rename + chmod arrive as a burst). */
const TOKEN_WATCH_DEBOUNCE_MS = 250;

export interface HttpServerOptions {
  /** Port to listen on; 0 picks a free port (tests). */
  port: number;
  accessToken: string;
  /** Idle sessions older than this are closed. Default 30 minutes. */
  sessionTtlMs?: number;
  /** Extra Host header values to accept besides localhost/127.0.0.1 (e.g. your public domain). */
  allowedHosts?: string[];
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Warning-level logger. Defaults to `log` if given, else console.warn. */
  warn?: (line: string) => void;
  /** Keep-alive interval in ms. Default 15 minutes; 0 disables (tests). */
  keepAliveMs?: number;
  /** Watch the token file and hot-reload it on change. Default true. */
  watchTokenFile?: boolean;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export interface RunningHttpServer {
  port: number;
  /** Effective keep-alive interval in ms (0 when disabled). */
  keepAliveMs: number;
  /** Run one keep-alive cycle now. Resolves true on success, false on failure; never rejects. */
  keepAliveOnce(): Promise<boolean>;
  close(): Promise<void>;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function hostAllowed(hostHeader: string | undefined, extra: string[]): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || extra.includes(host);
}

export async function startHttpServer(config: AppConfig, opts: HttpServerOptions): Promise<RunningHttpServer> {
  const auth = new BearerAuth(opts.accessToken);
  const deps: SaxoDeps = createDeps(config, opts.fetchImpl ?? fetch);
  const sessions = new Map<string, Session>();
  const ttl = opts.sessionTtlMs ?? 30 * 60_000;
  const extraHosts = (opts.allowedHosts ?? []).map((h) => h.toLowerCase());
  const log = opts.log ?? ((line: string) => console.log(`[saxo-mcp-http] ${line}`));
  const warn = opts.warn ?? opts.log ?? ((line: string) => console.warn(`[saxo-mcp-http] ${line}`));
  const keepAliveMs = opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;

  async function newSession(): Promise<Session> {
    const server = createServerWithDeps(config, deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, lastSeen: Date.now() });
        log(`session started ${id.slice(0, 8)}… (${sessions.size} active)`);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        log(`session closed ${id.slice(0, 8)}… (${sessions.size} active)`);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) log(`session ended ${id.slice(0, 8)}… (${sessions.size} active)`);
    };
    await server.connect(transport);
    return { server, transport, lastSeen: Date.now() };
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers["mcp-session-id"];
    const id = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: (err as Error).message }, id: null });
      }
      if (id) {
        const session = sessions.get(id);
        if (!session) return sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        session.lastSeen = Date.now();
        return session.transport.handleRequest(req, res, body);
      }
      if (!isInitializeRequest(body)) {
        return sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no Mcp-Session-Id header and not an initialize request" },
          id: null,
        });
      }
      const session = await newSession();
      return session.transport.handleRequest(req, res, body);
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const session = id ? sessions.get(id) : undefined;
      if (!session) return sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      session.lastSeen = Date.now();
      return session.transport.handleRequest(req, res);
    }

    res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
  }

  const httpServer = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    // Liveness probe: no auth, no data.
    if (path === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    // 1. Host check (DNS-rebinding hardening; Caddy is configured to forward the upstream host).
    if (!hostAllowed(req.headers.host, extraHosts)) {
      sendJson(res, 421, { error: "misdirected", message: "Unexpected Host header." });
      return;
    }

    // 2. Access token (header or ?token= query), before anything touches MCP or
    //    Saxo. Never log the header or the query string.
    if (!auth.guard(req, res)) {
      log(`401 ${req.method} ${path}`);
      return;
    }
    // The token has done its job; make sure no downstream code (transport,
    // error paths, future logging) ever sees it in the URL.
    req.url = stripTokenFromUrl(req.url);

    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: "not_found", message: `Use ${MCP_PATH}` });
      return;
    }

    handleMcp(req, res).catch((err: unknown) => {
      log(`error handling ${req.method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      else res.end();
    });
  });

  // ---- Keep-alive -------------------------------------------------------
  // One cheap authenticated GET per cycle. The response is discarded; the
  // point is that SaxoClient.get() -> TokenManager.getAccessToken() refreshes
  // the token when it is within 60 s of expiry, which keeps the refresh-token
  // chain alive across idle periods. Never throws.
  let keepAliveBusy = false;
  const keepAliveMinutes = Math.round(keepAliveMs / 60_000);
  async function keepAliveOnce(): Promise<boolean> {
    if (keepAliveBusy) return false; // a slow previous cycle is still running; skip this tick
    keepAliveBusy = true;
    try {
      await deps.portfolio.user(); // GET /port/v1/users/me
      log(`[keep-alive] Saxo session OK (access token valid), next check in ${keepAliveMinutes}m`);
      return true;
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        // AuthRequiredError already ends with the generic re-login sentence; keep only its reason.
        const reason = err.message.split(" Re-authenticate")[0];
        warn(
          `[keep-alive] WARNING: ${reason} ` +
            `Re-login is needed: run \`npm run login\` in the saxo-mcp directory (the server picks up the new token file automatically). ` +
            `Will check again in ${keepAliveMinutes}m.`
        );
      } else {
        warn(`[keep-alive] failed: ${err instanceof Error ? err.message : String(err)}. Will retry in ${keepAliveMinutes}m.`);
      }
      return false;
    } finally {
      keepAliveBusy = false;
    }
  }
  let keepAliveTimer: NodeJS.Timeout | undefined;
  if (keepAliveMs > 0) {
    keepAliveTimer = setInterval(() => void keepAliveOnce(), keepAliveMs);
    keepAliveTimer.unref();
  }

  // ---- Token file hot reload ---------------------------------------------
  // TokenStore.write() replaces the file via rename, which changes the inode,
  // so watch the parent directory and filter on the file name rather than
  // watching the file itself (a file watch would go stale after the first
  // replacement). Events are debounced and handed to TokenManager.reload(),
  // which ignores the manager's own writes and waits for in-flight refreshes.
  let tokenWatcher: fs.FSWatcher | undefined;
  let reloadTimer: NodeJS.Timeout | undefined;
  if (opts.watchTokenFile !== false) {
    const dir = path.dirname(config.tokenFile);
    const name = path.basename(config.tokenFile);
    try {
      tokenWatcher = fs.watch(dir, { persistent: false }, (_event, changed) => {
        if (changed !== name) return;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          reloadTimer = undefined;
          deps.tokens
            .reload()
            .then((adopted) => {
              if (adopted) log("[tokens] token file changed on disk, new tokens loaded (no restart needed)");
            })
            .catch((err: unknown) => warn(`[tokens] reload after file change failed: ${err instanceof Error ? err.message : String(err)}`));
        }, TOKEN_WATCH_DEBOUNCE_MS);
      });
      tokenWatcher.on("error", (err) => {
        warn(`[tokens] file watcher stopped: ${err.message}. A restart is needed after the next npm run login.`);
        tokenWatcher = undefined;
      });
    } catch (err) {
      warn(`[tokens] could not watch ${dir}: ${err instanceof Error ? err.message : String(err)}. A restart is needed after the next npm run login.`);
    }
  }

  const reaper = setInterval(async () => {
    const cutoff = Date.now() - ttl;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        sessions.delete(id);
        await s.transport.close().catch(() => undefined);
        log(`session ${id.slice(0, 8)}… reaped after ${Math.round(ttl / 60000)} min idle`);
      }
    }
  }, 60_000);
  reaper.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    // Loopback only. Never 0.0.0.0: TLS and the public face belong to the reverse proxy.
    httpServer.listen(opts.port, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  // First keep-alive right away so pm2 logs show the session state at startup
  // (and a needed re-login is flagged immediately, not 15 minutes later).
  if (keepAliveMs > 0) void keepAliveOnce();

  return {
    port,
    keepAliveMs,
    keepAliveOnce,
    async close() {
      clearInterval(reaper);
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (reloadTimer) clearTimeout(reloadTimer);
      tokenWatcher?.close();
      for (const [, s] of sessions) await s.transport.close().catch(() => undefined);
      sessions.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeAllConnections();
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const accessToken = process.env.MCP_ACCESS_TOKEN ?? "";
  const port = Number(process.env.HTTP_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`HTTP_PORT must be a valid port number, got "${process.env.HTTP_PORT}".`);
  }
  const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  const running = await startHttpServer(config, { port, accessToken, allowedHosts });
  console.log(
    `[saxo-mcp-http] listening on http://127.0.0.1:${running.port}${MCP_PATH} ` +
      `(env=${config.env}, trading=${config.tradingEnabled ? "ENABLED" : "disabled"}, auth=bearer, ` +
      `keep-alive=${Math.round(running.keepAliveMs / 60_000)}m, token-file watch=on)`
  );
  if (config.tradingEnabled) {
    console.error(
      `[saxo-mcp-http] WARNING: trading tools are enabled on the ${config.env.toUpperCase()} environment and reachable over HTTP.`
    );
  }

  const shutdown = async (signal: string) => {
    console.log(`[saxo-mcp-http] ${signal} received, shutting down`);
    await running.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Only run main() when executed directly, not when imported by tests.
if (process.argv[1] && /http-server\.(js|ts)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    if (err instanceof ConfigError) {
      console.error(`[saxo-mcp-http] configuration error: ${err.message}`);
    } else {
      console.error(`[saxo-mcp-http] fatal: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  });
}
