#!/usr/bin/env node
/**
 * Entry point: run the MCP server over Streamable HTTP.
 *
 * Same tools, same Saxo logic as the stdio entry point; only the transport
 * differs. Differences from src/index.ts:
 *   - Listens on 127.0.0.1:<HTTP_PORT> (default 3000). Loopback only: the
 *     public side is a reverse proxy (Caddy) that terminates TLS.
 *   - Requires "Authorization: Bearer <MCP_ACCESS_TOKEN>" on every request
 *     before any MCP handling (src/http/auth.ts).
 *   - Stateful sessions: each MCP client initialize() gets its own McpServer
 *     + transport, keyed by the Mcp-Session-Id header. All sessions share ONE
 *     set of Saxo deps (token manager, HTTP client) so token refreshes never
 *     race each other.
 *   - Logs go to stdout/stderr freely (there is no protocol on stdout here).
 *
 * Endpoints:
 *   POST   /mcp      JSON-RPC requests (initialize and everything after)
 *   GET    /mcp      server-to-client SSE stream (optional for clients)
 *   DELETE /mcp      end the session
 *   GET    /healthz  unauthenticated liveness probe, returns "ok"
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, ConfigError, type AppConfig } from "./config.js";
import { createDeps, createServerWithDeps, type SaxoDeps } from "./server.js";
import { BearerAuth } from "./http/auth.js";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1_000_000;

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
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export interface RunningHttpServer {
  port: number;
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

    // 2. Bearer token, before anything touches MCP or Saxo. Never log the header.
    if (!auth.guard(req, res)) {
      log(`401 ${req.method} ${path}`);
      return;
    }

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

  return {
    port,
    async close() {
      clearInterval(reaper);
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
      `(env=${config.env}, trading=${config.tradingEnabled ? "ENABLED" : "disabled"}, auth=bearer)`
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
