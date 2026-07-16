/**
 * bpm-mcp-server tool behaviour (packages/mcp/tools.ts). Drives the REAL server
 * over an in-memory transport — a linked Client↔Server pair, no stdio/HTTP boot —
 * so the tools are exercised exactly as an MCP client would. Content is a
 * self-contained slim fixture (bpmiq.yml + .bpmn files, no process.yaml): a
 * process IS a .bpmn, its view is DERIVED from the BPMN.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../tools.ts";

// ── slim content fixture: two BPMN processes, one calling the other ──────────
const ORDER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:collaboration id="C"><bpmn:participant id="Pool" name="Order to Cash" processRef="P"/></bpmn:collaboration>
  <bpmn:process id="P" name="Order to Cash">
    <bpmn:laneSet>
      <bpmn:lane id="L_Clerk" name="Clerk">
        <bpmn:flowNodeRef>Start</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Check</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Gw</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="L_Billing" name="Billing">
        <bpmn:flowNodeRef>Invoice</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>End</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start" name="Order received"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:userTask id="Check" name="Check credit limit"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:userTask>
    <bpmn:exclusiveGateway id="Gw" name="Approved?"><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing></bpmn:exclusiveGateway>
    <bpmn:callActivity id="Invoice" name="Handle invoice" calledElement="invoice-handling"><bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:callActivity>
    <bpmn:endEvent id="End" name="Cash collected"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="Check"/>
    <bpmn:sequenceFlow id="f2" sourceRef="Check" targetRef="Gw"/>
    <bpmn:sequenceFlow id="f3" sourceRef="Gw" targetRef="Invoice"/>
    <bpmn:sequenceFlow id="f4" sourceRef="Invoice" targetRef="End"/>
  </bpmn:process>
</bpmn:definitions>`;

const INVOICE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="INV" name="Invoice handling">
    <bpmn:startEvent id="s"><bpmn:outgoing>a</bpmn:outgoing></bpmn:startEvent>
    <bpmn:serviceTask id="send" name="Send invoice"><bpmn:incoming>a</bpmn:incoming><bpmn:outgoing>b</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:endEvent id="e"><bpmn:incoming>b</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="a" sourceRef="s" targetRef="send"/>
    <bpmn:sequenceFlow id="b" sourceRef="send" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;

function slimRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "bpm-mcp-"));
  writeFileSync(join(root, "bpmiq.yml"), "processes: processes\n");
  mkdirSync(join(root, "processes", "subprocesses"), { recursive: true });
  writeFileSync(join(root, "processes", "order-to-cash.bpmn"), ORDER_BPMN);
  writeFileSync(join(root, "processes", "subprocesses", "invoice-handling.bpmn"), INVOICE_BPMN);
  return root;
}

let client: Client;
let server: ReturnType<typeof createMcpServer>;

before(async () => {
  server = createMcpServer(slimRepo());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "mcp-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
  await server.close();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as Array<{ type: string; text?: string }>;
  return { isError: Boolean(r.isError), text: content[0]?.text ?? "" };
}

async function callJson(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { isError, text } = await call(name, args);
  assert.ok(!isError, `${name} unexpectedly errored: ${text}`);
  return JSON.parse(text);
}

test("registration: the seven read-only tools are exposed (no rich-layout tools)", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "enumerate_paths",
    "find_cycles",
    "get_model",
    "get_process",
    "list_processes",
    "which_processes_use",
    "who_owns",
  ]);
});

test("list_processes: one row per .bpmn with derived name + stats", async () => {
  const rows = await callJson("list_processes");
  const otc = rows.find((r: { id: string }) => r.id === "order-to-cash");
  assert.ok(otc, "order-to-cash is listed");
  assert.equal(otc.name, "Order to Cash"); // derived from the single pool
  assert.equal(otc.path, "processes/order-to-cash.bpmn");
  assert.ok(otc.steps >= 2 && otc.roles === 2);
  assert.ok(
    rows.some((r: { id: string }) => r.id === "invoice-handling"),
    "the nested sub-process file is discovered too",
  );
});

test("get_process: derived view — steps with roles, gateways, sub-process calls", async () => {
  const p = await callJson("get_process", { id: "order-to-cash" });
  assert.equal(p.name, "Order to Cash");
  assert.equal(p.path, "processes/order-to-cash.bpmn");
  assert.deepEqual(
    p.roles.map((r: { name: string }) => r.name),
    ["Clerk", "Billing"],
  );
  assert.equal(p.steps.find((s: { id: string }) => s.id === "Check")?.role, "Clerk");
  assert.deepEqual(p.calls, [{ id: "Invoice", name: "Handle invoice", calledElement: "invoice-handling" }]);
});

test("get_process: unknown id → isError listing what's available", async () => {
  const r = await call("get_process", { id: "does-not-exist" });
  assert.ok(r.isError);
  assert.match(r.text, /Unknown process 'does-not-exist'/);
  assert.match(r.text, /order-to-cash/);
});

test("get_model: parses the BPMN into a graph with real element names", async () => {
  const g = await callJson("get_model", { id: "order-to-cash" });
  assert.equal(g.file, "processes/order-to-cash.bpmn");
  assert.ok(g.nodes.some((n: { name?: string }) => n.name === "Check credit limit"));
  assert.ok(g.edges.length > 0);
});

test("enumerate_paths: returns start→end paths", async () => {
  const all = await callJson("enumerate_paths", { id: "order-to-cash" });
  assert.ok(all.pathCount >= 1);
  assert.ok(Array.isArray(all.paths[0]) && all.paths[0].length > 0);
});

test("find_cycles: the acyclic flow reports no cycles", async () => {
  const { isError, text } = await call("find_cycles", { id: "order-to-cash" });
  assert.ok(!isError);
  assert.match(text, /No cycles/);
});

test("who_owns: resolves owning roles from the BPMN lanes", async () => {
  const o = await callJson("who_owns", { id: "order-to-cash" });
  assert.deepEqual(
    o.roles.map((r: { role: string }) => r.role),
    ["Clerk", "Billing"],
  );
  const clerk = o.roles.find((r: { role: string }) => r.role === "Clerk");
  assert.ok(clerk.steps.includes("Check credit limit"));
});

test("who_owns: a process with no lanes reports no modeled owner", async () => {
  const { isError, text } = await call("who_owns", { id: "invoice-handling" });
  assert.ok(!isError);
  assert.match(text, /no lanes or pools/);
});

test("which_processes_use: finds the caller of a sub-process; misses succeed with a message", async () => {
  const hits = await callJson("which_processes_use", { query: "invoice-handling" });
  assert.ok(hits.some((h: { id: string }) => h.id === "order-to-cash"));
  const miss = await call("which_processes_use", { query: "nonexistent-xyz" });
  assert.ok(!miss.isError);
  assert.match(miss.text, /No process references 'nonexistent-xyz'/);
});

test("not a content repo: tools report the missing bpmiq.yml, never crash", async () => {
  const bare = mkdtempSync(join(tmpdir(), "bpm-mcp-bare-"));
  const s = createMcpServer(bare);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([s.connect(st), c.connect(ct)]);
  const r = await c.callTool({ name: "list_processes", arguments: {} });
  const text = (r.content as Array<{ text?: string }>)[0]?.text ?? "";
  assert.ok(r.isError);
  assert.match(text, /not a BPM content repo/);
  await c.close();
  await s.close();
});
