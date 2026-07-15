/**
 * The shared user-OAuth plumbing (./oauth): the authorize URL (incl. the
 * app-mode "no scope" rule), the exact token-exchange wire format (JSON body,
 * accept: application/json — GitHub defaults to form-encoded responses without
 * it), grant refresh, and /user identity normalization.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { authorizeUrl, exchangeCode, fetchUser, type OAuthApp, refreshGrant } from "../src/oauth.ts";
import { StubServer } from "./stub-server.ts";

const stub = new StubServer();
before(() => stub.start());
after(() => stub.stop());
beforeEach(() => stub.reset());

const app = (): OAuthApp => ({ clientId: "cid", clientSecret: "csec", baseUrl: stub.url });

// ── authorizeUrl (pure) ─────────────────────────────────────────────────────

test("authorizeUrl: app mode (no scope) — exact params, encoded redirect_uri", () => {
  const url = authorizeUrl(
    { clientId: "cid", clientSecret: "csec", baseUrl: "https://github.com" },
    "https://app.example/cb",
    "st4te",
  );
  assert.equal(
    url,
    "https://github.com/login/oauth/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=st4te",
  );
});

test("authorizeUrl: classic OAuth appends the requested scope LAST", () => {
  const url = authorizeUrl(
    { clientId: "cid", clientSecret: "csec", baseUrl: "https://github.com" },
    "https://app.example/cb",
    "st4te",
    { scope: "repo" },
  );
  assert.ok(url.endsWith("&scope=repo"), `scope must be the trailing param: ${url}`);
});

// ── exchangeCode ────────────────────────────────────────────────────────────

test("exchangeCode: POST /login/oauth/access_token — JSON body + accept: application/json", async () => {
  stub.reply({ body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } });
  const t0 = Date.now();
  const grant = await exchangeCode(app(), "the-code", "https://app.example/cb");
  const req = stub.last();
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/login/oauth/access_token");
  assert.equal(req.headers.accept, "application/json");
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(req.body), {
    client_id: "cid",
    client_secret: "csec",
    code: "the-code",
    redirect_uri: "https://app.example/cb",
  });
  assert.equal(grant.accessToken, "at-1");
  assert.equal(grant.refreshToken, "rt-1");
  assert.ok(
    grant.expiresAt !== undefined && grant.expiresAt >= t0 + 3_600_000 && grant.expiresAt <= Date.now() + 3_600_000,
    "expires_in (s) becomes an absolute epoch-ms expiry",
  );
});

test("exchangeCode: a non-expiring grant leaves refreshToken/expiresAt undefined", async () => {
  stub.reply({ body: { access_token: "at-2" } });
  const grant = await exchangeCode(app(), "c", "https://app.example/cb");
  assert.deepEqual(grant, { accessToken: "at-2", refreshToken: undefined, expiresAt: undefined });
});

test("exchangeCode: error_description surfaces; a 200 without access_token also fails", async () => {
  stub.reply({ status: 400, body: { error_description: "bad_verification_code" } });
  await assert.rejects(
    () => exchangeCode(app(), "c", "https://app.example/cb"),
    /GitHub token exchange failed: bad_verification_code/,
  );
  stub.reply({ body: {} }); // GitHub reports some OAuth errors with HTTP 200
  await assert.rejects(() => exchangeCode(app(), "c", "https://app.example/cb"), /GitHub token exchange failed: 200/);
});

// ── refreshGrant ────────────────────────────────────────────────────────────

test("refreshGrant: sends grant_type=refresh_token with the refresh token", async () => {
  stub.reply({ body: { access_token: "at-3", refresh_token: "rt-3", expires_in: 28800 } });
  const grant = await refreshGrant(app(), "rt-old");
  assert.deepEqual(JSON.parse(stub.last().body), {
    client_id: "cid",
    client_secret: "csec",
    grant_type: "refresh_token",
    refresh_token: "rt-old",
  });
  assert.equal(grant.accessToken, "at-3");
});

// ── fetchUser ───────────────────────────────────────────────────────────────

test("fetchUser: GET /user with the user token + caller's user-agent; normalizes", async () => {
  stub.reply({ body: { login: "petra", avatar_url: "https://avatars/petra" } });
  const user = await fetchUser({ apiUrl: stub.url, userAgent: "bpm-live-host" }, "user-tok");
  const req = stub.last();
  assert.equal(req.method, "GET");
  assert.equal(req.url, "/user");
  assert.equal(req.headers.accept, "application/vnd.github+json");
  assert.equal(req.headers.authorization, "Bearer user-tok");
  assert.equal(req.headers["user-agent"], "bpm-live-host");
  // no display name → login; provider is pinned
  assert.deepEqual(user, { login: "petra", name: "petra", avatarUrl: "https://avatars/petra", provider: "github" });
});

test("fetchUser: missing avatar → null; a set name wins over login", async () => {
  stub.reply({ body: { login: "sam", name: "Sam Doe" } });
  const user = await fetchUser({ apiUrl: stub.url, userAgent: "x" }, "t");
  assert.deepEqual(user, { login: "sam", name: "Sam Doe", avatarUrl: null, provider: "github" });
});

test("fetchUser: non-ok → throws with the status", async () => {
  stub.reply({ status: 401, body: { message: "Bad credentials" } });
  await assert.rejects(() => fetchUser({ apiUrl: stub.url, userAgent: "x" }, "t"), /GitHub \/user failed: 401/);
});
