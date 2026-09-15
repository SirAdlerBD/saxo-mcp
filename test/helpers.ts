import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import type { StoredTokens } from "../src/auth/tokenStore.js";

export async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "saxo-mcp-test-"));
}

export function testConfig(tokenFile: string): AppConfig {
  return {
    env: "sim",
    endpoints: { authBase: "https://auth.test", apiBase: "https://api.test/sim/openapi" },
    appKey: "test-app-key",
    redirectUri: "http://localhost:8765/callback",
    tokenFile,
  };
}

export function validTokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    env: "sim",
    accessToken: "ACCESS-1",
    refreshToken: "REFRESH-1",
    accessExpiresAt: Date.now() + 20 * 60_000,
    refreshExpiresAt: Date.now() + 60 * 60_000,
    codeVerifier: "verifier-abc",
    ...overrides,
  };
}

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type Route = (req: RecordedRequest) => Response | Promise<Response>;

/** Minimal fake `fetch` with a route table keyed by "METHOD host/path". */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: RecordedRequest[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const body = typeof init?.body === "string" ? init.body : "";
    const req = { url, method, headers, body };
    calls.push(req);
    const key = `${method} ${url.host}${url.pathname}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ Message: `no route for ${key}` }), { status: 404 });
    return route(req);
  };
  return { impl, calls };
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
