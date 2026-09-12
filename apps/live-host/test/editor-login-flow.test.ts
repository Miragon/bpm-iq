/**
 * Editor sign-in over real HTTP (http/api.ts + http/editor-login.ts +
 * application/login-codes.ts): a login started with ?editor= lands in the
 * editor with a one-time code and NO browser session cookie; the code is
 * worth one POST /auth/exchange; the resulting session works as a bearer and
 * can be signed out by bearer. A plain browser login is unchanged.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import type { Me } from "@bpmiq/contracts/live-host";

import { SessionStore } from "../src/adapters/sqlite/sessions.ts";
import { LoginCodeStore } from "../src/application/login-codes.ts";
import { type ApiOptions, startApi } from "../src/http/api.ts";
import type { GitProvider } from "../src/ports/git-provider.ts";

/** a provider whose authorize step is a plain redirect and whose code is always good */
const provider = {
  id: "github",
  label: "GitHub",
  authorizeUrl: (redirectUri: string, state: string) =>
    `http://idp.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
  exchangeCode: async () => ({ accessToken: "stub-token" }),
  fetchUser: async () => ({ login: "petra", name: "Petra Prozess", avatarUrl: null, provider: "github" }),
} as unknown as GitProvider;

const NONCE = "editor-nonce-0123456789";
let base = "";
const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const c of cleanups) await c();
});

before(async () => {
  const opts: ApiOptions = {
    webDist: mkdtempSync(join(tmpdir(), "bpm-webdist-")),
    publicUrl: "http://live.test",
    providers: new Map([["github", provider]]),
    github: provider,
    sessions: new SessionStore(new DatabaseSync(":memory:")),
    registry: { get: () => undefined, list: () => [] } as unknown as ApiOptions["registry"],
    workspaces: {} as ApiOptions["workspaces"],
    access: { canWrite: async () => true } as unknown as ApiOptions["access"],
    liveDocs: () => [],
    dropLineage: () => {},
    openDoc: () => Promise.reject(new Error("no live docs in this test")),
    maxDocBytes: 8_000_000,
    loginCodes: new LoginCodeStore(),
  };
  const httpServer = startApi(0, opts);
  cleanups.push(() => new Promise((r) => httpServer.close(r)));
  await new Promise<void>((r) => httpServer.once("listening", r));
  base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
});

/** name → value of every Set-Cookie on a response ("" = cleared) */
const jar = (res: Response): Record<string, string> =>
  Object.fromEntries(
    res.headers.getSetCookie().map((c) => {
      const nv = c.split(";")[0] ?? "";
      const i = nv.indexOf("=");
      return [nv.slice(0, i), nv.slice(i + 1)];
    }),
  );
const cookieHeader = (j: Record<string, string>): string =>
  Object.entries(j)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
const manual = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { redirect: "manual", headers });
const exchange = (code: unknown) =>
  fetch(`${base}/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
const me = (token: string) => fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });

test("editor sign-in: start → callback lands in the editor with a one-time code and no session cookie", async () => {
  const start = await manual(`/auth/github?editor=vscode&editor_state=${NONCE}`);
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const flow = jar(start);
  assert.equal(flow.bpm_live_editor, `vscode:${NONCE}`, "the editor pair rides a browser-bound cookie");
  assert.ok(flow.bpm_live_oauth, "the OAuth nonce cookie as always");

  const cb = await manual(`/auth/github/callback?code=stub-code&state=${state}`, { cookie: cookieHeader(flow) });
  assert.equal(cb.status, 200, "a page, not the browser redirect");
  assert.match(cb.headers.get("content-type") ?? "", /text\/html/);
  const page = await cb.text();
  const m = page.match(/vscode:\/\/miragon-gmbh\.bpm-live\/auth\?code=([A-Za-z0-9_-]+)&amp;state=([A-Za-z0-9_-]+)/);
  assert.ok(m, "the page carries the editor return URI");
  assert.equal(m[2], NONCE, "the editor's own nonce comes back");
  const landed = jar(cb);
  assert.equal(landed.bpm_live_sid, undefined, "NO browser session cookie for an editor login");
  assert.equal(landed.bpm_live_editor, "", "the flow cookie is cleared");
  assert.equal(landed.bpm_live_oauth, "", "the OAuth nonce cookie is cleared");

  const ex = await exchange(m[1]);
  assert.equal(ex.status, 200);
  const got = (await ex.json()) as Me;
  assert.equal(got.user.login, "petra");
  assert.equal((await me(got.wsToken)).status, 200, "the wsToken is a real session (bearer)");
  assert.equal((await exchange(m[1])).status, 401, "the code is single-use");

  const out = await fetch(`${base}/api/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${got.wsToken}` },
  });
  assert.equal(out.status, 200);
  assert.equal((await me(got.wsToken)).status, 401, "signed out by bearer");
});

test("editor sign-in: malformed parameters and bad codes are refused", async () => {
  for (const q of [
    "?editor=vscode",
    `?editor_state=${NONCE}`,
    `?editor=https://evil.example&editor_state=${NONCE}`,
    "?editor=vscode&editor_state=short",
  ]) {
    assert.equal((await manual(`/auth/github${q}`)).status, 400, q);
  }
  assert.equal((await exchange("no-such-code")).status, 401);
  assert.equal((await exchange(42)).status, 401);
  const broken = await fetch(`${base}/auth/exchange`, { method: "POST", body: "{" });
  assert.equal(broken.status, 400);
});

test("a plain browser login is unchanged: session cookie + redirect home", async () => {
  const start = await manual("/auth/github");
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const flow = jar(start);
  assert.equal(flow.bpm_live_editor, undefined, "no editor cookie on a browser login");
  const cb = await manual(`/auth/github/callback?code=stub-code&state=${state}`, { cookie: cookieHeader(flow) });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/");
  assert.ok(jar(cb).bpm_live_sid, "the browser gets its session cookie");
});
