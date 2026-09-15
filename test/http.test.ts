import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../src/http-server.js";
import { BearerAuth } from "../src/http/auth.js";
import { TokenStore } from "../src/auth/tokenStore.js";
import { fakeFetch, json, testConfig, tmpDir, validTokens } from "./helpers.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const API = "api.test/sim/openapi";

async function boot(fetchImpl?: typeof fetch) {
  const file = path.join(await tmpDir(), "t.json");
  await new TokenStore(file).write(validTokens());
  const logs: string[] = [];
  const running = await startHttpServer(testConfig(file), {
    port: 0,
    accessToken: TOKEN,
    fetchImpl: fetchImpl ?? fakeFetch({}).impl,
    log: (l) => logs.push(l),
  });
  return { running, logs, base: `http://127.0.0.1:${running.port}` };
}

test("BearerAuth: exact match only, constant-time, and refuses weak tokens", () => {
  assert.throws(() => new BearerAuth("short"), /at least 32/);
  const auth = new BearerAuth(TOKEN);
  assert.equal(auth.verify(`Bearer ${TOKEN}`), true);
  assert.equal(auth.verify(`bearer ${TOKEN}`), true);
  assert.equal(auth.verify(`Bearer ${TOKEN}x`), false);
  assert.equal(auth.verify(`Bearer ${TOKEN.slice(0, -1)}`), false);
  assert.equal(auth.verify(`Basic ${TOKEN}`), false);
  assert.equal(auth.verify(TOKEN), false);
  assert.equal(auth.verify(undefined), false);
  assert.equal(auth.verify(""), false);
});

test("HTTP: unauthenticated requests get 401 before any MCP handling; healthz is open", async () => {
  const { running, logs, base } = await boot();
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");

    for (const headers of [{}, { Authorization: "Bearer wrong-token-wrong-token-wrong-token-wrong" }, { Authorization: `Basic ${TOKEN}` }]) {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="saxo-mcp"');
    }
    const other = await fetch(`${base}/anything`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(other.status, 404);
    assert.ok(logs.every((l) => !l.includes(TOKEN)), "token never appears in logs");
    assert.ok(logs.some((l) => l.startsWith("401 POST /mcp")));
  } finally {
    await running.close();
  }
});

test("HTTP: rejects unexpected Host headers (DNS rebinding hardening)", async () => {
  const { running } = await boot();
  try {
    // fetch() strips a custom Host header, so use node:http directly.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: running.port, path: "/mcp", method: "POST", headers: { Host: "evil.example", Authorization: `Bearer ${TOKEN}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, 421);
  } finally {
    await running.close();
  }
});

test("HTTP: full MCP session over Streamable HTTP lists and calls tools, then terminates", async () => {
  const { impl, calls } = fakeFetch({
    [`GET ${API}/port/v1/clients/me`]: () => json({ ClientKey: "CK", DefaultAccountKey: "AK" }),
    [`GET ${API}/port/v1/balances`]: () => json({ CashBalance: 42, Currency: "EUR" }),
  });
  const { running, logs, base } = await boot(impl);
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "http-test", version: "0" });
    await client.connect(transport);
    assert.ok(transport.sessionId, "server assigned a session id");

    const { tools } = await client.listTools();
    assert.equal(tools.length, 10);

    const res = await client.callTool({ name: "get_balances", arguments: {} });
    const body = JSON.parse((res.content as { text: string }[])[0].text);
    assert.equal(body.CashBalance, 42);
    assert.ok(calls.every((c) => c.headers["authorization"] === "Bearer ACCESS-1"));

    // A second client gets its own session but shares the Saxo deps (same cached ClientKey, no extra clients/me call).
    const before = calls.filter((c) => c.url.pathname.endsWith("/clients/me")).length;
    const t2 = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
    const c2 = new Client({ name: "http-test-2", version: "0" });
    await c2.connect(t2);
    assert.notEqual(t2.sessionId, transport.sessionId);
    await c2.callTool({ name: "get_balances", arguments: {} });
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("/clients/me")).length, before);
    assert.ok(logs.some((l) => l.includes("(2 active)")));

    await transport.terminateSession();
    await c2.close();
    await client.close();

    // Terminated session is gone.
    const gone = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": transport.sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    assert.equal(gone.status, 404);
  } finally {
    await running.close();
  }
});

test("HTTP: non-initialize POST without a session id is rejected with 400", async () => {
  const { running, base } = await boot();
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 400);
    const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(bad.status, 400);
  } finally {
    await running.close();
  }
});
