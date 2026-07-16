/**
 * IssueTracker (GitHub adapter, src/adapters/github/issues.ts) — runs the REAL
 * createGitHubIssueTracker against the offline stub provider: label bootstrap
 * (idempotent), issue creation with the anchor block + attribution, list
 * mapping (anchor roundtrip, PR exclusion, process filter), and the
 * missing-Issues-permission 403 → AppError mapping.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { AppError } from "@bpmiq/http-kit";

import { createGitHubIssueTracker } from "../src/adapters/github/issues.ts";
import type { TodoAnchor } from "../src/domain/todo-anchor.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_PORT = Number(process.env.TODO_STUB_PORT ?? 8531);
const STUB_URL = `http://localhost:${STUB_PORT}`;
const REPO = "acme/bpm-processes";

// tokenFor is the injected seam (server.ts composes registry → TokenService);
// the stub never verifies issue-route tokens, a static one exercises the path
const tracker = createGitHubIssueTracker({ apiUrl: STUB_URL, tokenFor: async () => "stub-installation-token-1" });

const anchorOf = (process: string): TodoAnchor => ({
  process,
  file: `processes/${process}/${process}.bpmn`,
  elements: [{ id: "Task_CheckCredit", name: "Bonität prüfen" }],
  processVersion: "1.4.0",
});

let stub: ChildProcess;
async function control(body: unknown): Promise<void> {
  const res = await fetch(`${STUB_URL}/_control`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`_control failed: ${res.status}`);
}

before(async () => {
  stub = spawn(process.execPath, [join(HERE, "stub-provider.ts")], {
    env: { ...process.env, STUB_PORT: String(STUB_PORT) },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${STUB_URL}/_control`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

after(() => {
  stub?.kill();
});

test("createTodo: bootstraps labels, creates the issue, returns the mapped Todo", async () => {
  const todo = await tracker.createTodo(REPO, {
    title: "Check credit limits with finance",
    body: "The threshold in the model looks outdated.",
    anchor: anchorOf("order-to-cash"),
    author: "petra",
  });
  assert.equal(todo.id, "1");
  assert.ok(todo.url.includes(`/${REPO}/issues/1`));
  assert.equal(todo.title, "Check credit limits with finance");
  assert.equal(todo.state, "open");
  assert.deepEqual(todo.anchor, anchorOf("order-to-cash"), "anchor round-trips through the issue body");
  assert.equal(todo.author, "petra", "author parsed back from the attribution line");
  assert.deepEqual(todo.assignees, []);
  assert.ok(!Number.isNaN(Date.parse(todo.createdAt)), "createdAt is a timestamp");

  // labels were created in the tracker
  const labels = (await (await fetch(`${STUB_URL}/repos/${REPO}/labels`)).json()) as Array<{ name: string }>;
  assert.deepEqual(labels.map((l) => l.name).sort(), ["process:order-to-cash", "todo"]);
});

test("createTodo: a second todo for the same process tolerates already-existing labels", async () => {
  const todo = await tracker.createTodo(REPO, {
    title: "Rename the credit task",
    body: "",
    anchor: anchorOf("order-to-cash"),
    author: "kai",
  });
  assert.equal(todo.id, "2");
  assert.equal(todo.author, "kai");
});

test("listTodos: returns the open todos with parsed anchors", async () => {
  const todos = await tracker.listTodos(REPO);
  assert.equal(todos.length, 2);
  assert.deepEqual(todos.map((t) => t.id).sort(), ["1", "2"]);
  assert.ok(todos.every((t) => t.anchor?.process === "order-to-cash"));
});

test("listTodos: pull requests wearing the todo label are excluded", async () => {
  await control({
    addIssue: { repo: REPO, title: "A PR wearing the todo label", labels: ["todo"], pull_request: true },
  });
  const todos = await tracker.listTodos(REPO);
  assert.equal(todos.length, 2, "the PR row is filtered out");
  assert.ok(todos.every((t) => t.title !== "A PR wearing the todo label"));
});

test("listTodos: a hand-written issue without an anchor still lists (anchor/author null)", async () => {
  await control({ addIssue: { repo: REPO, title: "Hand-filed todo", body: "no anchor block here", labels: ["todo"] } });
  const hand = (await tracker.listTodos(REPO)).find((t) => t.title === "Hand-filed todo");
  assert.ok(hand);
  assert.equal(hand.anchor, null);
  assert.equal(hand.author, null);
});

test("listTodos: the process filter narrows via the process label", async () => {
  await tracker.createTodo(REPO, {
    title: "Clarify onboarding hand-over",
    body: "",
    anchor: anchorOf("hire-to-retire"),
    author: "petra",
  });
  const all = await tracker.listTodos(REPO);
  const filtered = await tracker.listTodos(REPO, "hire-to-retire");
  assert.equal(all.length, 4);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.anchor?.process, "hire-to-retire");
});

test("upstream 403 'Resource not accessible' maps to a clear missing-permission AppError", async () => {
  await control({ issuesForbidden: true });
  const isPermissionError = (e: unknown): boolean =>
    e instanceof AppError &&
    e.code === "todos/issues-permission-missing" &&
    e.status === 403 &&
    /existing installations/i.test(e.message);
  await assert.rejects(() => tracker.listTodos(REPO), isPermissionError);
  await assert.rejects(
    () => tracker.createTodo(REPO, { title: "x", body: "", anchor: anchorOf("p"), author: "a" }),
    isPermissionError,
  );
  await control({ issuesForbidden: false });
});
