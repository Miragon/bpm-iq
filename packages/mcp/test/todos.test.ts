/**
 * list_todos (packages/mcp/tools.ts) — the STRICTLY opt-in tracker tool.
 * Without BPM_TODOS_REPO + BPM_TODOS_TOKEN the tool must not exist (the server
 * stays zero-auth by default); with both set it lists open todos from a tiny
 * local GitHub-shaped HTTP stub: label filter (todo + process:<id>), PR-row
 * exclusion, anchor parsing via @bpmiq/contracts/todo-anchor, token forwarding.
 * Drives the REAL server over an in-memory transport, like tools.test.ts.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { encodeAnchor } from "@bpmiq/contracts/todo-anchor";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer, DEFAULT_ROOT, todosConfigFromEnv } from "../tools.ts";

const TRACKER_REPO = "acme/content";

// GitHub-shaped issue rows the stub serves — one anchored todo, one hand-filed
// todo (no anchor), one PR wearing the todo label, one non-todo issue, one
// CLOSED todo (must never appear: the tool queries state=open).
const anchorBlock = encodeAnchor({
  process: "order-to-cash",
  file: "processes/order-to-cash/order-to-cash.bpmn",
  elements: [{ id: "Task_CheckCredit", name: "Bonität prüfen" }],
  processVersion: "1.4.0",
});
const rows = [
  {
    number: 7,
    html_url: `https://example.test/${TRACKER_REPO}/issues/7`,
    title: "Check credit limits with finance",
    state: "open",
    body: `${anchorBlock}\n\nThe threshold looks stale.`,
    labels: [{ name: "todo" }, { name: "process:order-to-cash" }],
    assignees: [{ login: "petra" }],
    created_at: "2026-07-15T09:00:00Z",
  },
  {
    number: 8,
    html_url: `https://example.test/${TRACKER_REPO}/issues/8`,
    title: "Hand-filed todo",
    state: "open",
    body: "no anchor block here",
    labels: [{ name: "todo" }],
    assignees: [],
    created_at: "2026-07-15T10:00:00Z",
  },
  {
    number: 9,
    html_url: `https://example.test/${TRACKER_REPO}/pulls/9`,
    title: "A PR wearing the todo label",
    state: "open",
    body: "",
    labels: [{ name: "todo" }],
    assignees: [],
    created_at: "2026-07-15T11:00:00Z",
    pull_request: { url: `https://example.test/${TRACKER_REPO}/pulls/9` },
  },
  {
    number: 10,
    html_url: `https://example.test/${TRACKER_REPO}/issues/10`,
    title: "A plain bug, not a todo",
    state: "open",
    body: "",
    labels: [{ name: "bug" }],
    assignees: [],
    created_at: "2026-07-15T12:00:00Z",
  },
  {
    number: 11,
    html_url: `https://example.test/${TRACKER_REPO}/issues/11`,
    title: "Already done",
    state: "closed",
    body: "",
    labels: [{ name: "todo" }],
    assignees: [],
    created_at: "2026-07-15T13:00:00Z",
  },
];

let stub: Server;
let lastAuth: string | undefined;

before(async () => {
  // tiny GitHub-shaped stub: the issues list filters by state + labels (ALL
  // must match, like the real endpoint) and records the auth header
  stub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    lastAuth = req.headers.authorization;
    if (url.pathname !== `/repos/${TRACKER_REPO}/issues`) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "Not Found" }));
    }
    const state = url.searchParams.get("state") ?? "open";
    const wanted = (url.searchParams.get("labels") ?? "").split(",").filter(Boolean);
    const hits = rows.filter(
      (r) => (state === "all" || r.state === state) && wanted.every((w) => r.labels.some((l) => l.name === w)),
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(hits));
  });
  await new Promise<void>((resolve) => stub.listen(0, resolve));
});

after(() => {
  stub?.close();
});

/** fresh server+client pair over an in-memory transport — the env gate runs
 * through todosConfigFromEnv, exactly like the real entry points (server.ts, http.ts) */
async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(DEFAULT_ROOT, todosConfigFromEnv(process.env));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "todos-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function call(client: Client, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const r = await client.callTool({ name: "list_todos", arguments: args });
  const content = r.content as Array<{ type: string; text?: string }>;
  return { isError: Boolean(r.isError), text: content[0]?.text ?? "" };
}

test("zero-auth default: without BPM_TODOS_REPO + BPM_TODOS_TOKEN the tool does not exist", async () => {
  delete process.env.BPM_TODOS_REPO;
  delete process.env.BPM_TODOS_TOKEN;
  const { client, close } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes("list_todos"), "list_todos must not register without the opt-in env vars");
  await close();
});

test("opt-in: with both env vars set the tool registers (alongside the repo-local ten)", async () => {
  process.env.BPM_TODOS_REPO = TRACKER_REPO;
  process.env.BPM_TODOS_TOKEN = "test-token";
  process.env.GITHUB_API_URL = `http://localhost:${(stub.address() as AddressInfo).port}`;
  const { client, close } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("list_todos"));
  assert.equal(names.length, 11, "the ten repo-local tools stay untouched");
  await close();
});

test("list_todos: open todos with parsed anchors; PR rows excluded; the token is forwarded", async () => {
  const { client, close } = await connect();
  const { isError, text } = await call(client);
  assert.ok(!isError, text);
  const todos = JSON.parse(text) as Array<{
    id: string;
    url: string;
    title: string;
    anchor: { process: string; elements: Array<{ id: string; name: string | null }> } | null;
    assignees: string[];
    createdAt: string;
  }>;
  assert.deepEqual(
    todos.map((t) => t.id),
    ["7", "8"],
    "open todo-labeled issues only: no PR row, no non-todo, no closed",
  );
  const anchored = todos[0]!;
  assert.equal(anchored.url, `https://example.test/${TRACKER_REPO}/issues/7`);
  assert.equal(anchored.anchor?.process, "order-to-cash");
  assert.deepEqual(anchored.anchor?.elements, [{ id: "Task_CheckCredit", name: "Bonität prüfen" }]);
  assert.deepEqual(anchored.assignees, ["petra"]);
  assert.equal(anchored.createdAt, "2026-07-15T09:00:00Z");
  assert.equal(todos[1]!.anchor, null, "a hand-filed todo lists with anchor null");
  assert.equal(lastAuth, "Bearer test-token", "BPM_TODOS_TOKEN is forwarded as the bearer token");
  await close();
});

test("list_todos: the process argument narrows via the process:<id> label; misses succeed with a message", async () => {
  const { client, close } = await connect();
  const hit = await call(client, { process: "order-to-cash" });
  assert.ok(!hit.isError, hit.text);
  const todos = JSON.parse(hit.text) as Array<{ id: string }>;
  assert.deepEqual(
    todos.map((t) => t.id),
    ["7"],
  );
  const miss = await call(client, { process: "does-not-exist" });
  assert.ok(!miss.isError, "an empty result is a success sentence, not an error");
  assert.match(miss.text, /No open todos for process 'does-not-exist'/);
  await close();
});
