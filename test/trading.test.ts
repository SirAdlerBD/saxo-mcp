import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadConfig, ConfigError } from "../src/config.js";
import { SaxoClient, TradingDisabledError, ReadOnlyViolationError, assertTradingPath } from "../src/saxo/client.js";
import { TokenManager } from "../src/auth/tokenManager.js";
import { TokenStore } from "../src/auth/tokenStore.js";
import { fakeFetch, json, testConfig, tmpDir, validTokens, type RecordedRequest } from "./helpers.js";

const API = "api.test/sim/openapi";
const READ_TOOLS = 10;
const TRADING_TOOLS = ["precheck_order", "place_order", "modify_order", "cancel_order"];

function routes() {
  return {
    [`GET ${API}/port/v1/clients/me`]: () => json({ ClientKey: "CK", DefaultAccountKey: "AK" }),
    [`GET ${API}/port/v1/users/me`]: () => json({}),
    [`GET ${API}/port/v1/accounts/me`]: () => json({ Data: [] }),
    [`POST ${API}/trade/v2/orders/precheck`]: (r: RecordedRequest) => json({ PreCheckResult: "Ok", Echo: JSON.parse(r.body) }),
    [`POST ${API}/trade/v2/orders`]: (r: RecordedRequest) => json({ OrderId: "9001", Echo: JSON.parse(r.body) }),
    [`PATCH ${API}/trade/v2/orders`]: (r: RecordedRequest) => json({ OrderId: JSON.parse(r.body).OrderId }),
    [`DELETE ${API}/trade/v2/orders/9001`]: (r: RecordedRequest) => json({ Orders: [{ OrderId: "9001" }], AccountKey: r.url.searchParams.get("AccountKey") }),
  };
}

async function connect(tradingEnabled: boolean, fetchImpl: typeof fetch) {
  const file = path.join(await tmpDir(), "t.json");
  await new TokenStore(file).write(validTokens());
  const server = createServer(testConfig(file, tradingEnabled), fetchImpl);
  const client = new Client({ name: "t", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { client, file };
}

test("config: only the literal SAXO_TRADING=enabled turns trading on", () => {
  const base = { SAXO_APP_KEY: "k", SAXO_ENV: "sim" };
  assert.equal(loadConfig(base).tradingEnabled, false);
  assert.equal(loadConfig({ ...base, SAXO_TRADING: "disabled" }).tradingEnabled, false);
  assert.equal(loadConfig({ ...base, SAXO_TRADING: "enabled" }).tradingEnabled, true);
  assert.equal(loadConfig({ ...base, SAXO_TRADING: " Enabled " }).tradingEnabled, true);
  for (const bad of ["1", "true", "on", "yes", "enable"]) {
    assert.throws(() => loadConfig({ ...base, SAXO_TRADING: bad }), ConfigError, bad);
  }
});

test("hard block: with trading disabled, no trading tools exist and the client refuses writes outright", async () => {
  const { impl, calls } = fakeFetch(routes());
  const { client, file } = await connect(false, impl);
  const { tools } = await client.listTools();
  assert.equal(tools.length, READ_TOOLS);
  assert.ok(tools.every((t) => !TRADING_TOOLS.includes(t.name)));
  // Calling the unregistered tool fails either as a thrown error or an isError result, depending on SDK version.
  const res = await client.callTool({ name: "place_order", arguments: {} }).catch((e: Error) => e);
  if (res instanceof Error) {
    assert.match(res.message, /place_order|not found|unknown/i);
  } else {
    assert.equal(res.isError, true, "calling an unregistered trading tool must fail");
  }
  await client.close();

  // Even bypassing the tool layer entirely, the HTTP client refuses before any network I/O.
  const config = testConfig(file, false);
  const raw = new SaxoClient(config, new TokenManager(config, new TokenStore(file), impl), impl);
  await assert.rejects(raw.post("/trade/v2/orders", { Uic: 1 }), TradingDisabledError);
  await assert.rejects(raw.patch("/trade/v2/orders", { OrderId: "1" }), TradingDisabledError);
  await assert.rejects(raw.delete("/trade/v2/orders/1", { AccountKey: "AK" }), TradingDisabledError);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "no write request ever left the process");
});

test("write allow-list: even with trading enabled, only the order endpoints can be written", async () => {
  assert.doesNotThrow(() => assertTradingPath("POST", "/trade/v2/orders"));
  assert.doesNotThrow(() => assertTradingPath("POST", "/trade/v2/orders/precheck"));
  assert.doesNotThrow(() => assertTradingPath("PATCH", "/trade/v2/orders"));
  assert.doesNotThrow(() => assertTradingPath("DELETE", "/trade/v2/orders/123,456"));
  for (const [m, p] of [
    ["POST", "/trade/v1/positions/1/exercise"],
    ["POST", "/port/v1/clients/me"],
    ["PATCH", "/port/v1/accounts/AK"],
    ["DELETE", "/trade/v2/orders"],
    ["POST", "/trade/v2/orders/subscriptions"],
    ["POST", "/cs/v2/cashmanagement/transfer"],
  ] as const) {
    assert.throws(() => assertTradingPath(m, p), ReadOnlyViolationError, `${m} ${p}`);
  }
  const file = path.join(await tmpDir(), "t.json");
  await new TokenStore(file).write(validTokens());
  const { impl } = fakeFetch(routes());
  const config = testConfig(file, true);
  const raw = new SaxoClient(config, new TokenManager(config, new TokenStore(file), impl), impl);
  await assert.rejects(raw.post("/port/v1/clients/me", {}), ReadOnlyViolationError);
});

test("trading enabled: tools are registered and send the documented Saxo request shapes", async () => {
  const { impl, calls } = fakeFetch(routes());
  const { client } = await connect(true, impl);
  const { tools } = await client.listTools();
  assert.equal(tools.length, READ_TOOLS + TRADING_TOOLS.length);
  for (const name of ["place_order", "modify_order", "cancel_order"]) {
    const t = tools.find((x) => x.name === name)!;
    assert.equal(t.annotations?.readOnlyHint, false, name);
    assert.equal(t.annotations?.destructiveHint, true, name);
  }

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0].text;
    assert.equal(res.isError ?? false, false, `${name}: ${text}`);
    return JSON.parse(text);
  };

  const pre = await call("precheck_order", { buySell: "Buy", uic: 211, assetType: "Stock", amount: 10, orderType: "Limit", orderPrice: 150 });
  assert.deepEqual(pre.Echo.FieldGroups, ["Costs", "MarginImpactBuySell"]);
  assert.equal(pre.Echo.AccountKey, "AK");

  const placed = await call("place_order", {
    buySell: "Buy", uic: 211, assetType: "Stock", amount: 10, orderType: "Limit", orderPrice: 150,
    durationType: "GoodTillCancel", externalReference: "ref-1", confirm: true,
  });
  assert.equal(placed.result.OrderId, "9001");
  const post = calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/trade/v2/orders"))!;
  assert.deepEqual(JSON.parse(post.body), {
    AccountKey: "AK", Uic: 211, AssetType: "Stock", BuySell: "Buy", Amount: 10, OrderType: "Limit", OrderPrice: 150,
    OrderDuration: { DurationType: "GoodTillCancel" }, ManualOrder: true, ExternalReference: "ref-1",
  });
  assert.equal(post.headers["content-type"], "application/json; charset=utf-8");
  assert.match(post.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  assert.equal(post.headers["authorization"], "Bearer ACCESS-1");

  const mod = await call("modify_order", { orderId: "9001", uic: 211, assetType: "Stock", amount: 5, orderType: "Limit", orderPrice: 149, confirm: true });
  assert.equal(mod.result.OrderId, "9001");
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(JSON.parse(patch.body).OrderId, "9001");
  assert.equal(JSON.parse(patch.body).Amount, 5);

  const cancelled = await call("cancel_order", { orderId: "9001", confirm: true });
  assert.equal(cancelled.result.AccountKey, "AK");
  assert.equal(calls.find((c) => c.method === "DELETE")!.url.pathname, "/sim/openapi/trade/v2/orders/9001");
  await client.close();
});

test("trading enabled: confirm=true is mandatory and order shape is validated before any request", async () => {
  const { impl, calls } = fakeFetch(routes());
  const { client } = await connect(true, impl);
  const expectFail = async (name: string, args: Record<string, unknown>, re: RegExp) => {
    try {
      const res = await client.callTool({ name, arguments: args });
      assert.equal(res.isError, true, name);
      assert.match((res.content as { text: string }[])[0].text, re);
    } catch (err) {
      assert.match((err as Error).message, re);
    }
  };
  const base = { buySell: "Buy", uic: 211, assetType: "Stock", amount: 10, orderType: "Market" };
  await expectFail("place_order", base, /confirm/);
  await expectFail("place_order", { ...base, confirm: false }, /confirm/);
  await expectFail("place_order", { ...base, orderType: "Limit", confirm: true }, /orderPrice is required/);
  await expectFail("place_order", { ...base, durationType: "GoodTillDate", confirm: true }, /expirationDateTime is required/);
  await expectFail("cancel_order", { orderId: "1" }, /confirm/);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
  await client.close();
});
