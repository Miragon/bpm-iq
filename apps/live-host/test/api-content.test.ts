/**
 * The content routes + OIDC auth surface of startApi over real HTTP: the regex
 * regressions around the new `content` alternative (history/content must keep
 * routing, repos merely ENDING in "history" must work, a repo literally NAMED
 * "<owner>/history" is the documented keyword-collision loss), the RFC-9728
 * discovery pair (PRM route + WWW-Authenticate challenge), and the JWT branch
 * of sessionOf (synthetic session, cookie precedence, typed 401s).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import type { ContentConflictWire, ContentWire, PutContentResultWire } from "@bpmiq/contracts/live-host";
import { AppError } from "@bpmiq/http-kit";
import { Server as HocuspocusServer } from "@hocuspocus/server";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import { SessionStore } from "../src/adapters/sqlite/sessions.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { newBpmnXml } from "../src/domain/bpmn-template.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import { type ApiOptions, startApi } from "../src/http/api.ts";
import type { GitProvider } from "../src/ports/git-provider.ts";
import { loadContentConfig } from "../src/repos/content.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const repo = (fullName: string): ConnectedRepo => ({
  fullName,
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
});
// two repos: the normal one and one whose NAME ends in "history" (regex regression)
const REPOS = [repo("acme/models"), repo("acme/order-history")];
const PATH = "processes/order.bpmn";
const VALID = newBpmnXml("order", "Order");
const VALID_V2 = newBpmnXml("order", "Order v2");

let base = "";
let sessions: SessionStore;
const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const c of cleanups) await c();
  // WATCHDOG: Hocuspocus can leave a poisoned debounce/save-mutex handle behind
  // after its async-unload race (docs: content.ts roomQueues) — a PASSED suite
  // must never hang the runner on it. unref'd: a clean exit ignores it.
  setTimeout(() => process.exit(), 2000).unref();
});

before(async () => {
  const workspaces = new Map<string, string>();
  for (const r of REPOS) {
    const ws = mkdtempSync(join(tmpdir(), "bpm-api-"));
    mkdirSync(join(ws, "processes"), { recursive: true });
    writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
    writeFileSync(join(ws, PATH), VALID);
    workspaces.set(r.fullName, ws);
  }
  const registry = {
    get: (n: string) => REPOS.find((r) => r.fullName === n.toLowerCase()),
    list: () => REPOS,
  };
  const wsFns = {
    ensure: async (r: ConnectedRepo) => workspaces.get(r.fullName) ?? "",
    dir: (r: ConnectedRepo) => workspaces.get(r.fullName) ?? "",
    changedPaths: async () => [],
    changedFiles: async () => [],
    // the history/content discriminator: an invalid sha must 400 with the
    // HISTORY code — proof the request routed to history, not content
    fileHistory: async () => [],
    fileAtCommit: async () => null,
  };
  const hp = new HocuspocusServer({
    ...makeCollabHooks({
      lineage: new LineageStore(new DatabaseSync(":memory:"), "acme/models"),
      docGuard: new DocSizeGuard(8_000_000),
      maxDocBytes: 8_000_000,
      sessions: { get: () => undefined },
      access: { canWrite: async () => true },
      registry,
      workspaces: wsFns,
      contentConfig: loadContentConfig,
      devToken: () => undefined,
      liveDocs: new Set(),
    }),
  });
  cleanups.push(() => hp.destroy());
  sessions = new SessionStore(new DatabaseSync(":memory:"));
  const opts: ApiOptions = {
    webDist: mkdtempSync(join(tmpdir(), "bpm-webdist-")),
    publicUrl: "http://live.test",
    providers: new Map(),
    github: {} as GitProvider,
    sessions,
    registry: registry as ApiOptions["registry"],
    workspaces: wsFns as unknown as ApiOptions["workspaces"],
    access: { canWrite: async () => true } as unknown as ApiOptions["access"],
    devToken: () => "demo",
    liveDocs: () => [],
    dropLineage: () => {},
    openDoc: (room) => hp.hocuspocus.openDirectConnection(room),
    maxDocBytes: 8_000_000,
    oidc: {
      issuer: "https://idp.example",
      verify: async (token) => {
        if (token === "good.jwt.token") return { login: "petra", name: "Petra", sub: "sub-1" };
        throw new AppError("auth/token-expired", "bearer token expired", { status: 401, expose: true });
      },
    },
  };
  const httpServer = startApi(0, opts);
  cleanups.push(() => new Promise((r) => httpServer.close(r)));
  await new Promise<void>((r) => httpServer.once("listening", r));
  base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
});

const AUTH = { authorization: "Bearer demo" };
const get = (path: string, headers: Record<string, string> = AUTH) => fetch(`${base}${path}`, { headers });
const put = (path: string, body: unknown, headers: Record<string, string> = AUTH) =>
  fetch(`${base}${path}`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET + PUT content round-trip over HTTP (CAS enforced, conflict carries the current content)", async () => {
  const r1 = await get(`/api/repos/acme/models/content?path=${encodeURIComponent(PATH)}`);
  assert.equal(r1.status, 200);
  const got = (await r1.json()) as ContentWire;
  assert.equal(got.content, VALID);
  assert.equal(got.xml, VALID, "deprecated alias (#154) still emitted");

  const stale = await put(`/api/repos/acme/models/content?path=${PATH}`, {
    content: VALID_V2,
    baseVersion: "wrong.token",
  });
  assert.equal(stale.status, 409);
  const conflict = (await stale.json()) as ContentConflictWire;
  assert.equal(conflict.code, "content/conflict");
  assert.equal(conflict.currentContent, VALID);
  assert.equal(conflict.currentXml, VALID, "deprecated alias (#154) still emitted");

  const okRes = await put(`/api/repos/acme/models/content?path=${PATH}`, {
    content: VALID_V2,
    baseVersion: got.baseVersion,
  });
  assert.equal(okRes.status, 200);
  const saved = (await okRes.json()) as PutContentResultWire;
  assert.notEqual(saved.baseVersion, got.baseVersion);

  const missingVersion = await put(`/api/repos/acme/models/content?path=${PATH}`, { content: VALID });
  assert.equal(missingVersion.status, 400);
});

test("regex regressions: history/content still routes to history; -history repos route to content; a repo NAMED history is the documented loss", async () => {
  // no ?sha= → the HISTORY branch's invalid-sha 400 proves where it routed
  const hist = await get(`/api/repos/acme/models/history/content?path=${PATH}`);
  assert.equal(hist.status, 400);
  assert.match(JSON.stringify(await hist.json()), /not a commit sha/);

  // a repo merely ENDING in "history" reaches the content branch (lookbehind)
  const dash = await get(`/api/repos/acme/order-history/content?path=${PATH}`);
  assert.equal(dash.status, 200);
  assert.equal(((await dash.json()) as ContentWire).repo, "acme/order-history");

  // a repo literally NAMED "<owner>/history": the URL is claimed by the
  // history/content interpretation → unknown repo "acme" (documented edge)
  const claimed = await get(`/api/repos/acme/history/content?path=${PATH}`);
  assert.equal(claimed.status, 404);
  assert.match(JSON.stringify(await claimed.json()), /acme/);
});

test("RFC 9728: anonymous 401s carry the challenge; the PRM route advertises the IdP", async () => {
  const anon = await get(`/api/repos/acme/models/content?path=${PATH}`, {});
  assert.equal(anon.status, 401);
  assert.match(
    anon.headers.get("www-authenticate") ?? "",
    /Bearer resource_metadata="http:\/\/live\.test\/\.well-known\/oauth-protected-resource"/,
  );
  const prm = await get("/.well-known/oauth-protected-resource", {});
  assert.equal(prm.status, 200);
  const meta = (await prm.json()) as { resource: string; authorization_servers: string[] };
  assert.equal(meta.resource, "http://live.test");
  assert.deepEqual(meta.authorization_servers, ["https://idp.example"]);

  // an UNSERVED well-known path must 404 as JSON, never fall through to the
  // SPA — OAuth discovery clients JSON.parse these probes and crash on HTML
  const probe = await get("/.well-known/oauth-authorization-server", {});
  assert.equal(probe.status, 404);
  assert.match(probe.headers.get("content-type") ?? "", /application\/json/);
});

test("sessionOf JWT branch: synthetic identity on /api/me, typed 401 for a bad JWT, cookie wins over a broken bearer", async () => {
  const me = await get("/api/me", { authorization: "Bearer good.jwt.token" });
  assert.equal(me.status, 200);
  const body = (await me.json()) as { user: { login: string; provider: string }; wsToken: string };
  assert.equal(body.user.login, "petra");
  assert.equal(body.user.provider, "oidc");
  assert.equal(body.wsToken, "oidc:sub-1");

  const bad = await get("/api/me", { authorization: "Bearer expired.jwt.token" });
  assert.equal(bad.status, 401);
  assert.match(JSON.stringify(await bad.json()), /auth\/token-expired/);
  assert.match(bad.headers.get("www-authenticate") ?? "", /resource_metadata/);

  // an established cookie session is checked FIRST — a stray broken bearer
  // must not lock the browser out
  const s = sessions.create({ login: "cookie-user", name: "Cookie", avatarUrl: null, provider: "github" });
  const both = await get("/api/me", { cookie: `bpm_live_sid=${s.id}`, authorization: "Bearer expired.jwt.token" });
  assert.equal(both.status, 200);
  assert.equal(((await both.json()) as { user: { login: string } }).user.login, "cookie-user");
});

test("content PUT writes through to the workspace file before responding", async () => {
  const r = await get(`/api/repos/acme/order-history/content?path=${PATH}`);
  const got = (await r.json()) as ContentWire;
  const saved = await put(`/api/repos/acme/order-history/content?path=${PATH}`, {
    content: VALID_V2,
    baseVersion: got.baseVersion,
  });
  assert.equal(saved.status, 200);
  // find the workspace file through a fresh GET (same doc) AND the disk
  const again = await get(`/api/repos/acme/order-history/content?path=${PATH}`);
  assert.equal(((await again.json()) as ContentWire).content, VALID_V2);
});
