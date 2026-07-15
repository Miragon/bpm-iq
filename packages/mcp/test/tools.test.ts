/**
 * bpm-mcp-server tool behaviour (packages/mcp/tools.ts). Drives the REAL server
 * over an in-memory transport — a linked Client↔Server pair, no stdio/HTTP boot —
 * so the tools are exercised exactly as an MCP client would, against the bundled
 * process-documentation content (DEFAULT_ROOT). Assertions lean on stable facts of
 * the order-to-cash example rather than brittle counts.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer, DEFAULT_ROOT } from "../tools.ts";

let client: Client;
let server: ReturnType<typeof createMcpServer>;

before(async () => {
  server = createMcpServer(DEFAULT_ROOT);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "mcp-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
  await server.close();
});

/** call a tool → { isError, text } (the first text block of the MCP result) */
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as Array<{ type: string; text?: string }>;
  return { isError: Boolean(r.isError), text: content[0]?.text ?? "" };
}

/** call a tool expected to succeed with a JSON body, parsed */
async function callJson(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { isError, text } = await call(name, args);
  assert.ok(!isError, `${name} unexpectedly errored: ${text}`);
  return JSON.parse(text);
}

test("registration: all ten read-only tools are exposed", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "enumerate_paths",
    "find_cycles",
    "get_landscape",
    "get_model",
    "get_process",
    "list_processes",
    "query_kpis",
    "search_glossary",
    "which_processes_use",
    "who_owns",
  ]);
});

test("list_processes: returns the order-to-cash portfolio row", async () => {
  const rows = await callJson("list_processes");
  const otc = rows.find((r: { id: string }) => r.id === "order-to-cash");
  assert.ok(otc, "order-to-cash is listed");
  assert.equal(otc.name, "Order to Cash");
  assert.equal(otc.classification, "core");
  assert.equal(otc.owner, "team-order-management");
});

test("get_process: full metadata + file list, docs overview resolved", async () => {
  const p = await callJson("get_process", { id: "order-to-cash" });
  assert.equal(p.metadata.name, "Order to Cash");
  assert.equal(p.path, "processes/order-to-cash/process.yaml");
  assert.ok(Array.isArray(p.files) && p.files.includes("order-to-cash.bpmn"));
  assert.ok(!p.files.includes("process.yaml"), "process.yaml is excluded from the file list");
  assert.match(p.overview, /^# Order to Cash/, "docs/overview.md is resolved, not the '(no overview)' fallback");
});

test("get_process: unknown id → isError listing what's available", async () => {
  const r = await call("get_process", { id: "does-not-exist" });
  assert.ok(r.isError);
  assert.match(r.text, /Unknown process 'does-not-exist'/);
  assert.match(r.text, /order-to-cash/); // suggests the real ones
});

test("get_model: default BPMN parses into a graph with real element names", async () => {
  const g = await callJson("get_model", { id: "order-to-cash" });
  assert.equal(g.file, "order-to-cash.bpmn");
  assert.ok(Array.isArray(g.nodes) && g.nodes.length > 0);
  assert.ok(Array.isArray(g.edges) && g.edges.length > 0);
  assert.ok(
    g.nodes.some((n: { name?: string }) => n.name === "Check credit limit"),
    "extracts the real element names",
  );
});

test("get_model: an explicit DMN decision file overrides the default and yields DMN edges", async () => {
  const g = await callJson("get_model", { id: "order-to-cash", file: "decisions/credit-check.dmn" });
  assert.equal(g.file, "decisions/credit-check.dmn"); // the file arg overrode meta.models.bpmn
  assert.ok(
    g.nodes.some((n: { type: string }) => n.type === "decision"),
    "a DMN decision node",
  );
  assert.ok(
    g.edges.some((e: { kind: string }) => e.kind === "informationRequirement"),
    "a DMN requirement edge",
  );
});

test("get_model: path traversal outside the process dir is refused", async () => {
  const r = await call("get_model", { id: "order-to-cash", file: "../../../etc/passwd" });
  assert.ok(r.isError);
  assert.match(r.text, /Illegal model path/);
});

test("get_model: unknown process → isError (distinct from the traversal guard)", async () => {
  const r = await call("get_model", { id: "does-not-exist" });
  assert.ok(r.isError);
  assert.match(r.text, /Unknown process 'does-not-exist'/);
});

test("enumerate_paths: returns start→end paths; max caps + flags truncation", async () => {
  const all = await callJson("enumerate_paths", { id: "order-to-cash" });
  assert.ok(all.pathCount >= 1, "at least one path");
  assert.ok(Array.isArray(all.paths[0]) && all.paths[0].length > 0, "a path is a list of element labels");
  const capped = await callJson("enumerate_paths", { id: "order-to-cash", max: 1 });
  assert.equal(capped.pathCount, 1);
  assert.equal(capped.truncated, all.pathCount > 1); // order-to-cash has >1 path → truncated
});

test("find_cycles: the acyclic order-to-cash flow reports no cycles", async () => {
  const { isError, text } = await call("find_cycles", { id: "order-to-cash" });
  assert.ok(!isError);
  assert.match(text, /No cycles/);
});

test("query_kpis: a matching filter narrows to real KPI rows; misses succeed with a message", async () => {
  const all = await callJson("query_kpis");
  assert.ok(Array.isArray(all) && all.length >= 1);
  // a real substring filter narrows AND keeps the KPI payload (not just the process key)
  const dso = await callJson("query_kpis", { query: "DSO" });
  assert.ok(dso.length >= 1 && dso.length <= all.length, "the filter narrows, never widens");
  assert.ok(
    dso.every((k: { process: string; name: string }) => /dso/i.test(`${k.process} ${k.name}`)),
    "every returned row matches the query",
  );
  assert.ok(dso.some((k: { name: string }) => k.name === "Days sales outstanding (DSO)"));
  const miss = await call("query_kpis", { query: "zzz-no-such-kpi" });
  assert.ok(!miss.isError, "an empty result is a success sentence, not an error");
  assert.match(miss.text, /No KPIs matching 'zzz-no-such-kpi'/);
});

test("get_landscape: team-topology, wardley and value-chain each parse into a graph", async () => {
  const topo = await callJson("get_landscape", { view: "team-topology" });
  assert.ok(
    topo.nodes.some((n: { name?: string }) => n.name === "Order Management"),
    "resolves real team nodes",
  );
  const wardley = await callJson("get_landscape", { view: "wardley" });
  assert.ok(Array.isArray(wardley.nodes) && wardley.nodes.length > 0);
  const valueChain = await callJson("get_landscape", { view: "value-chain" }); // the third enum value + .vc.json branch
  assert.ok(Array.isArray(valueChain.nodes) && valueChain.nodes.length > 0);
});

test("who_owns: resolves the owning team AND participants against team-topology", async () => {
  const o = await callJson("who_owns", { id: "order-to-cash" });
  assert.equal(o.owner.team, "team-order-management");
  assert.equal(o.owner.label, "Order Management"); // resolved from landscape/team-topology.tt
  assert.equal(o.owner.role, "Process Owner");
  const p0 = o.participants[0];
  assert.equal(p0.team, "team-payments-platform");
  assert.equal(p0.label, "Payments & Billing Platform"); // the participant branch resolves too
  assert.equal(p0.interaction, "x-as-a-service");
});

test("which_processes_use: impact search finds a participating team; misses succeed with a message", async () => {
  const hits = await callJson("which_processes_use", { query: "team-payments-platform" });
  assert.ok(Array.isArray(hits) && hits.some((h: { id: string }) => h.id === "order-to-cash"));
  const miss = await call("which_processes_use", { query: "nonexistent-system-xyz" });
  assert.ok(!miss.isError, "an empty result is a success sentence, not an error");
  assert.match(miss.text, /No process references 'nonexistent-system-xyz'/);
});

test("search_glossary: matches a term via a non-English synonym; misses succeed with a message", async () => {
  const m = await callJson("search_glossary", { term: "Bonitätsprüfung" });
  assert.ok(Array.isArray(m) && m.some((e: { term: string }) => e.term === "credit check"));
  const miss = await call("search_glossary", { term: "totally-unknown-word" });
  assert.ok(!miss.isError, "an empty result is a success sentence, not an error");
  assert.match(miss.text, /No glossary entry matches 'totally-unknown-word'/);
});
