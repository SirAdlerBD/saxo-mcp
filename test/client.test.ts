import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { assertReadOnlyPath, buildUrl, ReadOnlyViolationError, SaxoApiError, SaxoClient } from "../src/saxo/client.js";
import { AuthRequiredError, TokenManager } from "../src/auth/tokenManager.js";
import { TokenStore } from "../src/auth/tokenStore.js";
import { exchangeCode, refreshTokens } from "../src/auth/oauth.js";
import { fakeFetch, json, testConfig, tmpDir, validTokens } from "./helpers.js";

test("read-only guard: allows read service groups and the infoprices quote endpoint only", () => {
  for (const ok of [
    "/port/v1/clients/me",
    "/port/v1/orders",
    "/ref/v1/instruments/details/211/Stock",
    "/chart/v3/charts",
    "/hist/v4/performance/summary",
    "/cs/v1/reports/trades/abc",
    "/cs/v1/audit/orderactivities",
    "/trade/v1/infoprices",
    "/trade/v1/infoprices/list",
  ]) {
    assert.doesNotThrow(() => assertReadOnlyPath(ok), ok);
  }
  for (const blocked of [
    "/trade/v2/orders",
    "/trade/v1/orders",
    "/trade/v1/positions/exercise",
    "/trade/v1/prices",
    "/trade/v1/infoprices/subscriptions",
    "/port/v1/positions/subscriptions",
    "/cs/v1/tradingconditions",
    "/root/v1/diagnostics",
    "port/v1/clients/me",
  ]) {
    assert.throws(() => assertReadOnlyPath(blocked), ReadOnlyViolationError, blocked);
  }
});

test("buildUrl drops empty query values and encodes the rest", () => {
  const url = buildUrl("https://api.test/sim/openapi/", "/port/v1/balances", {
    ClientKey: "a/b==",
    AccountKey: undefined,
    Skip: null,
    $top: 5,
  });
  assert.equal(url, "https://api.test/sim/openapi/port/v1/balances?ClientKey=a%2Fb%3D%3D&%24top=5");
});

test("token exchange and refresh send the PKCE form Saxo expects, with no client secret", async () => {
  const { impl, calls } = fakeFetch({
    "POST auth.test/token": () => json({ access_token: "A", refresh_token: "R", expires_in: 1200, token_type: "Bearer" }),
  });
  const endpoints = { authBase: "https://auth.test", apiBase: "x" };
  await exchangeCode(endpoints, { appKey: "APP", redirectUri: "http://localhost:8765/callback", code: "CODE", codeVerifier: "VER" }, impl);
  await refreshTokens(endpoints, { appKey: "APP", refreshToken: "R0", codeVerifier: "VER" }, impl);

  const [ex, rf] = calls.map((c) => Object.fromEntries(new URLSearchParams(c.body)));
  assert.equal(calls[0].headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(ex, { grant_type: "authorization_code", client_id: "APP", code: "CODE", redirect_uri: "http://localhost:8765/callback", code_verifier: "VER" });
  assert.deepEqual(rf, { grant_type: "refresh_token", client_id: "APP", refresh_token: "R0", code_verifier: "VER" });
  assert.equal(calls[0].headers["authorization"], undefined);
});

test("TokenManager: uses a valid token, refreshes an expiring one, shares one in-flight refresh", async () => {
  const file = path.join(await tmpDir(), "t.json");
  const store = new TokenStore(file);
  await store.write(validTokens({ accessExpiresAt: Date.now() + 10_000 })); // inside the 60s skew -> refresh
  let refreshes = 0;
  const { impl } = fakeFetch({
    "POST auth.test/token": () => {
      refreshes++;
      return json({ access_token: "A2", refresh_token: "R2", expires_in: 1200, refresh_token_expires_in: 3600, token_type: "Bearer" });
    },
  });
  const tm = new TokenManager(testConfig(file), store, impl);
  const [a, b] = await Promise.all([tm.getAccessToken(), tm.getAccessToken()]);
  assert.equal(a, "A2");
  assert.equal(b, "A2");
  assert.equal(refreshes, 1);
  const persisted = await store.read();
  assert.equal(persisted?.refreshToken, "R2");
  assert.equal(persisted?.codeVerifier, "verifier-abc"); // verifier carried forward for the next refresh
  assert.equal(await tm.getAccessToken(), "A2"); // now cached and valid
  assert.equal(refreshes, 1);
});

test("TokenManager: rejected refresh becomes an AuthRequiredError that tells the user to log in", async () => {
  const file = path.join(await tmpDir(), "t.json");
  const store = new TokenStore(file);
  await store.write(validTokens({ accessExpiresAt: Date.now() - 1 }));
  const { impl } = fakeFetch({
    "POST auth.test/token": () => json({ error: "invalid_grant", access_token: "SHOULD-NOT-LEAK" }, 401),
  });
  const tm = new TokenManager(testConfig(file), store, impl);
  await assert.rejects(tm.getAccessToken(), (err: Error) => {
    assert.ok(err instanceof AuthRequiredError);
    assert.match(err.message, /npm run login/);
    assert.doesNotMatch(err.message, /SHOULD-NOT-LEAK/);
    return true;
  });
});

test("TokenManager: missing token file and environment mismatch both require login", async () => {
  const dir = await tmpDir();
  const missing = new TokenManager(testConfig(path.join(dir, "none.json")), new TokenStore(path.join(dir, "none.json")));
  await assert.rejects(missing.getAccessToken(), AuthRequiredError);

  const liveStore = new TokenStore(path.join(dir, "live.json"));
  await liveStore.write(validTokens({ env: "live" }));
  const mismatch = new TokenManager(testConfig(liveStore.path), liveStore);
  await assert.rejects(mismatch.getAccessToken(), /"live" environment/);
});

test("SaxoClient: sends bearer, retries once after 401 with a refreshed token, then gives up", async () => {
  const file = path.join(await tmpDir(), "t.json");
  const store = new TokenStore(file);
  await store.write(validTokens());
  let apiCalls = 0;
  const { impl, calls } = fakeFetch({
    "GET api.test/sim/openapi/port/v1/clients/me": (req) => {
      apiCalls++;
      return req.headers["authorization"] === "Bearer A2" ? json({ ClientKey: "CK" }) : new Response("", { status: 401 });
    },
    "POST auth.test/token": () => json({ access_token: "A2", refresh_token: "R2", expires_in: 1200, token_type: "Bearer" }),
  });
  const config = testConfig(file);
  const client = new SaxoClient(config, new TokenManager(config, store, impl), impl);
  const me = await client.get<{ ClientKey: string }>("/port/v1/clients/me");
  assert.equal(me.ClientKey, "CK");
  assert.equal(apiCalls, 2);
  assert.equal(calls[0].headers["authorization"], "Bearer ACCESS-1");
  assert.equal(calls[0].method, "GET");

  // Always-401 server: one refresh, one retry, then AuthRequiredError.
  const always401 = fakeFetch({
    "GET api.test/sim/openapi/port/v1/balances": () => new Response("", { status: 401 }),
    "POST auth.test/token": () => json({ access_token: "A3", refresh_token: "R3", expires_in: 1200, token_type: "Bearer" }),
  });
  const client2 = new SaxoClient(config, new TokenManager(config, store, always401.impl), always401.impl);
  await assert.rejects(client2.get("/port/v1/balances"), AuthRequiredError);
  assert.equal(always401.calls.filter((c) => c.method === "GET").length, 2);
});

test("SaxoClient: surfaces Saxo's error message and never issues non-GET or /trade/ requests", async () => {
  const file = path.join(await tmpDir(), "t.json");
  const store = new TokenStore(file);
  await store.write(validTokens());
  const { impl, calls } = fakeFetch({
    "GET api.test/sim/openapi/ref/v1/instruments": () => json({ Message: "Keywords is required", ErrorCode: "InvalidRequest" }, 400),
  });
  const config = testConfig(file);
  const client = new SaxoClient(config, new TokenManager(config, store, impl), impl);
  await assert.rejects(client.get("/ref/v1/instruments"), (err: SaxoApiError) => {
    assert.ok(err instanceof SaxoApiError);
    assert.equal(err.status, 400);
    assert.match(err.message, /Keywords is required/);
    return true;
  });
  await assert.rejects(client.get("/trade/v2/orders"), ReadOnlyViolationError);
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.ok(calls.every((c) => !c.url.pathname.includes("/trade/")));
});
