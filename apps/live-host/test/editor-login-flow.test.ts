/**
 * Editor sign-in over real HTTP (http/api.ts + http/editor-login.ts +
 * application/login-codes.ts) on the IdP login (auth/oidc-login.ts — the one
 * browser login, ADR 0007): a login started with ?editor= lands in the editor
 * with a one-time code and NO browser session cookie; the code is worth one
 * POST /auth/exchange; the resulting session works as a bearer and can be
 * signed out by bearer. A plain browser login is unchanged.
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

/** an IdP whose authorize step is a plain redirect and whose code is always good */
const oidcLogin: NonNullable<ApiOptions["oidcLogin"]> = {
  label: "Acme SSO",
  authorizeUrl: async (redirectUri, state) =>
    `http://idp.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
  exchangeCode: async () => ({ accessToken: "stub-access-token" }),
};
/** the resource-server verifier the flow's access token lands in */
const oidc: NonNullable<ApiOptions["oidc"]> = {
  issuer: "http://idp.test",
  verify: async (token) => {
    if (token !== "stub-access-token") throw new Error("unexpected access token");
    return { login: "petra", name: "Petra Prozess", sub: "sub-petra" };
  },
};

const NONCE = "editor-nonce-0123456789";
let base = "";
const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const c of cleanups) await c();
});

const baseOpts = (): ApiOptions => ({
  webDist: mkdtempSync(join(tmpdir(), "bpm-webdist-")),
  publicUrl: "http://live.test",
  github: {} as GitProvider,
  sessions: new SessionStore(new DatabaseSync(":memory:")),
  registry: { get: () => undefined, list: () => [] } as unknown as ApiOptions["registry"],
  workspaces: {} as ApiOptions["workspaces"],
  access: { canWrite: async () => true, invalidate: () => {} },
  liveDocs: () => [],
  dropLineage: () => {},
  openDoc: () => Promise.reject(new Error("no live docs in this test")),
  maxDocBytes: 8_000_000,
  loginCodes: new LoginCodeStore(),
});
const listen = async (opts: ApiOptions): Promise<string> => {
  const httpServer = startApi(0, opts);
  cleanups.push(() => new Promise((r) => httpServer.close(r)));
  await new Promise<void>((r) => httpServer.once("listening", r));
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
};

before(async () => {
  base = await listen({ ...baseOpts(), oidcLogin, oidc });
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
const manual = (path: string, headers: Record<string, string> = {}, root = base) =>
  fetch(`${root}${path}`, { redirect: "manual", headers });
const exchange = (code: unknown) =>
  fetch(`${base}/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
const me = (token: string) => fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });

test("editor sign-in: start → callback lands in the editor with a one-time code and no session cookie", async () => {
  const start = await manual(`/auth/oidc?editor=vscode&editor_state=${NONCE}`);
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const flow = jar(start);
  assert.equal(flow.bpm_live_editor, `vscode:${NONCE}`, "the editor pair rides a browser-bound cookie");
  assert.ok(flow.bpm_live_oauth, "the state nonce cookie as always");
  assert.ok(flow.bpm_live_pkce, "the PKCE verifier cookie as always");

  const cb = await manual(`/auth/oidc/callback?code=stub-code&state=${state}`, { cookie: cookieHeader(flow) });
  assert.equal(cb.status, 200, "a page, not the browser redirect");
  assert.match(cb.headers.get("content-type") ?? "", /text\/html/);
  const page = await cb.text();
  const m = page.match(/vscode:\/\/miragon-gmbh\.bpm-live\/auth\?code=([A-Za-z0-9_-]+)&amp;state=([A-Za-z0-9_-]+)/);
  assert.ok(m, "the page carries the editor return URI");
  assert.equal(m[2], NONCE, "the editor's own nonce comes back");
  const landed = jar(cb);
  assert.equal(landed.bpm_live_sid, undefined, "NO browser session cookie for an editor login");
  assert.equal(landed.bpm_live_editor, "", "the flow cookie is cleared");
  assert.equal(landed.bpm_live_oauth, "", "the state nonce cookie is cleared");
  assert.equal(landed.bpm_live_pkce, "", "the PKCE cookie is cleared");

  const ex = await exchange(m[1]);
  assert.equal(ex.status, 200);
  const got = (await ex.json()) as Me;
  assert.equal(got.user.login, "petra");
  assert.equal(got.user.provider, "oidc");
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
    assert.equal((await manual(`/auth/oidc${q}`)).status, 400, q);
  }
  assert.equal((await exchange("no-such-code")).status, 401);
  assert.equal((await exchange(42)).status, 401);
  const broken = await fetch(`${base}/auth/exchange`, { method: "POST", body: "{" });
  assert.equal(broken.status, 400);
});

test("a plain browser login is unchanged: session cookie + redirect home", async () => {
  const start = await manual("/auth/oidc");
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const flow = jar(start);
  assert.equal(flow.bpm_live_editor, undefined, "no editor cookie on a browser login");
  const cb = await manual(`/auth/oidc/callback?code=stub-code&state=${state}`, { cookie: cookieHeader(flow) });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/");
  assert.ok(jar(cb).bpm_live_sid, "the browser gets its session cookie");
});

test("without a configured IdP the login routes are a 404, not the SPA — and there is no other login", async () => {
  const bare = await listen(baseOpts());
  for (const path of ["/auth/oidc", "/auth/oidc/callback?code=x&state=y"]) {
    const res = await manual(path, {}, bare);
    assert.equal(res.status, 404, path);
    assert.match(((await res.json()) as { error: string }).error, /not configured/);
  }
  const config = (await (await fetch(`${bare}/api/config`)).json()) as { providers: unknown[] };
  assert.deepEqual(config.providers, [], "the retired GitHub login is not offered either");
});
