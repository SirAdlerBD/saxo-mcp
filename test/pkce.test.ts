import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCodeChallenge, generateCodeVerifier, generatePkcePair, generateState } from "../src/auth/pkce.js";
import { buildAuthorizeUrl } from "../src/auth/oauth.js";

test("code challenge matches the RFC 7636 appendix B test vector", () => {
  // https://www.rfc-editor.org/rfc/rfc7636#appendix-B
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(computeCodeChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("code verifier is 43 unreserved characters and unique per call", () => {
  const a = generateCodeVerifier();
  const b = generateCodeVerifier();
  assert.equal(a.length, 43);
  assert.match(a, /^[A-Za-z0-9\-_]+$/);
  assert.notEqual(a, b);
});

test("pair is internally consistent", () => {
  const { codeVerifier, codeChallenge } = generatePkcePair();
  assert.equal(computeCodeChallenge(codeVerifier), codeChallenge);
  assert.notEqual(codeVerifier, codeChallenge);
});

test("authorize URL carries every PKCE parameter Saxo expects", () => {
  const url = new URL(
    buildAuthorizeUrl(
      { authBase: "https://sim.logonvalidation.net", apiBase: "x" },
      { appKey: "APP", redirectUri: "http://localhost:8765/callback", codeChallenge: "CHAL", state: generateState() }
    )
  );
  assert.equal(url.origin + url.pathname, "https://sim.logonvalidation.net/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "APP");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8765/callback");
  assert.equal(url.searchParams.get("code_challenge"), "CHAL");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok((url.searchParams.get("state") ?? "").length >= 16);
  assert.equal(url.searchParams.get("client_secret"), null);
});
