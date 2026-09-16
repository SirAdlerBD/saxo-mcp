import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startHttpServer } from "../src/http-server.js";
import { TokenManager } from "../src/auth/tokenManager.js";
import { TokenStore } from "../src/auth/tokenStore.js";
import { fakeFetch, json, testConfig, tmpDir, validTokens, type RecordedRequest } from "./helpers.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const API = "api.test/sim/openapi";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collect unhandled rejections for the duration of a test. */
function trapUnhandled() {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", handler);
  return { seen, release: () => process.off("unhandledRejection", handler) };
}

test("keep-alive: timer is registered on start, fires on schedule, and drives the token refresh", async () => {
  const file = path.join(await tmpDir(), "t.json");
  // Access token already inside the 60 s refresh window -> first keep-alive must refresh.
  await new TokenStore(file).write(validTokens({ accessExpiresAt: Date.now() + 10_000 }));
  let refreshes = 0;
  const { impl, calls } = fakeFetch({
    [`GET ${API}/port/v1/users/me`]: () => json({ UserId: "u1" }),
    "POST auth.test/token": () => {
      refreshes++;
      return json({ access_token: "A2", refresh_token: "R2", expires_in: 1200, refresh_token_expires_in: 3600, token_type: "Bearer" });
    },
  });
  const logs: string[] = [];
  const running = await startHttpServer(testConfig(file), {
    port: 0,
    accessToken: TOKEN,
    fetchImpl: impl,
    keepAliveMs: 60, // fast cadence for the test
    watchTokenFile: false,
    log: (l) => logs.push(l),
  });
  try {
    assert.equal(running.keepAliveMs, 60, "keep-alive interval is registered");
    await wait(250);
    const pings = calls.filter((c) => c.url.pathname.endsWith("/port/v1/users/me"));
    assert.ok(pings.length >= 3, `expected the timer to fire repeatedly, saw ${pings.length} keep-alive calls`);
    assert.equal(refreshes, 1, "the expiring token was refreshed exactly once");
    assert.ok(pings.slice(1).every((c) => c.headers["authorization"] === "Bearer A2"), "later pings use the refreshed token");
    assert.ok(logs.some((l) => /\[keep-alive\] Saxo session OK/.test(l)));
    assert.ok(logs.every((l) => !l.includes("A2") && !l.includes("R2") && !l.includes("ACCESS-1")), "no token in logs");
  } finally {
    await running.close();
  }
  const after = calls.length;
  await wait(150);
  assert.equal(calls.length, after, "timer stops after close()");
});

test("keep-alive: an expired refresh token logs one clear re-login warning per tick and never crashes", async () => {
  const file = path.join(await tmpDir(), "t.json");
  await new TokenStore(file).write(validTokens({ accessExpiresAt: Date.now() - 1, refreshExpiresAt: Date.now() - 1 }));
  const { impl, calls } = fakeFetch({}); // no routes: any network call would 404
  const logs: string[] = [];
  const trap = trapUnhandled();
  const running = await startHttpServer(testConfig(file), {
    port: 0,
    accessToken: TOKEN,
    fetchImpl: impl,
    keepAliveMs: 40,
    watchTokenFile: false,
    log: (l) => logs.push(l),
  });
  try {
    await wait(200);
    assert.equal(await running.keepAliveOnce(), false, "keepAliveOnce resolves false, never rejects");
    const warnings = logs.filter((l) => l.startsWith("[keep-alive] WARNING"));
    assert.ok(warnings.length >= 3, "warns on every tick");
    assert.ok(warnings.every((l) => /npm run login/.test(l)), "every warning tells the user to re-login");
    assert.equal(calls.length, 0, "an expired refresh token is detected locally; no network call is made");
    // The server is still fully alive.
    const health = await fetch(`http://127.0.0.1:${running.port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await running.close();
    trap.release();
  }
  assert.deepEqual(trap.seen, [], "no unhandled rejections");
});

test("keep-alive: Saxo rejecting the refresh token is also a graceful warning, and an outage is a plain retry", async () => {
  const file = path.join(await tmpDir(), "t.json");
  await new TokenStore(file).write(validTokens({ accessExpiresAt: Date.now() - 1 }));
  let mode: "rejected" | "outage" = "rejected";
  const { impl } = fakeFetch({
    "POST auth.test/token": () => (mode === "rejected" ? json({ error: "invalid_grant" }, 400) : json({ Message: "upstream down" }, 503)),
  });
  const logs: string[] = [];
  const trap = trapUnhandled();
  const running = await startHttpServer(testConfig(file), { port: 0, accessToken: TOKEN, fetchImpl: impl, keepAliveMs: 0, watchTokenFile: false, log: (l) => logs.push(l) });
  try {
    assert.equal(await running.keepAliveOnce(), false);
    assert.match(logs.at(-1)!, /\[keep-alive\] WARNING.*npm run login/);
    mode = "outage";
    assert.equal(await running.keepAliveOnce(), false);
    assert.match(logs.at(-1)!, /\[keep-alive\] failed: .*Will retry/);
    assert.doesNotMatch(logs.at(-1)!, /npm run login/);
  } finally {
    await running.close();
    trap.release();
  }
  assert.deepEqual(trap.seen, []);
});

test("hot reload: a fresh npm run login is picked up without a restart; the manager's own writes are ignored", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, ".saxo-tokens.json");
  const store = new TokenStore(file);
  await store.write(validTokens({ accessToken: "ACCESS-OLD", refreshToken: "REFRESH-OLD" }));
  const { impl, calls } = fakeFetch({
    [`GET ${API}/port/v1/users/me`]: (r: RecordedRequest) => json({ seenAuth: r.headers["authorization"] }),
  });
  const logs: string[] = [];
  const running = await startHttpServer(testConfig(file), { port: 0, accessToken: TOKEN, fetchImpl: impl, keepAliveMs: 0, log: (l) => logs.push(l) });
  try {
    assert.equal(await running.keepAliveOnce(), true);
    assert.equal(calls.at(-1)!.headers["authorization"], "Bearer ACCESS-OLD");

    // Simulate `npm run login` replacing the file (same atomic rename the CLI uses).
    await store.write(validTokens({ accessToken: "ACCESS-NEW", refreshToken: "REFRESH-NEW" }));
    await wait(600);
    assert.ok(logs.some((l) => l.includes("[tokens] token file changed on disk")), `reload not logged; logs: ${logs.join(" | ")}`);
    assert.equal(await running.keepAliveOnce(), true);
    assert.equal(calls.at(-1)!.headers["authorization"], "Bearer ACCESS-NEW", "server now uses the new tokens");
    assert.ok(logs.every((l) => !l.includes("ACCESS-NEW") && !l.includes("REFRESH-NEW")), "no token in logs");
  } finally {
    await running.close();
  }
});

test("TokenManager.reload(): waits for an in-flight refresh and ignores its own write", async () => {
  const file = path.join(await tmpDir(), "t.json");
  const store = new TokenStore(file);
  await store.write(validTokens({ accessExpiresAt: Date.now() - 1 }));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { impl } = fakeFetch({
    "POST auth.test/token": async () => {
      await gate;
      return json({ access_token: "A2", refresh_token: "R2", expires_in: 1200, token_type: "Bearer" });
    },
  });
  const config = testConfig(file);
  const tm = new TokenManager(config, store, impl);
  const refreshing = tm.getAccessToken(); // starts a refresh that blocks on `gate`
  await wait(20);
  const reloadDuringRefresh = tm.reload(); // must not resolve until the refresh finishes
  let reloadDone = false;
  void reloadDuringRefresh.then(() => (reloadDone = true));
  await wait(20);
  assert.equal(reloadDone, false, "reload waits for the in-flight refresh");
  release();
  assert.equal(await refreshing, "A2");
  assert.equal(await reloadDuringRefresh, false, "file now holds the manager's own write: nothing to adopt");
  assert.equal(await tm.getAccessToken(), "A2");

  // Missing/corrupt file: keep current tokens rather than blanking them.
  await store.clear();
  assert.equal(await tm.reload(), false);
  assert.equal(await tm.getAccessToken(), "A2");

  // Genuinely new login: adopted.
  await store.write(validTokens({ accessToken: "A3", refreshToken: "R3" }));
  assert.equal(await tm.reload(), true);
  assert.equal(await tm.getAccessToken(), "A3");
});
