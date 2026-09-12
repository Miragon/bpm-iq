/**
 * LIVE_AUTH=none (ADR 0007): the local principal replaces the retired dev
 * token — every request resolves to it, whatever credential it carries, and
 * there is nothing to sign in to. Exercises the REST funnel end to end
 * (startApi with `local`); the ws join's twin lives in collab.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import type { AppConfig, Me } from "@bpmiq/contracts/live-host";

import { SessionStore } from "../src/adapters/sqlite/sessions.ts";
import { allowAllAccess, LOCAL_PROVIDER, LOCAL_SESSION_ID, makeLocalPrincipal } from "../src/auth/none.ts";
import { type ApiOptions, startApi } from "../src/http/api.ts";
import type { GitProvider } from "../src/ports/git-provider.ts";

test("makeLocalPrincipal: LIVE_LOCAL_USER wins, else the OS user — never empty", () => {
  const named = makeLocalPrincipal("  petra ");
  assert.equal(named.user.login, "petra");
  assert.equal(named.user.name, "petra");
  assert.equal(named.user.provider, LOCAL_PROVIDER);
  assert.equal(named.id, LOCAL_SESSION_ID);
  assert.equal(named.providerToken, "", "identity-only: no provider credential, ever");
  const fallback = makeLocalPrincipal(undefined);
  assert.ok(fallback.user.login.length > 0);
  assert.equal(makeLocalPrincipal("   ").user.login, fallback.user.login, "blank counts as unset");
});

test("allowAllAccess: every repo is writable, invalidate is a no-op", async () => {
  assert.equal(await allowAllAccess.canWrite(), true);
  assert.doesNotThrow(() => allowAllAccess.invalidate());
});

let base = "";
const cleanups: Array<() => Promise<unknown> | void> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

before(async () => {
  const opts: ApiOptions = {
    webDist: mkdtempSync(join(tmpdir(), "bpm-webdist-")),
    publicUrl: "http://live.test",
    providers: new Map(),
    github: {} as GitProvider,
    sessions: new SessionStore(new DatabaseSync(":memory:")),
    registry: { get: () => undefined, list: () => [] } as unknown as ApiOptions["registry"],
    workspaces: {} as ApiOptions["workspaces"],
    access: allowAllAccess,
    local: makeLocalPrincipal("petra"),
    liveDocs: () => [],
    dropLineage: () => {},
    openDoc: () => Promise.reject(new Error("not needed here")),
    maxDocBytes: 8_000_000,
  };
  const httpServer = startApi(0, opts);
  cleanups.push(() => new Promise((r) => httpServer.close(r)));
  await new Promise<void>((r) => httpServer.once("listening", r));
  base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
});

test("none mode: /api/config says so, /api/me answers without any credential", async () => {
  const config = (await (await fetch(`${base}/api/config`)).json()) as AppConfig;
  assert.equal(config.auth, "none");
  assert.deepEqual(config.providers, [], "nothing to sign in with");
  const me = await fetch(`${base}/api/me`);
  assert.equal(me.status, 200);
  const body = (await me.json()) as Me;
  assert.equal(body.user.login, "petra");
  assert.equal(body.user.provider, LOCAL_PROVIDER);
  assert.equal(body.wsToken, LOCAL_SESSION_ID);
});

test("none mode: a credential is ignored, not rejected — and the repo routes pass the gate", async () => {
  // a JWS-shaped bearer would hit the JWT branch on an authenticated host
  const bogus = await fetch(`${base}/api/me`, { headers: { authorization: "Bearer not.a.session" } });
  assert.equal(bogus.status, 200);
  assert.equal(((await bogus.json()) as Me).user.login, "petra");
  const stale = await fetch(`${base}/api/me`, { headers: { cookie: "bpm_live_sid=stale" } });
  assert.equal(stale.status, 200);
  const repos = await fetch(`${base}/api/repos`);
  assert.equal(repos.status, 200);
  assert.deepEqual(await repos.json(), []);
  const logout = await fetch(`${base}/api/logout`, { method: "POST" });
  assert.equal(logout.status, 200, "sign-out is a harmless no-op");
});
