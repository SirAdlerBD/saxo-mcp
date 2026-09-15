import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TokenStore } from "../src/auth/tokenStore.js";
import { tmpDir, validTokens } from "./helpers.js";

test("round-trips tokens and creates the file with mode 0600", async () => {
  const file = path.join(await tmpDir(), ".saxo-tokens.json");
  const store = new TokenStore(file);
  assert.equal(await store.read(), null);

  const tokens = validTokens();
  await store.write(tokens);
  assert.deepEqual(await store.read(), tokens);

  const mode = (await fs.stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
  // no temp file left behind
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((f) => f.includes(".tmp")), []);

  await store.clear();
  assert.equal(await store.read(), null);
  await store.clear(); // idempotent
});

test("corrupt or incomplete files read as null instead of throwing", async () => {
  const dir = await tmpDir();
  const bad = new TokenStore(path.join(dir, "bad.json"));
  await fs.writeFile(bad.path, "{not json");
  assert.equal(await bad.read(), null);

  const partial = new TokenStore(path.join(dir, "partial.json"));
  await fs.writeFile(partial.path, JSON.stringify({ accessToken: "x" }));
  assert.equal(await partial.read(), null);
});
