import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForCallback } from "../src/auth/callbackServer.js";

let nextPort = 18765;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("callback server resolves with the code when state matches, then shuts down", async () => {
  const PORT = nextPort++;
  const REDIRECT = `http://localhost:${PORT}/callback`;
  const pending = waitForCallback({ redirectUri: REDIRECT, expectedState: "S1", timeoutMs: 5000 });
  await wait(50);
  const wrongPath = await fetch(`http://127.0.0.1:${PORT}/other`);
  assert.equal(wrongPath.status, 404);
  const ok = await fetch(`http://127.0.0.1:${PORT}/callback?code=THE-CODE&state=S1`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /login complete/);
  assert.deepEqual(await pending, { code: "THE-CODE", state: "S1" });
  await wait(50);
  await assert.rejects(fetch(`http://127.0.0.1:${PORT}/callback`)); // server is gone
});

test("callback server rejects a state mismatch and an OAuth error", async () => {
  const PORT = nextPort++;
  const REDIRECT = `http://localhost:${PORT}/callback`;
  // Attach the rejection assertions before triggering the callbacks: the
  // promises reject synchronously inside the request handler.
  const bad = assert.rejects(
    waitForCallback({ redirectUri: REDIRECT, expectedState: "S2", timeoutMs: 5000 }),
    /state mismatch/i
  );
  await wait(50);
  const res = await fetch(`http://127.0.0.1:${PORT}/callback?code=X&state=WRONG`);
  assert.equal(res.status, 400);
  await bad;
  await wait(50);

  const err = assert.rejects(
    waitForCallback({ redirectUri: REDIRECT, expectedState: "S3", timeoutMs: 5000 }),
    /access_denied User cancelled/
  );
  await wait(50);
  const res2 = await fetch(`http://127.0.0.1:${PORT}/callback?error=access_denied&error_description=User%20cancelled`);
  assert.equal(res2.status, 400);
  await err;
});

test("callback server times out", async () => {
  const REDIRECT = `http://localhost:${nextPort++}/callback`;
  await assert.rejects(waitForCallback({ redirectUri: REDIRECT, expectedState: "S4", timeoutMs: 100 }), /Timed out/);
});
