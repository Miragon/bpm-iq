/**
 * The Live Host's /mcp surface (src/http/mcp.ts), two layers:
 *
 *  (a) TOOL behaviour — createLiveMcpServer driven over an in-memory
 *      Client↔Server pair (packages/mcp house pattern), with openDoc backed by
 *      a REAL Hocuspocus direct connection: get→save round-trip, the conflict
 *      retry loop, validate_bpmn, the todo tools against a fake IssueTracker,
 *      per-call authz, the read-only registration.
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

import { toolText } from "@bpmiq/mcp-kit/testing";
import { Server as HocuspocusServer } from "@hocuspocus/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import { type Session, SessionStore } from "../src/adapters/sqlite/sessions.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { WsTicketStore } from "../src/application/ws-tickets.ts";
import { newBpmnXml } from "../src/domain/bpmn-template.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import { type ApiOptions, startApi } from "../src/http/api.ts";
import { createLiveMcpServer, type LiveToolContribution, type McpDeps } from "../src/http/mcp.ts";
import type { GitProvider } from "../src/ports/git-provider.ts";
import type { IssueTracker, Todo, TodoInput } from "../src/ports/issue-tracker.ts";
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

/** the decision fixture — a real table (rules, hit policy, DMNDI), because the
 *  blank template has no rules to derive anything interesting from */
const DMN_PATH = "processes/rabatt.dmn";
const DMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/" xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/" id="Definitions_rabatt" name="Rabatt" namespace="http://bpmiq.dev/dmn/rabatt">
  <decision id="rabatt" name="Rabatt">
    <decisionTable id="DT_rabatt" hitPolicy="FIRST">
      <input id="Input_1" label="Kundentyp">
        <inputExpression id="IE_1" typeRef="string"><text>kundentyp</text></inputExpression>
      </input>
      <output id="Output_1" name="rabatt" typeRef="number" />
      <rule id="Rule_stamm">
        <inputEntry id="e1"><text>"stamm"</text></inputEntry>
        <outputEntry id="e2"><text>10</text></outputEntry>
      </rule>
      <rule id="Rule_neu">
        <inputEntry id="e3"><text>"neu"</text></inputEntry>
        <outputEntry id="e4"><text>0</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
  <dmndi:DMNDI>
    <dmndi:DMNDiagram id="DMNDiagram_rabatt">
      <dmndi:DMNShape id="DMNShape_rabatt" dmnElementRef="rabatt">
        <dc:Bounds height="80" width="180" x="160" y="100" />
      </dmndi:DMNShape>
    </dmndi:DMNDiagram>
  </dmndi:DMNDI>
</definitions>
`;

/** a wardley map — the non-BPMN/DMN notation of the fixture (get_view, list_models) */
const OWM_PATH = "processes/strategy.owm";
const OWM = "component Platform [0.3, 0.4]\ncomponent Checkout [0.8, 0.6]\nCheckout -> Platform\n";

/** a process that delegates to the decision above — the impact link */
const USER_PATH = "processes/uses-rabatt.bpmn";
const USER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="uses-rabatt" name="Uses rabatt">
    <bpmn:businessRuleTask id="Task_rabatt" name="Rabatt ermitteln" calledDecision="rabatt" />
  </bpmn:process>
</bpmn:definitions>
`;

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
const DMN_WIDGET_STUB =
  '<html><head><script>window.BPMIQ_BOOT = "__BPMIQ_BOOT__";</script></head><body>dmn</body></html>';

function deps(over: Partial<McpDeps> = {}): McpDeps {
  const ws = mkdtempSync(join(tmpdir(), "bpm-mcp-"));
  mkdirSync(join(ws, "processes"), { recursive: true });
  writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
  writeFileSync(join(ws, PATH), VALID);
  writeFileSync(join(ws, DMN_PATH), DMN);
  writeFileSync(join(ws, USER_PATH), USER_BPMN);
  writeFileSync(join(ws, OWM_PATH), OWM);
  const webDist = mkdtempSync(join(tmpdir(), "bpm-webdist-"));
  writeFileSync(join(webDist, "mcp-app.html"), WIDGET_STUB);
  writeFileSync(join(webDist, "mcp-app-dmn.html"), DMN_WIDGET_STUB);
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
    publicUrl: "http://live.test",
    wsTickets: new WsTicketStore(),
    ...over,
  };
}

/** in-memory IssueTracker — the port is the seam, so the tools are testable
 *  without GitHub (the REAL adapter has its own suite: todo-issues.test.ts) */
function fakeIssues(): IssueTracker & { created: Array<{ repo: string; input: TodoInput }>; closed: string[] } {
  const items: Todo[] = [];
  const created: Array<{ repo: string; input: TodoInput }> = [];
  const closed: string[] = [];
  return {
    id: "fake-tracker",
    created,
    closed,
    async createTodo(repo, input) {
      created.push({ repo, input });
      const todo: Todo = {
        id: String(items.length + 1),
        url: `https://tracker.test/${repo}/issues/${items.length + 1}`,
        title: input.title,
        body: input.body,
        state: "open",
        anchor: input.anchor,
        author: input.author,
        assignees: [],
        createdAt: new Date().toISOString(),
      };
      items.push(todo);
      return todo;
    },
    async listTodos(_repo, processId) {
      return items.filter((t) => t.state === "open" && (!processId || t.anchor?.process === processId));
    },
    async closeTodo(_repo, id) {
      closed.push(id);
      const hit = items.find((t) => t.id === id);
      if (!hit) throw new Error(`no such todo: ${id}`);
      hit.state = "done";
    },
  };
}

async function connect(d: McpDeps, s: Session = session(), contributions: LiveToolContribution[] = []) {
  const server = createLiveMcpServer(d, s, contributions);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  cleanups.push(() => Promise.all([client.close(), server.close()]));
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    toolText(await client.callTool({ name, arguments: args }));
  const callJson = async (name: string, args: Record<string, unknown> = {}) => {
    const { isError, text } = await call(name, args);
    assert.ok(!isError, `${name} unexpectedly errored: ${text}`);
    return JSON.parse(text) as Record<string, any>;
  };
  return { client, call, callJson };
}

// ── (a) tool behaviour ──────────────────────────────────────────────────────

test("registration: every tool; read-only mode drops the write tools AND the ws ticket", async () => {
  const full = await connect(deps());
  assert.deepEqual((await full.client.listTools()).tools.map((t) => t.name).sort(), [
    "analyze_decision",
    "create_decision",
    "create_process",
    "get_bpmn_xml",
    "get_decision",
    "get_decision_tests",
    "get_dmn_xml",
    "get_process",
    "get_view",
    "list_changes",
    "list_decisions",
    "list_models",
    "list_processes",
    "list_repos",
    "mint_ws_ticket",
    "open_decision_modeler",
    "open_modeler",
    "release_process",
    "run_decision_tests",
    "save_bpmn_xml",
    "save_decision_tests",
    "save_dmn_xml",
    "simulate_decision",
    "validate_bpmn",
  ]);
  // open_modeler stays in read-only mode (opening is a read; the widget's
  // readonly marker turns it into a viewer)
  const ro = await connect(deps({ mcpReadOnly: true }));
  assert.deepEqual((await ro.client.listTools()).tools.map((t) => t.name).sort(), [
    "analyze_decision",
    "get_bpmn_xml",
    "get_decision",
    "get_decision_tests",
    "get_dmn_xml",
    "get_process",
    "get_view",
    "list_changes",
    "list_decisions",
    "list_models",
    "list_processes",
    "list_repos",
    "open_decision_modeler",
    "open_modeler",
    "run_decision_tests",
    "simulate_decision",
    "validate_bpmn",
  ]);
});

test("registration: the todo tools appear only WITH a tracker; read-only keeps the listing one", async () => {
  const withTracker = await connect(deps({ issues: fakeIssues() }));
  const names = (await withTracker.client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names.filter((n) => n.includes("todo")).sort(), ["close_todo", "create_todo", "list_todos"]);

  // no tracker configured → absent from tools/list, never a call that fails
  const none = await connect(deps());
  assert.deepEqual(
    (await none.client.listTools()).tools.map((t) => t.name).filter((n) => n.includes("todo")),
    [],
  );

  // read-only: listing is a read and stays; filing/closing are writes and go
  const ro = await connect(deps({ issues: fakeIssues(), mcpReadOnly: true }));
  assert.deepEqual(
    (await ro.client.listTools()).tools.map((t) => t.name).filter((n) => n.includes("todo")),
    ["list_todos"],
  );
});

test("todos: create anchors to the open process, list filters by it, close completes it", async () => {
  const issues = fakeIssues();
  const { call, callJson } = await connect(deps({ issues }));

  const created = await callJson("create_todo", {
    repo: REPO.fullName,
    id: "order",
    title: "  Check the credit limit  ",
    body: "The threshold looks stale.",
    elements: [{ id: "Task_CheckCredit", name: "Bonität prüfen" }],
  });
  assert.equal(created.todo.title, "Check the credit limit", "title is trimmed");
  assert.equal(created.todo.author, "petra", "attribution is the CALLER's login, not an argument");
  assert.deepEqual(created.todo.anchor, {
    process: "order",
    file: PATH,
    elements: [{ id: "Task_CheckCredit", name: "Bonität prüfen" }],
    processVersion: null,
  });

  // a `path`-addressed todo derives the process id from the file stem
  await callJson("create_todo", { repo: REPO.fullName, path: PATH, title: "Process-level note" });
  const viaPath = issues.created[1]?.input.anchor;
  assert.equal(viaPath?.process, "order");
  assert.deepEqual(viaPath?.elements, [], "no elements ⇒ a process-level todo");

  // listing: whole repo vs. narrowed to one process
  const all = await callJson("list_todos", { repo: REPO.fullName });
  assert.equal(all.process, null);
  assert.equal(all.todos.length, 2);
  const narrowed = await callJson("list_todos", { repo: REPO.fullName, id: "order" });
  assert.equal(narrowed.process, "order");
  assert.equal(narrowed.todos.length, 2);
  const other = await callJson("list_todos", { repo: REPO.fullName, id: "not-a-process" });
  assert.deepEqual(other.todos, [], "an unknown process filter is an empty list, not an error");

  // close takes the TRACKER id (never a process id) and drops it from the list
  const closed = await callJson("close_todo", { repo: REPO.fullName, todoId: created.todo.id });
  assert.equal(closed.ok, true);
  assert.deepEqual(issues.closed, [created.todo.id]);
  assert.equal((await callJson("list_todos", { repo: REPO.fullName })).todos.length, 1);

  // an empty title is refused before the tracker is touched (the shared
  // use-case speaks the REST wording on both transports)
  const blank = await call("create_todo", { repo: REPO.fullName, id: "order", title: "   " });
  assert.ok(blank.isError);
  assert.match(blank.text, /title must be a non-empty string/);
  assert.equal(issues.created.length, 2);

  // an unknown process is a typed 404, never a stored anchor pointing at nothing
  const dangling = await call("create_todo", { repo: REPO.fullName, id: "no-such-process", title: "x" });
  assert.ok(dangling.isError);
  assert.match(dangling.text, /process 'no-such-process' not found/);
  assert.equal(issues.created.length, 2);
});

test("todos: per-call authz gates the tracker too — no write access, no todo access", async () => {
  const issues = fakeIssues();
  const { call } = await connect(deps({ issues, access: { canWrite: async () => false } }));
  for (const [tool, args] of [
    ["list_todos", { repo: REPO.fullName }],
    ["create_todo", { repo: REPO.fullName, id: "order", title: "x" }],
    ["close_todo", { repo: REPO.fullName, todoId: "1" }],
  ] as const) {
    const denied = await call(tool, args);
    assert.ok(denied.isError, `${tool} must be denied`);
    assert.match(denied.text, /no write access to acme\/models/);
  }
  assert.equal(issues.created.length, 0, "the tracker was never reached");
});

test("MCP App: open_modeler carries the ui resource link; the resource serves the widget with the boot marker injected", async () => {
  const { client, callJson } = await connect(deps());

  // the tool advertises its UI template (nested + legacy flat key, per ext-apps)
  const tool = (await client.listTools()).tools.find((t) => t.name === "open_modeler");
  assert.ok(tool, "open_modeler registered");
  const meta = tool._meta as {
    ui?: { resourceUri?: string };
    "ui/resourceUri"?: string;
    "openai/outputTemplate"?: string;
  };
  const uri = meta?.ui?.resourceUri;
  assert.ok(uri?.startsWith("ui://bpmiq/modeler-"), `ui resourceUri: ${uri}`);
  assert.equal(meta?.["ui/resourceUri"], uri);
  // ChatGPT's compatibility alias — older builds read only this key
  assert.equal(meta?.["openai/outputTemplate"], uri);

  // the resource serves the single-file widget with the boot marker replaced
  const res = await client.readResource({ uri: uri! });
  const doc = res.contents[0] as { mimeType?: string; text?: string };
  assert.equal(doc.mimeType, "text/html;profile=mcp-app");
  assert.ok(!doc.text!.includes("__BPMIQ_BOOT__"), "marker replaced");
  assert.ok(doc.text!.includes('\\"readonly\\":false'), "boot config injected");
  // the deep-link base rides in the boot payload — the sandboxed iframe has
  // no other way to learn the instance origin
  assert.ok(doc.text!.includes('\\"publicUrl\\":\\"http://live.test\\"'), "publicUrl injected");

  // the tool result stays lean: a summary + the web deep link, never the XML
  const opened = await callJson("open_modeler", { repo: REPO.fullName, id: "order" });
  assert.equal(opened.opened.path, PATH);
  assert.equal(opened.opened.url, "http://live.test/r/acme/models/p/order");
  assert.ok(!JSON.stringify(opened).includes("<bpmn"), "no XML in the tool result");

  // read-only mode flips the widget's boot flag — under a NEW resource uri:
  // the boot payload salts the hash, so hosts caching by uri re-fetch on a
  // config change instead of serving a stale boot
  const ro = await connect(deps({ mcpReadOnly: true }));
  const roTool = (await ro.client.listTools()).tools.find((t) => t.name === "open_modeler");
  const roUri = (roTool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri;
  assert.ok(roUri, "read-only server advertises its widget");
  assert.notEqual(roUri, uri, "a changed boot payload mints a new resource uri");
  const roRes = await ro.client.readResource({ uri: roUri! });
  assert.ok((roRes.contents[0] as { text?: string }).text!.includes('\\"readonly\\":true'));
});

test("MCP App: open_decision_modeler serves the DMN widget and takes a scenario", async () => {
  const { client, callJson } = await connect(deps());

  const tool = (await client.listTools()).tools.find((t) => t.name === "open_decision_modeler");
  assert.ok(tool, "open_decision_modeler registered");
  const uri = (tool._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri;
  assert.ok(uri?.startsWith("ui://bpmiq/decision-modeler-"), `ui resourceUri: ${uri}`);
  assert.equal((tool._meta as { "openai/outputTemplate"?: string })?.["openai/outputTemplate"], uri);
  // its own resource — never the BPMN widget's
  const other = (await client.listTools()).tools.find((t) => t.name === "open_modeler");
  assert.notEqual(uri, (other?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri);

  const doc = (await client.readResource({ uri: uri! })).contents[0] as { text?: string };
  assert.match(doc.text ?? "", /<body>dmn<\/body>/);
  assert.ok(doc.text!.includes('\\"readonly\\":false'), "boot config injected");
  assert.ok(doc.text!.includes('\\"publicUrl\\":\\"http://live.test\\"'), "publicUrl injected");

  // the scenario rides in the tool ARGUMENTS (the widget reads ontoolinput);
  // the result stays a lean summary, never the XML
  const opened = await callJson("open_decision_modeler", {
    repo: REPO.fullName,
    id: "rabatt",
    scenario: { kundentyp: "stamm" },
  });
  assert.equal(opened.opened.path, DMN_PATH);
  // decisions deep-link to the file-editor splat route
  assert.equal(opened.opened.url, "http://live.test/r/acme/models/f/processes/rabatt.dmn");
  assert.deepEqual(opened.summary.decisions, [{ id: "rabatt", hitPolicy: "FIRST", rules: 2 }]);
  assert.ok(!JSON.stringify(opened).includes("<decision"), "no XML in the tool result");
});

test("list_models: every notation of the repo in one grouped listing", async () => {
  const { callJson } = await connect(deps());
  const res = await callJson("list_models", { repo: REPO.fullName });
  assert.deepEqual(Object.keys(res.models).sort(), ["bpmn", "dmn", "wardley"]);
  assert.ok(res.models.bpmn.some((m: { id: string }) => m.id === "order"));
  assert.equal(res.models.dmn[0].notation, "dmn");
});

test("get_view: the derived view of ANY live model — wardley incl. baseVersion", async () => {
  const { callJson } = await connect(deps());
  const wardley = await callJson("get_view", { repo: REPO.fullName, id: "strategy" });
  assert.equal(wardley.path, OWM_PATH);
  assert.equal(wardley.notation, "wardley");
  assert.deepEqual(wardley.stats, { components: 2, dependencies: 1 });
  assert.ok(wardley.baseVersion.length > 20, "live content token rides along");

  const process = await callJson("get_view", { repo: REPO.fullName, id: "order" });
  assert.equal(process.notation, "bpmn");
  assert.match(process.summary, /^Process with /);
  assert.ok(process.detail, "the rich DerivedProcess rides in detail");

  // a direct path resolves too, and the payload id comes from the RESOLVED
  // path — a conflicting caller-supplied id must not ride along verbatim
  const byPath = await callJson("get_view", { repo: REPO.fullName, id: "order", path: OWM_PATH });
  assert.equal(byPath.id, "strategy");
  assert.equal(byPath.notation, "wardley");

  const { call } = await connect(deps());
  const unknown = await call("get_view", { repo: REPO.fullName, id: "nope" });
  assert.ok(unknown.isError && /unknown model 'nope'/.test(unknown.text));
});

test("contributions: a capability module's tools register after the core, with deps + session", async () => {
  const d = deps();
  const me = session("carla");
  let received: { deps: unknown; login: string } | undefined;
  const contribute: LiveToolContribution = (server, contribDeps, contribSession) => {
    received = { deps: contribDeps, login: contribSession.user.login };
    server.registerTool(
      "my_capability_tool",
      { description: "contributed", annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text" as const, text: "hi" }] }),
    );
  };
  const { client } = await connect(d, me, [contribute]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("my_capability_tool"));
  assert.ok(names.includes("list_models"), "core registration untouched");
  // the hook forwards the SAME deps object and the CALLER's session — the
  // contract the decisions quartet will build on
  assert.equal(received?.deps, d);
  assert.equal(received?.login, "carla");
});

test("get→save round-trip incl. the conflict retry loop (stale token never overwrites)", async () => {
  const { callJson } = await connect(deps());
  const procs = await callJson("list_processes", { repo: REPO.fullName });
  assert.equal(procs.processes[0].id, "order");

  const got = await callJson("get_bpmn_xml", { repo: REPO.fullName, id: "order" });
  assert.equal(got.content, VALID);
  assert.equal(got.xml, VALID, "deprecated alias (#154) still on the tool result");

  // stale token → retryable conflict RESULT (not a protocol error)
  const stale = await callJson("save_bpmn_xml", {
    repo: REPO.fullName,
    id: "order",
    xml: VALID_V2,
    baseVersion: "bogus.token",
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.currentContent, VALID);
  assert.equal(stale.currentXml, VALID, "deprecated alias (#154) still on the conflict result");

  // the agent retry: re-derive against currentContent, use the fresh token
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

test("decisions: list → get_decision (derived table) → save_dmn_xml round-trip", async () => {
  const { call, callJson } = await connect(deps());

  const list = await callJson("list_decisions", { repo: REPO.fullName });
  assert.deepEqual(
    list.decisions.map((d: { id: string; path: string }) => [d.id, d.path]),
    [["rabatt", DMN_PATH]],
  );

  // the derived view carries the table, not just the node list
  const view = await callJson("get_decision", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(view.path, DMN_PATH);
  // …and the impact side: which processes delegate to this decision
  assert.deepEqual(view.usedBy, [
    { process: "uses-rabatt", path: USER_PATH, element: "Task_rabatt", elementName: "Rabatt ermitteln" },
  ]);
  assert.equal(view.name, "Rabatt");
  assert.equal(view.decisions[0].hitPolicy, "FIRST");
  assert.deepEqual(view.decisions[0].inputs[0], {
    id: "Input_1",
    label: "Kundentyp",
    expression: "kundentyp",
    typeRef: "string",
    inputValues: [],
  });
  assert.deepEqual(
    view.decisions[0].rules.map((r: { id: string; when: string[]; then: string[] }) => [r.id, r.when, r.then]),
    [
      ["Rule_stamm", ['"stamm"'], ["10"]],
      ["Rule_neu", ['"neu"'], ["0"]],
    ],
  );

  // save with the token from the XML read; a stale one conflicts instead of overwriting
  const got = await callJson("get_dmn_xml", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(got.content, DMN);
  const stale = await callJson("save_dmn_xml", {
    repo: REPO.fullName,
    id: "rabatt",
    xml: DMN.replace('name="Rabatt"', 'name="Rabatt v2"'),
    baseVersion: "bogus.token",
  });
  assert.equal(stale.conflict, true);
  const saved = await callJson("save_dmn_xml", {
    repo: REPO.fullName,
    id: "rabatt",
    xml: DMN.replace('name="Rabatt"', 'name="Rabatt v2"'),
    baseVersion: stale.baseVersion,
  });
  assert.equal(saved.ok, true);
  assert.equal((await callJson("get_decision", { repo: REPO.fullName, id: "rabatt" })).name, "Rabatt v2");

  // an unknown id names the tool that lists the real ones
  const unknown = await call("get_decision", { repo: REPO.fullName, id: "nope" });
  assert.ok(unknown.isError);
  assert.match(unknown.text, /decision 'nope' not found .*use list_decisions/);

  // a BPMN path through the decision tools is a clear error, not a crash
  const wrong = await call("get_decision", { repo: REPO.fullName, path: PATH });
  assert.ok(wrong.isError);
  assert.match(wrong.text, /not a DMN model/);
});

test("simulate_decision + analyze_decision: live model, and a dry run on unsaved XML", async () => {
  const { call, callJson } = await connect(deps());

  const hit = await callJson("simulate_decision", {
    repo: REPO.fullName,
    id: "rabatt",
    given: { kundentyp: "stamm" },
  });
  assert.equal(hit.path, DMN_PATH);
  assert.deepEqual(hit.decisions[0].reportedRules, ["Rule_stamm"]);
  assert.equal(hit.decisions[0].value, 10);

  // a typo comes back as a named problem, not as "nothing matched"
  const typo = await callJson("simulate_decision", {
    repo: REPO.fullName,
    id: "rabatt",
    given: { Kundentyp: "stamm" },
  });
  assert.deepEqual(typo.unknownInputs, ["Kundentyp"]);
  assert.deepEqual(typo.missingInputs, ["kundentyp"]);

  // the live model is sound; its variable profile carries the test material
  const analysis = await callJson("analyze_decision", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(analysis.ok, true);
  assert.deepEqual(analysis.findings, []);
  assert.deepEqual(analysis.variables[0], {
    name: "kundentyp",
    typeRef: "string",
    source: "free",
    literals: ["stamm", "neu"],
    boundaries: [],
  });

  // dry run: broken FEEL in an UNSAVED edit, without touching the repo at all
  const dry = await callJson("analyze_decision", { xml: DMN.replace("<text>10</text>", "<text>10 +</text>") });
  assert.equal(dry.ok, false);
  assert.equal(dry.findings[0].code, "feel-syntax");
  assert.equal(dry.findings[0].rule, "Rule_stamm");

  // …and the stored model is untouched by it
  assert.equal((await callJson("get_dmn_xml", { repo: REPO.fullName, id: "rabatt" })).xml, DMN);

  // neither repo nor xml → an actionable message
  const nothing = await call("analyze_decision", {});
  assert.ok(nothing.isError);
  assert.match(nothing.text, /provide `repo`.*or an explicit `xml`/);
});

test("decision tests: none → first save creates the sidecar → run → golden master → conflict guard", async () => {
  const { call, callJson } = await connect(deps());

  // a decision without a suite: empty, passing, and every rule uncovered
  const before = await callJson("get_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(before.exists, false);
  assert.equal(before.path, "processes/rabatt.tests.yaml");
  const empty = await callJson("run_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.cases, []);
  assert.deepEqual(empty.uncoveredRules, ["rabatt/Rule_stamm", "rabatt/Rule_neu"]);

  // trial run: cases passed inline are never stored
  const trial = await callJson("run_decision_tests", {
    repo: REPO.fullName,
    id: "rabatt",
    cases: [{ name: "Stammkunde", given: { kundentyp: "stamm" }, expect: { value: 10 } }],
  });
  assert.equal(trial.passed, 1);
  assert.equal(trial.testsPath, null);
  assert.equal((await callJson("get_decision_tests", { repo: REPO.fullName, id: "rabatt" })).exists, false);

  // first save: no baseVersion needed, the file is created next to the model
  const created = await callJson("save_decision_tests", {
    repo: REPO.fullName,
    id: "rabatt",
    cases: [
      { name: "Stammkunde", given: { kundentyp: "stamm" }, expect: { value: 10, rules: ["Rule_stamm"] } },
      { name: "Neukunde", given: { kundentyp: "neu" } }, // no expect → golden master
    ],
    record: true,
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.path, "processes/rabatt.tests.yaml");
  assert.equal(created.outcome.passed, 2, "record:true froze the pending case, so both pass");

  // the stored suite is real YAML with the recorded expectation in it
  const stored = await callJson("get_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(stored.exists, true);
  assert.match(stored.raw, /name: Neukunde/);
  assert.deepEqual(stored.suite.cases[1].expect, { value: 0, rules: ["Rule_neu"] });

  // running the stored suite now reports full coverage
  const run = await callJson("run_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(run.passed, 2);
  assert.deepEqual(run.uncoveredRules, []);
  assert.equal(run.testsPath, "processes/rabatt.tests.yaml");

  // a second save without baseVersion is refused, a stale one conflicts
  const noToken = await call("save_decision_tests", { repo: REPO.fullName, id: "rabatt", cases: [] });
  assert.ok(noToken.isError);
  assert.match(noToken.text, /already exists — read it first/);
  const stale = await callJson("save_decision_tests", {
    repo: REPO.fullName,
    id: "rabatt",
    cases: [],
    baseVersion: "bogus.token",
  });
  assert.equal(stale.conflict, true);

  // …and the model itself is now covered by a failing case if we break it
  const broken = await callJson("run_decision_tests", {
    repo: REPO.fullName,
    id: "rabatt",
    xml: DMN.replace("<text>10</text>", "<text>20</text>"),
  });
  assert.equal(broken.failed, 1);
  assert.match(broken.cases[0].failures[0], /expected 10, got 20/);
});

test("save_decision_tests keeps the suite's own `decision:` key — callers only send cases", async () => {
  const d = deps();
  const { callJson } = await connect(d);
  const ws = await d.workspaces.ensure(REPO);
  // a hand-authored sidecar that PINS which decision the top-level
  // expectations are about — in a chained DRD that is not the leaf
  // mainDecisionOf() would fall back to
  writeFileSync(
    join(ws, "processes/rabatt.tests.yaml"),
    "decision: rabatt\ncases:\n  - name: Stammkunde\n    given: { kundentyp: stamm }\n    expect: { value: 10 }\n",
  );
  const before = await callJson("get_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(before.suite.decision, "rabatt");

  // the tool has no field for it, so the write must carry it over itself
  const saved = await callJson("save_decision_tests", {
    repo: REPO.fullName,
    id: "rabatt",
    cases: [...before.suite.cases, { name: "Neukunde", given: { kundentyp: "neu" } }],
    baseVersion: before.baseVersion,
    record: true,
  });
  assert.equal(saved.ok, true);

  const after = await callJson("get_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(after.suite.decision, "rabatt");
  assert.match(after.raw, /^decision: rabatt$/m);
  assert.equal(after.suite.cases.length, 2);
});

test("mint_ws_ticket → ws onAuthenticate: the full live-connection handshake, room-bound", async () => {
  const wsTickets = new WsTicketStore();
  const d = deps({ wsTickets });
  const { callJson } = await connect(d);

  const minted = await callJson("mint_ws_ticket", { repo: REPO.fullName, id: "order" });
  assert.equal(minted.url, "ws://live.test");
  assert.equal(minted.room, `${REPO.fullName}/${PATH}`);
  assert.equal(minted.expiresInSeconds, 60);

  // the ticket passes the REAL ws gate — makeCollabHooks with the same store
  const hooks = makeCollabHooks({
    lineage: { load: () => undefined, save: () => {}, drop: () => {} } as never,
    docGuard: new DocSizeGuard(8_000_000),
    maxDocBytes: 8_000_000,
    sessions: { get: () => undefined },
    access: { canWrite: async () => true },
    registry: d.registry,
    workspaces: d.workspaces,
    contentConfig: loadContentConfig,
    devToken: () => undefined,
    liveDocs: new Set(),
    wsTickets,
  });
  const auth = await hooks.onAuthenticate({ token: minted.ticket, documentName: minted.room });
  assert.equal(auth.user.login, "petra");
  // single-use: replaying the same ticket is refused
  await assert.rejects(() => hooks.onAuthenticate({ token: minted.ticket, documentName: minted.room }), /invalid/);

  // a ticket never opens a DIFFERENT room
  const second = await callJson("mint_ws_ticket", { repo: REPO.fullName, id: "order" });
  await assert.rejects(
    () => hooks.onAuthenticate({ token: second.ticket, documentName: `${REPO.fullName}/processes/other.bpmn` }),
    /invalid|no such|unknown/,
  );

  // read-only mode: the ticket tool is absent — the viewer stays on bridge reads
  const ro = await connect(deps({ mcpReadOnly: true }));
  const roTools = (await ro.client.listTools()).tools.map((t) => t.name);
  assert.ok(!roTools.includes("mint_ws_ticket"));
});

test("save_bpmn_xml lint:'warn' (widget autosave) saves despite validation errors and reports them", async () => {
  const { callJson } = await connect(deps());
  const got = await callJson("get_bpmn_xml", { repo: REPO.fullName, id: "order" });

  // strict default still refuses (the agent contract is untouched) …
  const { call } = await connect(deps());
  const strict = await call("save_bpmn_xml", {
    repo: REPO.fullName,
    id: "order",
    xml: "<not-bpmn/>",
    baseVersion: got.baseVersion,
  });
  assert.ok(strict.isError && /validation failed/.test(strict.text));

  // … while lint:"warn" saves and reports
  const warned = await callJson("save_bpmn_xml", {
    repo: REPO.fullName,
    id: "order",
    xml: "<not-bpmn/>",
    baseVersion: got.baseVersion,
    lint: "warn",
  });
  assert.equal(warned.ok, true);
  assert.ok(warned.errors.length > 0);
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
  assert.equal(got.content, VALID);
  assert.equal(got.xml, VALID, "deprecated alias (#154) still on the tool result");
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
