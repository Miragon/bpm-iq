/**
 * The shared REST plumbing against an in-process HTTP stub: appRest header
 * shape (incl. the PER-APP user-agent parameter — the one thing the two
 * backends must not share), mintInstallationToken's expires_at → epoch-ms
 * conversion, and paginate's Link-following + {repositories} unwrapping with
 * both auth modes (installation token vs. app JWT).
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { type AppKey, appRest, type GitHubApi, mintInstallationToken, paginate } from "../src/index.ts";
import { StubServer } from "./stub-server.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const KEY: AppKey = { appId: "4711", privateKey: PEM };

const stub = new StubServer();
before(() => stub.start());
after(() => stub.stop());
beforeEach(() => stub.reset());

const api = (userAgent = "test-agent"): GitHubApi => ({ apiUrl: stub.url, userAgent });

/** decode the payload of the `authorization: Bearer <jwt>` header */
function bearerJwtPayload(authorization: unknown): Record<string, unknown> {
  const jwt = String(authorization).replace(/^Bearer /, "");
  const parts = jwt.split(".");
  assert.equal(parts.length, 3, "expected a three-part JWT");
  const [, payload] = parts as [string, string, string];
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
}

// ── appRest ─────────────────────────────────────────────────────────────────

test("appRest: GitHub media type + Bearer app JWT + the CALLER'S user-agent", async () => {
  await appRest(KEY, api("bpm-control-plane"), "/app");
  const req = stub.last();
  assert.equal(req.method, "GET");
  assert.equal(req.url, "/app");
  assert.equal(req.headers.accept, "application/vnd.github+json");
  assert.equal(req.headers["user-agent"], "bpm-control-plane");
  assert.equal(bearerJwtPayload(req.headers.authorization).iss, "4711");
});

test("appRest: the user-agent is a parameter — a different app sends ITS agent", async () => {
  await appRest(KEY, api("bpm-live-host"), "/app");
  assert.equal(stub.last().headers["user-agent"], "bpm-live-host");
});

test("appRest: init is honored — method passes through, caller headers win", async () => {
  await appRest(KEY, api(), "/app/installations/1/access_tokens", {
    method: "POST",
    headers: { accept: "application/vnd.github.raw" },
  });
  const req = stub.last();
  assert.equal(req.method, "POST");
  assert.equal(req.headers.accept, "application/vnd.github.raw", "init headers override the defaults");
  assert.equal(req.headers["user-agent"], "test-agent", "non-overridden defaults stay");
});

// ── mintInstallationToken ───────────────────────────────────────────────────

test("mintInstallationToken: POSTs …/access_tokens, converts expires_at → epoch ms", async () => {
  stub.reply({ body: { token: "tok-1", expires_at: "2026-01-01T10:00:00Z" } });
  const minted = await mintInstallationToken(KEY, api(), 7);
  const req = stub.last();
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/app/installations/7/access_tokens");
  assert.deepEqual(minted, { token: "tok-1", expiresAt: Date.parse("2026-01-01T10:00:00Z") });
});

test("mintInstallationToken: non-ok → throws with status + body text", async () => {
  stub.reply({ status: 502, body: "upstream sad" });
  await assert.rejects(() => mintInstallationToken(KEY, api(), 9), /installation token for 9 failed: 502 upstream sad/);
});

// ── paginate ────────────────────────────────────────────────────────────────

test("paginate: follows Link rel=next, concatenates bare-array pages (token auth)", async () => {
  stub.reply(
    { body: [{ id: 1 }, { id: 2 }], headers: { link: `<${stub.url}/page-two>; rel="next"` } },
    { body: [{ id: 3 }] },
  );
  const items = await paginate(api(), "/app/installations?per_page=100", { token: "inst-token" });
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(stub.requests.length, 2);
  assert.equal(stub.requests[0]?.url, "/app/installations?per_page=100");
  assert.equal(stub.requests[1]?.url, "/page-two", "the rel=next target is followed as-is");
  assert.equal(stub.requests[0]?.headers.authorization, "Bearer inst-token");
  assert.equal(stub.requests[1]?.headers.authorization, "Bearer inst-token");
});

test("paginate: a rel=prev/last-only Link header ends the walk", async () => {
  stub.reply({ body: [1], headers: { link: `<${stub.url}/p1>; rel="prev", <${stub.url}/p9>; rel="last"` } });
  assert.deepEqual(await paginate(api(), "/things", { token: "t" }), [1]);
  assert.equal(stub.requests.length, 1);
});

test("paginate: unwraps the {repositories} envelope (/installation/repositories shape)", async () => {
  stub.reply({ body: { total_count: 1, repositories: [{ full_name: "acme/processes" }] } });
  const items = await paginate(api(), "/installation/repositories?per_page=100", { token: "t" });
  assert.deepEqual(items, [{ full_name: "acme/processes" }]);
});

test("paginate: app-JWT auth signs as the app (key mode, /app/installations)", async () => {
  stub.reply({ body: [] });
  await paginate(api("bpm-live-host"), "/app/installations?per_page=100", { key: KEY });
  const req = stub.last();
  assert.equal(bearerJwtPayload(req.headers.authorization).iss, "4711");
  assert.equal(req.headers.accept, "application/vnd.github+json");
  assert.equal(req.headers["user-agent"], "bpm-live-host");
});

test("paginate: non-ok → throws with the first path + status + body", async () => {
  stub.reply({ status: 500, body: "nope" });
  await assert.rejects(() => paginate(api(), "/things", { token: "t" }), /\/things → 500 nope/);
});
