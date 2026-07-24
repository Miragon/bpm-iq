/**
 * The Live Host's /mcp surface (src/http/mcp.ts), two layers:
 *
 *  (a) TOOL behaviour — createLiveMcpServer driven over an in-memory
 *      Client↔Server pair (packages/mcp house pattern), with openDoc backed by
 *      a REAL Hocuspocus direct connection: get→save round-trip, the conflict
 *      retry loop, validate_bpmn, per-call authz, the read-only registration.
 *  (b) TRANSPORT behaviour — the /mcp branch of startApi over real HTTP:
 *      JSON responses (stateless), 405 on GET, 401 + RFC-9728 challenge
 *      without credentials, -32700 on garbage.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { Server as HocuspocusServer } from "@hocuspocus/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import { type Session, SessionStore } from "../src/adapters/sqlite/sessions.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { newBpmnXml } from "../src/domain/bpmn-template.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import { type ApiOptions, startApi } from "../src/http/api.ts";
import { createLiveMcpServer, type McpDeps } from "../src/http/mcp.ts";
import type { GitProvider } from "../src/ports/git-provider.ts";
import { loadContentConfig } from "../src/repos/content.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};
const PATH = "processes/order.bpmn";
const VALID = newBpmnXml("order", "Order");
const VALID_V2 = newBpmnXml("order", "Order v2");

const session = (login = "petra"): Session => ({
  id: `sess-${login}`,
  user: { login, name: login, avatarUrl: null, provider: "github" },
  providerToken: "",
  createdAt: Date.now(),
});

const servers: HocuspocusServer[] = [];
const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const c of cleanups) await c();
  await Promise.all(servers.map((s) => s.destroy()));
  // WATCHDOG: Hocuspocus can leave a poisoned debounce/save-mutex handle behind
  // after its async-unload race (docs: content.ts roomQueues) — a PASSED suite
  // must never hang the runner on it. unref'd: a clean exit ignores it.
  setTimeout(() => process.exit(), 2000).unref();
});

/** tmpdir content repo + real direct-connection openDoc + inline fakes for
 *  every other injected surface (the house style) */
function deps(over: Partial<McpDeps> = {}): McpDeps {
  const ws = mkdtempSync(join(tmpdir(), "bpm-mcp-"));
  mkdirSync(join(ws, "processes"), { recursive: true });
  writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
  writeFileSync(join(ws, PATH), VALID);
  const registry = { get: (n: string) => (n.toLowerCase() === REPO.fullName ? REPO : undefined), list: () => [REPO] };
  const workspaces = {
    ensure: async () => ws,
    dir: () => ws,
    changedPaths: async () => [],
    changedFiles: async () => [],
  };
  const hp = new HocuspocusServer({
    ...makeCollabHooks({
      lineage: new LineageStore(new DatabaseSync(":memory:"), REPO.fullName),
      docGuard: new DocSizeGuard(8_000_000),
      maxDocBytes: 8_000_000,
      sessions: { get: () => undefined },
      access: { canWrite: async () => true },
      registry,
      workspaces,
      contentConfig: loadContentConfig,
      devToken: () => undefined,
      liveDocs: new Set(),
    }),
  });
  servers.push(hp);
  return {
    registry,
    workspaces,
    access: { canWrite: async () => true },
    liveDocs: () => [],
    openDoc: (room) => hp.hocuspocus.openDirectConnection(room),
    maxDocBytes: 8_000_000,
    providers: new Map<string, GitProvider>(),
    github: {} as GitProvider,
    ...over,
  };
}

async function connect(d: McpDeps, s: Session = session()) {
  const server = createLiveMcpServer(d, s);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  cleanups.push(() => Promise.all([client.close(), server.close()]));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as Array<{ type: string; text?: string }>;
    return { isError: Boolean(r.isError), text: content[0]?.text ?? "" };
  };
  const callJson = async (name: string, args: Record<string, unknown> = {}) => {
    const { isError, text } = await call(name, args);
    assert.ok(!isError, `${name} unexpectedly errored: ${text}`);
    return JSON.parse(text) as Record<string, any>;
  };
  return { client, call, callJson };
}

// ── (a) tool behaviour ──────────────────────────────────────────────────────

test("registration: all nine tools; read-only mode drops exactly the write tools", async () => {
  const full = await connect(deps());
  assert.deepEqual((await full.client.listTools()).tools.map((t) => t.name).sort(), [
    "create_process",
    "get_bpmn_xml",
    "get_process",
    "list_changes",
    "list_processes",
    "list_repos",
    "release_process",
    "save_bpmn_xml",
    "validate_bpmn",
  ]);
  const ro = await connect(deps({ mcpReadOnly: true }));
  assert.deepEqual((await ro.client.listTools()).tools.map((t) => t.name).sort(), [
    "get_bpmn_xml",
    "get_process",
    "list_changes",
    "list_processes",
    "list_repos",
    "validate_bpmn",
  ]);
});

test("get→save round-trip incl. the conflict retry loop (stale token never overwrites)", async () => {
  const { callJson } = await connect(deps());
  const procs = await callJson("list_processes", { repo: REPO.fullName });
  assert.equal(procs.processes[0].id, "order");

  const got = await callJson("get_bpmn_xml", { repo: REPO.fullName, id: "order" });
  assert.equal(got.xml, VALID);

  // stale token → retryable conflict RESULT (not a protocol error)
  const stale = await callJson("save_bpmn_xml", {
    repo: REPO.fullName,
    id: "order",
    xml: VALID_V2,
    baseVersion: "bogus.token",
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.currentXml, VALID);

  // the agent retry: re-derive against currentXml, use the fresh token
  const saved = await callJson("save_bpmn_xml", {
    repo: REPO.fullName,
    id: "order",
    xml: VALID_V2,
    baseVersion: stale.baseVersion,
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.warnings, []);

  const derived = await callJson("get_process", { repo: REPO.fullName, id: "order" });
  assert.equal(derived.name, "Order v2");
  assert.equal(derived.baseVersion, saved.baseVersion);
});

test("validate_bpmn dry-runs the platform validator without writing", async () => {
  const { callJson } = await connect(deps());
  const bad = await callJson("validate_bpmn", { xml: "<not-bpmn/>" });
  assert.equal(bad.ok, false);
  assert.ok(bad.findings.some((f: { severity: string }) => f.severity === "ERROR"));
  const good = await callJson("validate_bpmn", { xml: VALID, repo: REPO.fullName, path: PATH });
  assert.equal(good.ok, true);
  // dry-run: the live content is untouched
  const got = await callJson("get_bpmn_xml", { repo: REPO.fullName, id: "order" });
  assert.equal(got.xml, VALID);
});

test("per-call authz: a session without write access is denied on every repo tool", async () => {
  const { call } = await connect(deps({ access: { canWrite: async () => false } }));
  const denied = await call("list_processes", { repo: REPO.fullName });
  assert.ok(denied.isError);
  assert.match(denied.text, /no write access to acme\/models/);
  const unknown = await call("get_bpmn_xml", { repo: "stranger/repo", id: "x" });
  assert.ok(unknown.isError);
  assert.match(unknown.text, /not a connected repository/);
});

test("release_process demands a target; save demands baseVersion by schema", async () => {
  const { call, client } = await connect(deps());
  const none = await call("release_process", { repo: REPO.fullName });
  assert.ok(none.isError);
  assert.match(none.text, /provide either/);
  // baseVersion is REQUIRED in the schema — the SDK rejects the call before the handler
  const r = await client.callTool({
    name: "save_bpmn_xml",
    arguments: { repo: REPO.fullName, id: "order", xml: VALID },
  });
  assert.ok(r.isError);
});

// ── (b) transport behaviour over real HTTP ──────────────────────────────────

function apiOpts(d: McpDeps): ApiOptions {
  return {
    webDist: mkdtempSync(join(tmpdir(), "bpm-webdist-")),
    publicUrl: "http://live.test",
    providers: d.providers,
    github: d.github,
    sessions: new SessionStore(new DatabaseSync(":memory:")),
    registry: d.registry as ApiOptions["registry"],
    workspaces: d.workspaces as ApiOptions["workspaces"],
    access: d.access as ApiOptions["access"],
    devToken: () => "demo",
    liveDocs: () => [],
    dropLineage: () => {},
    openDoc: d.openDoc,
    maxDocBytes: d.maxDocBytes,
    oidc: {
      issuer: "https://idp.example",
      verify: async () => ({ login: "petra", name: "Petra", sub: "sub-1" }),
    },
  };
}

test("/mcp over HTTP: stateless JSON, 405 on GET, 401 + RFC-9728 challenge, -32700 on garbage", async () => {
  const httpServer = startApi(0, apiOpts(deps()));
  cleanups.push(() => new Promise((r) => httpServer.close(r)));
  await new Promise<void>((r) => httpServer.once("listening", r));
  const addr = httpServer.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: "Bearer demo",
  };

  // initialize → immediate JSON response (enableJsonResponse, no SSE session)
  const init = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  assert.equal(init.status, 200);
  assert.match(init.headers.get("content-type") ?? "", /application\/json/);
  const body = (await init.json()) as { result: { serverInfo: { name: string } } };
  assert.equal(body.result.serverInfo.name, "bpmiq-live");

  const get = await fetch(`${base}/mcp`, { headers });
  assert.equal(get.status, 405);

  const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" } });
  assert.equal(anon.status, 401);
  assert.match(
    anon.headers.get("www-authenticate") ?? "",
    /resource_metadata="http:\/\/live\.test\/\.well-known\/oauth-protected-resource"/,
  );

  const garbage = await fetch(`${base}/mcp`, { method: "POST", headers, body: "{not json" });
  assert.equal(garbage.status, 400);
  const err = (await garbage.json()) as { error: { code: number } };
  assert.equal(err.error.code, -32700);
});
