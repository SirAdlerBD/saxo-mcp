import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../src/http-server.js";
import { BearerAuth, stripTokenFromUrl } from "../src/http/auth.js";
import { TokenStore } from "../src/auth/tokenStore.js";
import { fakeFetch, json, testConfig, tmpDir, validTokens } from "./helpers.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WRONG = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const API = "api.test/sim/openapi";

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

async function boot() {
  const file = path.join(await tmpDir(), "t.json");
  await new TokenStore(file).write(validTokens());
  const logs: string[] = [];
  const { impl } = fakeFetch({
    [`GET ${API}/port/v1/clients/me`]: () => json({ ClientKey: "CK", DefaultAccountKey: "AK" }),
    [`GET ${API}/port/v1/balances`]: () => json({ CashBalance: 7 }),
  });
  const running = await startHttpServer(testConfig(file), { port: 0, accessToken: TOKEN, fetchImpl: impl, log: (l) => logs.push(l) });
  return { running, logs, base: `http://127.0.0.1:${running.port}` };
}

test("BearerAuth.verifyQuery / stripTokenFromUrl", () => {
  const auth = new BearerAuth(TOKEN);
  assert.equal(auth.verifyQuery(`/mcp?token=${TOKEN}`), true);
  assert.equal(auth.verifyQuery(`/mcp?foo=1&token=${TOKEN}&bar=2`), true);
  assert.equal(auth.verifyQuery(`/mcp?token=${WRONG}`), false);
  assert.equal(auth.verifyQuery(`/mcp?token=${TOKEN.slice(0, -1)}`), false);
  assert.equal(auth.verifyQuery(`/mcp?token=`), false);
  assert.equal(auth.verifyQuery(`/mcp?tok=${TOKEN}`), false);
  assert.equal(auth.verifyQuery("/mcp"), false);
  assert.equal(auth.verifyQuery(undefined), false);

  assert.equal(stripTokenFromUrl(`/mcp?token=${TOKEN}`), "/mcp");
  assert.equal(stripTokenFromUrl(`/mcp?a=1&token=${TOKEN}&b=2`), "/mcp?a=1&b=2");
  assert.equal(stripTokenFromUrl("/mcp?a=1"), "/mcp?a=1");
  assert.equal(stripTokenFromUrl("/mcp"), "/mcp");
  assert.equal(stripTokenFromUrl(undefined), undefined);
});

test("HTTP auth matrix: header-only, query-only, one-valid-one-invalid pass; both missing or wrong fail", async () => {
  const { running, logs, base } = await boot();
  const post = (url: string, authorization?: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: INIT,
    });
  try {
    // pass cases (initialize succeeds -> 200)
    assert.equal((await post(`${base}/mcp`, `Bearer ${TOKEN}`)).status, 200, "valid header only");
    assert.equal((await post(`${base}/mcp?token=${TOKEN}`)).status, 200, "valid query only");
    assert.equal((await post(`${base}/mcp?token=${WRONG}`, `Bearer ${TOKEN}`)).status, 200, "valid header, invalid query");
    assert.equal((await post(`${base}/mcp?token=${TOKEN}`, `Bearer ${WRONG}`)).status, 200, "invalid header, valid query");
    assert.equal((await post(`${base}/mcp?token=${TOKEN}`, `Bearer ${TOKEN}`)).status, 200, "both valid");

    // fail cases
    for (const [url, header, label] of [
      [`${base}/mcp`, undefined, "neither"],
      [`${base}/mcp?token=${WRONG}`, undefined, "wrong query only"],
      [`${base}/mcp`, `Bearer ${WRONG}`, "wrong header only"],
      [`${base}/mcp?token=${WRONG}`, `Bearer ${WRONG}`, "both wrong"],
      [`${base}/mcp?token=`, undefined, "empty query token"],
      [`${base}/mcp?TOKEN=${TOKEN}`, undefined, "wrong param name"],
    ] as const) {
      const res = await post(url, header);
      assert.equal(res.status, 401, label);
      assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="saxo-mcp"', label);
    }

    // healthz stays open regardless
    assert.equal((await fetch(`${base}/healthz?token=${WRONG}`)).status, 200);

    assert.ok(logs.every((l) => !l.includes(TOKEN) && !l.includes("token=")), "token and query string never logged");
  } finally {
    await running.close();
  }
});

test("HTTP: a full MCP session works with the token only in the URL", async () => {
  const { running, base } = await boot();
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp?token=${TOKEN}`));
    const client = new Client({ name: "query-auth", version: "0" });
    await client.connect(transport);
    assert.ok(transport.sessionId);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 10);
    const res = await client.callTool({ name: "get_balances", arguments: {} });
    assert.equal(JSON.parse((res.content as { text: string }[])[0].text).CashBalance, 7);
    await transport.terminateSession();
    await client.close();
  } finally {
    await running.close();
  }
});
