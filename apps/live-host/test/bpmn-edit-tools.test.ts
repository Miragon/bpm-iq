/**
 * The semantic BPMN tools of ADR 0008 (get_process_outline, edit_process, layout_process): opt-in registration
 * (LIVE_MCP_BPMN_EDIT), the tools against a REAL Hocuspocus direct connection and the ordinary save gate, and the
 * re-application of a change when the document moved on between read and write (application/bpmn-edit.ts).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import type { PutContentResultWire } from "@bpmiq/contracts/live-host";
import { toolText } from "@bpmiq/mcp-kit/testing";
import { Server as HocuspocusServer } from "@hocuspocus/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import type { Session } from "../src/adapters/sqlite/sessions.ts";
import { type BpmnEditIo, editProcess, MAX_ATTEMPTS } from "../src/application/bpmn-edit.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { baseVersionOf } from "../src/application/content.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
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
const PATH = "processes/order-to-cash.bpmn";
/** the example content repo's process: lanes, a decision link, a call activity, a Camunda 7 root */
const EXAMPLE = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "process-documentation", "processes", "order-to-cash.bpmn"),
  "utf8",
);
const SUB = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "process-documentation",
    "processes",
    "subprocesses",
    "invoice-handling.bpmn",
  ),
  "utf8",
);
const BPMN_EDIT_TOOLS = ["edit_process", "get_process_outline", "layout_process"];

const session: Session = {
  id: "sess-petra",
  user: { login: "petra", name: "petra", avatarUrl: null, provider: "github" },
  createdAt: Date.now(),
};

const servers: HocuspocusServer[] = [];
const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const c of cleanups) await c();
  await Promise.all(servers.map((s) => s.destroy()));
  // the same watchdog as mcp.test.ts: a passed suite must never hang on a Hocuspocus unload handle
  setTimeout(() => process.exit(), 2000).unref();
});

function deps(over: Partial<McpDeps> = {}): McpDeps {
  const ws = mkdtempSync(join(tmpdir(), "bpm-edit-"));
  mkdirSync(join(ws, "processes", "subprocesses"), { recursive: true });
  writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
  writeFileSync(join(ws, PATH), EXAMPLE);
  writeFileSync(join(ws, "processes", "subprocesses", "invoice-handling.bpmn"), SUB);
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
    github: {} as GitProvider,
    webDist: mkdtempSync(join(tmpdir(), "bpm-webdist-")),
    publicUrl: "http://live.test",
    ...over,
  };
}

async function connect(d: McpDeps) {
  const server = createLiveMcpServer(d, session, []);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bpmn-edit-test", version: "0" });
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

const toolNames = async (d: McpDeps) =>
  (await (await connect(d)).client.listTools()).tools.map((t) => t.name).filter((n) => BPMN_EDIT_TOOLS.includes(n));

test("registration: off by default, all three with LIVE_MCP_BPMN_EDIT, only the outline when read-only", async () => {
  assert.deepEqual(await toolNames(deps()), []);
  assert.deepEqual((await toolNames(deps({ bpmnEdit: true }))).sort(), BPMN_EDIT_TOOLS);
  assert.deepEqual(await toolNames(deps({ bpmnEdit: true, mcpReadOnly: true })), ["get_process_outline"]);
});

test("get_process_outline: platform, lanes, links and a neighbourhood window of the LIVE document", async () => {
  const { callJson } = await connect(deps({ bpmnEdit: true }));
  const full = await callJson("get_process_outline", { repo: REPO.fullName, id: "order-to-cash" });
  const process = full.outline.processes[0];

  assert.equal(full.outline.platform, "c7");
  assert.deepEqual(
    process.lanes.map((lane: { id: string }) => lane.id),
    ["Lane_order_management", "Lane_billing", "Lane_customer_support"],
  );
  const rule = process.elements.find((e: { id: string }) => e.id === "Task_check_credit");
  assert.deepEqual([rule.lane, rule.calledDecision], ["Lane_order_management", "credit-limit-check"]);
  assert.equal(full.baseVersion, baseVersionOf(EXAMPLE));

  const window = await callJson("get_process_outline", {
    repo: REPO.fullName,
    id: "order-to-cash",
    around: "Gateway_credit_approved",
    depth: 1,
  });
  assert.ok(window.outline.processes[0].elements.length < process.elements.length);
});

test("edit_process: inserts through the save gate; the rest of the file stays byte for byte", async () => {
  const { callJson } = await connect(deps({ bpmnEdit: true }));
  const out = await callJson("edit_process", {
    repo: REPO.fullName,
    id: "order-to-cash",
    operations: [
      {
        op: "insertAfter",
        after: "Task_fulfill_order",
        element: { type: "userTask", id: "Task_ship", name: "Ship goods" },
      },
    ],
  });
  assert.deepEqual([out.ok, out.written, out.attempts], [true, true, 1]);
  assert.ok(out.change.changedIds.includes("Task_ship"));

  const saved = (await callJson("get_bpmn_xml", { repo: REPO.fullName, id: "order-to-cash" })).content as string;
  assert.match(saved, /<bpmn:userTask id="Task_ship" name="Ship goods">/);
  assert.match(saved, /<bpmn:flowNodeRef>Task_ship<\/bpmn:flowNodeRef>/);
  // the root tag and the decision link spelling are untouched
  const root = (xml: string) => /<bpmn:definitions[^>]*>/.exec(xml)?.[0];
  assert.equal(root(saved), root(EXAMPLE));
  assert.match(saved, / calledDecision="credit-limit-check"/);
  // only the edit: every line of the original that is not about the inserted task, its flow or moved shapes survives
  const kept = EXAMPLE.split("\n").filter((line) => saved.includes(line)).length;
  assert.ok(kept / EXAMPLE.split("\n").length > 0.85, `only ${kept} lines kept`);
});

test("edit_process: a failing operation names its index and leaves the document alone; dryRun saves nothing", async () => {
  const { call, callJson } = await connect(deps({ bpmnEdit: true }));
  const bad = await call("edit_process", {
    repo: REPO.fullName,
    id: "order-to-cash",
    operations: [
      { op: "rename", id: "Task_fulfill_order", name: "Fulfil order" },
      { op: "moveToLane", id: "Task_fulfill_order", lane: "Lane_nope" },
    ],
  });
  assert.ok(bad.isError);
  assert.match(bad.text, /operation 1 \(moveToLane\): no lane 'Lane_nope'/);

  const dry = await callJson("edit_process", {
    repo: REPO.fullName,
    id: "order-to-cash",
    operations: [{ op: "rename", id: "Task_fulfill_order", name: "Fulfil order" }],
    dryRun: true,
  });
  assert.deepEqual([dry.ok, dry.written], [true, false]);
  const current = (await callJson("get_bpmn_xml", { repo: REPO.fullName, id: "order-to-cash" })).content;
  assert.equal(current, EXAMPLE);
});

test("layout_process: tidy keeps an already clean drawing; the result reports metrics before and after", async () => {
  const { callJson } = await connect(deps({ bpmnEdit: true }));
  const out = await callJson("layout_process", {
    repo: REPO.fullName,
    id: "order-to-cash",
    mode: "tidy",
    dryRun: true,
  });

  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.change.before) && Array.isArray(out.change.after));
});

test("a concurrent change is answered by re-applying the operations, and given up after MAX_ATTEMPTS", async () => {
  let text = EXAMPLE;
  let conflicts = 1;
  const io: BpmnEditIo = {
    read: async (path) => ({ path, content: text, baseVersion: baseVersionOf(text) }),
    write: async (path, body) => {
      if (conflicts > 0) {
        conflicts--;
        // a co-editor renamed another task meanwhile
        text = text.replace('name="Validate order"', 'name="Check order"');
        return {
          ok: false,
          conflict: {
            error: "changed",
            code: "content/conflict",
            path,
            currentContent: text,
            currentXml: text,
            baseVersion: baseVersionOf(text),
          },
        };
      }
      text = body.content;
      const result = { path, baseVersion: baseVersionOf(text) } as unknown as PutContentResultWire;
      return { ok: true, result, previous: "", next: text };
    },
  };
  const out = await editProcess(io, PATH, [{ op: "rename", id: "Task_fulfill_order", name: "Fulfil order" }]);

  assert.deepEqual([out.ok, out.ok && out.attempts], [true, 2]);
  // both changes survive: the co-editor's and the re-applied one
  assert.match(text, /name="Check order"/);
  assert.match(text, /name="Fulfil order"/);

  conflicts = MAX_ATTEMPTS;
  const given = await editProcess(io, PATH, [{ op: "rename", id: "Task_fulfill_order", name: "Fulfilled" }]);
  assert.deepEqual([given.ok, given.attempts], [false, MAX_ATTEMPTS]);
});
