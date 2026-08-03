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
// the widget stub every deps() writes — loadModeler memoises module-wide, so
// the content must be identical across tests (as it is in a real deployment)
const WIDGET_STUB = '<html><head><script>window.BPMIQ_BOOT = "__BPMIQ_BOOT__";</script></head><body>stub</body></html>';

function deps(over: Partial<McpDeps> = {}): McpDeps {
  const ws = mkdtempSync(join(tmpdir(), "bpm-mcp-"));
  mkdirSync(join(ws, "processes"), { recursive: true });
  writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
  writeFileSync(join(ws, PATH), VALID);
  const webDist = mkdtempSync(join(tmpdir(), "bpm-webdist-"));
  writeFileSync(join(webDist, "mcp-app.html"), WIDGET_STUB);
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
    webDist,
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

test("registration: all ten tools; read-only mode drops exactly the write tools", async () => {
  const full = await connect(deps());
  assert.deepEqual((await full.client.listTools()).tools.map((t) => t.name).sort(), [
    "create_process",
    "get_bpmn_xml",
    "get_process",
    "list_changes",
    "list_processes",
    "list_repos",
    "open_modeler",
    "release_process",
    "save_bpmn_xml",
    "validate_bpmn",
  ]);
  // open_modeler stays in read-only mode (opening is a read; the widget's
  // readonly marker turns it into a viewer)
  const ro = await connect(deps({ mcpReadOnly: true }));
  assert.deepEqual((await ro.client.listTools()).tools.map((t) => t.name).sort(), [
    "get_bpmn_xml",
    "get_process",
    "list_changes",
    "list_processes",
    "list_repos",
    "open_modeler",
    "validate_bpmn",
  ]);
});

test("MCP App: open_modeler carries the ui resource link; the resource serves the widget with the boot marker injected", async () => {
  const { client, callJson } = await connect(deps());

  // the tool advertises its UI template (nested + legacy flat key, per ext-apps)
  const tool = (await client.listTools()).tools.find((t) => t.name === "open_modeler");
  assert.ok(tool, "open_modeler registered");
  const meta = tool._meta as { ui?: { resourceUri?: string }; "ui/resourceUri"?: string };
  const uri = meta?.ui?.resourceUri;
  assert.ok(uri?.startsWith("ui://bpmiq/modeler-"), `ui resourceUri: ${uri}`);
  assert.equal(meta?.["ui/resourceUri"], uri);

  // the resource serves the single-file widget with the boot marker replaced
  const res = await client.readResource({ uri: uri! });
  const doc = res.contents[0] as { mimeType?: string; text?: string };
  assert.equal(doc.mimeType, "text/html;profile=mcp-app");
  assert.ok(!doc.text!.includes("__BPMIQ_BOOT__"), "marker replaced");
  assert.ok(doc.text!.includes('{\\"readonly\\":false}'), "boot config injected");

  // the tool result stays lean: a summary, never the XML
  const opened = await callJson("open_modeler", { repo: REPO.fullName, id: "order" });
  assert.equal(opened.opened.path, PATH);
  assert.ok(!JSON.stringify(opened).includes("<bpmn"), "no XML in the tool result");

  // read-only mode flips the widget's boot flag
  const ro = await connect(deps({ mcpReadOnly: true }));
  const roRes = await ro.client.readResource({ uri: uri! });
  assert.ok((roRes.contents[0] as { text?: string }).text!.includes('{\\"readonly\\":true}'));
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
  // RFC 9728 §3.3: the /mcp 401 points at the /mcp-specific PRM (path included),
  // not the root document — a resource-exact client (claude.ai) needs that.
  assert.match(
    anon.headers.get("www-authenticate") ?? "",
    /resource_metadata="http:\/\/live\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  // …and a browser client may actually READ that challenge: www-authenticate is
  // not CORS-safelisted, so without this header the pointer is invisible to it
  assert.match(anon.headers.get("access-control-expose-headers") ?? "", /www-authenticate/i);

  // that PRM exists and echoes the /mcp resource identifier verbatim
  const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(prm.status, 200);
  assert.equal(prm.headers.get("access-control-allow-origin"), "*");
  const prmDoc = (await prm.json()) as { resource: string; authorization_servers: string[] };
  assert.equal(prmDoc.resource, "http://live.test/mcp");
  assert.deepEqual(prmDoc.authorization_servers, ["https://idp.example"]);

  // browser MCP clients preflight /mcp (custom mcp-protocol-version header) — a
  // 204 with permissive origin but no credentials keeps cookies same-origin only
  const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /mcp-protocol-version/);

  const garbage = await fetch(`${base}/mcp`, { method: "POST", headers, body: "{not json" });
  assert.equal(garbage.status, 400);
  const err = (await garbage.json()) as { error: { code: number } };
  assert.equal(err.error.code, -32700);
});
