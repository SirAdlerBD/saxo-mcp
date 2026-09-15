import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { TokenStore } from "../src/auth/tokenStore.js";
import { fakeFetch, json, testConfig, tmpDir, validTokens, type RecordedRequest } from "./helpers.js";

const EXPECTED_TOOLS = [
  "get_account_summary",
  "get_balances",
  "get_positions",
  "get_orders",
  "get_account_history",
  "get_transactions",
  "search_instruments",
  "get_instrument_details",
  "get_instrument_price",
  "get_chart_data",
];

async function connect(fetchImpl: typeof fetch, tokenFile: string) {
  const server = createServer(testConfig(tokenFile), fetchImpl);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

const API = "api.test/sim/openapi";

function saxoRoutes() {
  return {
    [`GET ${API}/port/v1/users/me`]: () => json({ UserId: "u1", ClientKey: "CK" }),
    [`GET ${API}/port/v1/clients/me`]: () => json({ ClientKey: "CK", DefaultAccountKey: "AK", Name: "Test" }),
    [`GET ${API}/port/v1/accounts/me`]: () => json({ Data: [{ AccountKey: "AK", AccountId: "1", Currency: "EUR" }] }),
    [`GET ${API}/port/v1/balances`]: (r: RecordedRequest) =>
      json({ CashBalance: 1000, Currency: "EUR", ClientKey: r.url.searchParams.get("ClientKey"), AccountKey: r.url.searchParams.get("AccountKey") }),
    [`GET ${API}/port/v1/positions`]: (r: RecordedRequest) =>
      json({ Data: [{ PositionId: "p1", FieldGroups: r.url.searchParams.get("FieldGroups") }] }),
    [`GET ${API}/port/v1/netpositions`]: () => json({ Data: [{ NetPositionId: "n1" }] }),
    [`GET ${API}/port/v1/orders`]: (r: RecordedRequest) => json({ Data: [{ OrderId: "o1", Status: r.url.searchParams.get("Status") }] }),
    [`GET ${API}/hist/v4/performance/summary`]: (r: RecordedRequest) => json({ Period: r.url.searchParams.get("StandardPeriod") }),
    [`GET ${API}/hist/v4/performance/timeseries`]: (r: RecordedRequest) =>
      json({ From: r.url.searchParams.get("FromDate"), To: r.url.searchParams.get("ToDate") }),
    [`GET ${API}/cs/v1/reports/trades/CK`]: () => json({ Data: [{ TradeId: "t1" }] }),
    [`GET ${API}/cs/v1/reports/bookings/CK`]: () => json({ Data: [{ BookingId: "b1" }] }),
    [`GET ${API}/cs/v1/audit/orderactivities`]: () => json({ Data: [] }),
    [`GET ${API}/ref/v1/instruments`]: (r: RecordedRequest) =>
      json({ Data: [{ Identifier: 211, AssetType: "Stock", Symbol: "AAPL:xnas", Keywords: r.url.searchParams.get("Keywords"), AccountKey: r.url.searchParams.get("AccountKey") }] }),
    [`GET ${API}/ref/v1/instruments/details/211/Stock`]: () => json({ Uic: 211, Description: "Apple Inc.", TickSize: 0.01 }),
    [`GET ${API}/ref/v1/instruments/tradingschedule/211/Stock`]: () => json({ Sessions: [] }),
    [`GET ${API}/trade/v1/infoprices`]: (r: RecordedRequest) => json({ Uic: Number(r.url.searchParams.get("Uic")), Quote: { Bid: 1, Ask: 2 } }),
    [`GET ${API}/chart/v3/charts`]: (r: RecordedRequest) =>
      json({ Data: [{ Time: "2024-01-01T00:00:00Z", Close: 1 }], ChartInfo: { Horizon: Number(r.url.searchParams.get("Horizon")) } }),
  };
}

test("server exposes exactly the ten read-only tools, all flagged readOnlyHint", async () => {
  const file = path.join(await tmpDir(), "t.json");
  const { client } = await connect(fakeFetch({}).impl, file);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.equal(t.annotations?.destructiveHint, false, t.name);
  }
  await client.close();
});

test("every tool works end to end against a fake Saxo and only ever uses GET", async () => {
  const file = path.join(await tmpDir(), "t.json");
  await new TokenStore(file).write(validTokens());
  const { impl, calls } = fakeFetch(saxoRoutes());
  const { client } = await connect(impl, file);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0].text;
    assert.equal(res.isError ?? false, false, `${name}: ${text}`);
    return JSON.parse(text);
  };

  const summary = await call("get_account_summary");
  assert.equal(summary.client.ClientKey, "CK");
  assert.equal(summary.accounts[0].AccountKey, "AK");

  const bal = await call("get_balances");
  assert.equal(bal.ClientKey, "CK");
  assert.equal(bal.AccountKey, "AK");
  const balAll = await call("get_balances", { wholeClient: true });
  assert.equal(balAll.AccountKey, null);

  const pos = await call("get_positions");
  assert.equal(pos.positions[0].FieldGroups, "PositionBase,PositionView,DisplayAndFormat,ExchangeInfo");
  assert.equal((await call("get_positions", { view: "net" })).positions[0].NetPositionId, "n1");

  const orders = await call("get_orders");
  assert.equal(orders.orders[0].Status, "All");

  assert.equal((await call("get_account_history")).Period, "Month");
  assert.equal((await call("get_account_history", { standardPeriod: "Year" })).Period, "Year");
  const ts = await call("get_account_history", { report: "timeseries", fromDate: "2024-01-01", toDate: "2024-02-01" });
  assert.equal(ts.From, "2024-01-01");

  assert.equal((await call("get_transactions")).data[0].TradeId, "t1");
  assert.equal((await call("get_transactions", { type: "bookings" })).data[0].BookingId, "b1");
  assert.equal((await call("get_transactions", { type: "order_activities" })).count, 0);

  const search = await call("search_instruments", { keywords: "apple" });
  assert.equal(search.instruments[0].Identifier, 211);
  assert.equal(search.instruments[0].AccountKey, "AK");

  const details = await call("get_instrument_details", { uic: 211, assetType: "Stock" });
  assert.equal(details.Description, "Apple Inc.");
  assert.deepEqual(details.TradingSchedule, { Sessions: [] });

  const price = await call("get_instrument_price", { uic: 211, assetType: "Stock" });
  assert.equal(price.Quote.Bid, 1);

  const chart = await call("get_chart_data", { uic: 211, assetType: "Stock", horizon: 1440, count: 10 });
  assert.equal(chart.chartInfo.Horizon, 1440);
  assert.equal(chart.count, 1);

  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.method === "GET"), "only GET requests were made");
  assert.ok(calls.every((c) => !/\/trade\//.test(c.url.pathname) || c.url.pathname.endsWith("/trade/v1/infoprices")));
  assert.ok(calls.every((c) => c.headers["authorization"] === "Bearer ACCESS-1"));
  await client.close();
});

test("invalid arguments and auth problems come back as tool errors, not crashes", async () => {
  const file = path.join(await tmpDir(), "t.json"); // no token file -> auth required
  const { client } = await connect(fakeFetch(saxoRoutes()).impl, file);

  const auth = await client.callTool({ name: "get_balances", arguments: {} });
  assert.equal(auth.isError, true);
  assert.match((auth.content as { text: string }[])[0].text, /AUTHENTICATION REQUIRED.*npm run login/);

  // Argument validation failures are reported as tool errors (or a thrown error on older SDKs); both are acceptable.
  const expectInvalid = async (name: string, args: Record<string, unknown>, re: RegExp) => {
    try {
      const res = await client.callTool({ name, arguments: args });
      assert.equal(res.isError, true, name);
      assert.match((res.content as { text: string }[])[0].text, re);
    } catch (err) {
      assert.match((err as Error).message, re);
    }
  };
  await expectInvalid("get_chart_data", { uic: 1, assetType: "Stock", horizon: 7 }, /horizon/);
  await expectInvalid("get_transactions", { fromDate: "01/02/2024" }, /YYYY-MM-DD/);
  await client.close();
});
