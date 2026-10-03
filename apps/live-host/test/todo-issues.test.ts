/**
 * IssueTracker (GitHub adapter, src/adapters/github/issues.ts) — runs the REAL
 * createGitHubIssueTracker against the offline stub provider: label bootstrap
 * (idempotent), issue creation with the anchor block + attribution, list
 * mapping (anchor roundtrip, PR exclusion, process filter), close (attribution
 * comment first, then the state transition), element deep links (todoBody with
 * publicUrl), the attribution written in the designIQ wording and read back
 * in it AND the legacy one, and the missing-Issues-permission 403 → AppError
 * mapping.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { TodoAnchor } from "@designiq/contracts/todo-anchor";
import { AppError } from "@designiq/http-kit";

import {
  attributionLine,
  closeAttributionLine,
  createGitHubIssueTracker,
  parseAuthor,
  parseBody,
  rateLimitWait,
  retargetBody,
  todoBody,
} from "../src/adapters/github/issues.ts";
import { TrackerRateLimited } from "../src/ports/issue-tracker.ts";

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
  assert.equal(
    todo.body,
    "The threshold in the model looks outdated.",
    "the author's text comes back WITHOUT the platform markup",
  );
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
  assert.equal(hand.body, "no anchor block here", "a hand-filed body comes back whole");
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
  await assert.rejects(() => tracker.closeTodo(REPO, "1", "petra"), isPermissionError);
  await control({ issuesForbidden: false });
});

test("closeTodo: posts the attribution comment, then closes — the item leaves listTodos", async () => {
  const before = await tracker.listTodos(REPO);
  assert.ok(
    before.some((t) => t.id === "1"),
    "todo #1 is open before the close",
  );
  await tracker.closeTodo(REPO, "1", "petra");
  // attribution trail: the comment lands BEFORE the (bot-authored) state change
  const comments = (await (await fetch(`${STUB_URL}/repos/${REPO}/issues/1/comments`)).json()) as { body: string }[];
  assert.deepEqual(
    comments.map((c) => c.body),
    [closeAttributionLine("petra")],
  );
  const after = await tracker.listTodos(REPO);
  assert.equal(after.length, before.length - 1, "the closed item vanishes from the open list");
  assert.ok(after.every((t) => t.id !== "1"));
});

// ── todoBody deep links (pure — no stub involved) ────────────────────────────

const deepLinkInput = {
  title: "Check credit limits",
  body: "The threshold looks stale.",
  anchor: {
    process: "order-to-cash",
    file: "processes/order-to-cash/order-to-cash.bpmn",
    elements: [
      { id: "Task_CheckCredit", name: "Bonität prüfen" },
      { id: "Gateway 1", name: null },
    ],
    processVersion: null,
  },
  author: "petra",
};

test("todoBody: publicUrl adds one encoded editor deep link per anchored element, before the attribution", () => {
  const body = todoBody(deepLinkInput, { publicUrl: "https://design.example/", repoFullName: "acme/bpm-processes" });
  // the web app's process-editor route: /r/$owner/$repo/p/$processId?element=<id>
  assert.ok(
    body.includes(
      "📍 [Bonität prüfen](https://design.example/r/acme/bpm-processes/p/order-to-cash?element=Task_CheckCredit)",
    ),
    `named element links with its name:\n${body}`,
  );
  // a nameless element falls back to its id; ids are URL-encoded
  assert.ok(
    body.includes("📍 [Gateway 1](https://design.example/r/acme/bpm-processes/p/order-to-cash?element=Gateway%201)"),
    `nameless element links with its encoded id:\n${body}`,
  );
  assert.ok(body.indexOf("📍") < body.indexOf(attributionLine("petra")), "deep links precede the attribution line");
});

test("todoBody: the repo splits at the FIRST slash (GitLab subgroups stay in the repo segment)", () => {
  const body = todoBody(deepLinkInput, { publicUrl: "https://design.example", repoFullName: "group/sub/name" });
  assert.ok(body.includes("/r/group/sub%2Fname/p/order-to-cash"), `owner=group, repo=sub/name (encoded):\n${body}`);
});

test("todoBody: without publicUrl there is no deep-link line", () => {
  assert.ok(!todoBody(deepLinkInput).includes("📍"));
});

test("parseBody: inverts todoBody — anchor block, deep links and attribution stripped", () => {
  const stored = todoBody(deepLinkInput, { publicUrl: "https://design.example", repoFullName: "acme/bpm-processes" });
  assert.equal(parseBody(stored), "The threshold looks stale.");
  // an empty author text leaves nothing behind but the markup
  assert.equal(parseBody(todoBody({ ...deepLinkInput, body: "" })), "");
  // multi-paragraph text keeps its shape
  const multi = todoBody({ ...deepLinkInput, body: "First paragraph.\n\nSecond paragraph." });
  assert.equal(parseBody(multi), "First paragraph.\n\nSecond paragraph.");
  // a body that never went through todoBody is returned untouched
  assert.equal(parseBody("plain issue text"), "plain issue text");
});

test("parseBody: strips deep links with `]` in the element name and `)` in the URL", () => {
  const input = {
    ...deepLinkInput,
    // brackets in the name land RAW in the link text; parens in the process id
    // land in the URL — encodeURIComponent leaves them unescaped
    anchor: {
      ...deepLinkInput.anchor,
      process: "order (v2)",
      elements: [{ id: "Task_Check", name: "Prüfen [manuell]" }],
    },
  };
  const stored = todoBody(input, { publicUrl: "https://design.example", repoFullName: "acme/bpm-processes" });
  assert.ok(stored.includes("📍 [Prüfen [manuell]]"), `precondition — the raw name is in the link:\n${stored}`);
  assert.equal(parseBody(stored), "The threshold looks stale.");
});

// ── attribution wording: today's product name AND the legacy one ───────────
// spelled out as literals on purpose: these are the bodies as they sit in a
// customer's tracker — filed by this host, or by a host before the rename.
// The legacy name is spelled in two halves ON PURPOSE: a search/replace of the
// product name rewrites the regex and a one-piece fixture in the same breath,
// and every test stays green — this spelling it cannot reach.

const LEGACY_NAME = "bpm" + "iq";
const LEGACY_ATTRIBUTION = `_Created from the ${LEGACY_NAME} live model by @petra_`;
const ATTRIBUTION = "_Created from the designIQ live model by @petra_";

test("attributionLine / closeAttributionLine write the designIQ wording", () => {
  assert.equal(attributionLine("petra"), ATTRIBUTION);
  assert.equal(closeAttributionLine("petra"), "_Closed from the designIQ live model by @petra_");
});

/** a stored body as todoBody builds it, signed in the given attribution wording */
function storedWith(attribution: string): string {
  const stored = todoBody(deepLinkInput, { publicUrl: "https://design.example", repoFullName: "acme/bpm-processes" });
  const signed = stored.replace(attributionLine("petra"), attribution);
  // precondition — without it a failed swap would leave today's line in place and pass every read below
  assert.ok(signed.endsWith(`\n\n${attribution}`), `the body is signed in the wording under test:\n${signed}`);
  return signed;
}

test("parseAuthor: today's wording and the legacy wording both name the author", () => {
  assert.equal(parseAuthor(storedWith(LEGACY_ATTRIBUTION)), "petra");
  assert.equal(parseAuthor(storedWith(ATTRIBUTION)), "petra");
  // the new name re-cased (edited by hand on GitHub) keeps its author
  for (const name of ["designiq", "DesignIQ", "DESIGNIQ"]) {
    assert.equal(parseAuthor(storedWith(ATTRIBUTION.replace("designIQ", name))), "petra", name);
  }
  // the login pattern is the same in both wordings
  assert.equal(parseAuthor(`_Created from the ${LEGACY_NAME} live model by @octo-cat99_`), "octo-cat99");
  assert.equal(parseAuthor("_Created from the designIQ live model by @octo-cat99_"), "octo-cat99");
});

test("parseAuthor: a body with neither wording has no platform author", () => {
  assert.equal(parseAuthor("plain issue text"), null);
  assert.equal(parseAuthor("_Created from the acme live model by @petra_"), null, "another product name");
  // only the product name widened — the rest of the sentence still matches exactly
  assert.equal(parseAuthor("_created from the designIQ live model by @petra_"), null);
  assert.equal(parseAuthor("_Created from the designIQ model by @petra_"), null);
  assert.equal(parseAuthor("_Created from the design IQ live model by @petra_"), null);
  // … and the legacy spelling reads exactly as it always did (case-sensitive)
  assert.equal(parseAuthor("_Created from the BPMIQ live model by @petra_"), null); // legacy-name-ok: stored in customer trackers
  // the close comment is not a creation attribution, in either wording
  assert.equal(parseAuthor(closeAttributionLine("petra")), null);
  assert.equal(parseAuthor(`_Closed from the ${LEGACY_NAME} live model by @petra_`), null);
});

test("parseBody: strips the attribution line in today's and in the legacy wording", () => {
  assert.equal(parseBody(storedWith(LEGACY_ATTRIBUTION)), "The threshold looks stale.");
  assert.equal(parseBody(storedWith(ATTRIBUTION)), "The threshold looks stale.");
  assert.equal(parseBody(storedWith(ATTRIBUTION.replace("designIQ", "designiq"))), "The threshold looks stale.");
  // a line in neither wording is the author's own text and stays
  const foreign = "_Created from the acme live model by @petra_";
  assert.equal(parseBody(`The threshold looks stale.\n\n${foreign}`), `The threshold looks stale.\n\n${foreign}`);
});

test("listTodos: an issue a host filed before the rename keeps its author, anchor and clean body", async () => {
  const repo = "acme/legacy-name";
  await control({
    addIssue: { repo, title: "Filed before the rename", body: storedWith(LEGACY_ATTRIBUTION), labels: ["todo"] },
  });
  const [todo] = await tracker.listTodos(repo);
  assert.equal(todo?.author, "petra");
  assert.equal(todo?.body, "The threshold looks stale.");
  assert.deepEqual(todo?.anchor, deepLinkInput.anchor);
});

// ── retargetTodo (#208): a renamed process's todo follows its new id ────────

const RENAME_REPO = "acme/renames";
const linked = createGitHubIssueTracker({
  apiUrl: STUB_URL,
  tokenFor: async () => "stub-installation-token-1",
  publicUrl: "https://design.example",
});

test("retargetTodo: ONE write swaps the process label and re-anchors the body; a second run is a no-op", async () => {
  const created = await linked.createTodo(RENAME_REPO, {
    title: "Check the dunning step",
    body: "Reminder wording is outdated.",
    anchor: {
      process: "invoice-handling",
      file: "processes/sub/invoice-handling.bpmn",
      elements: [{ id: "Task_Remind", name: "Send reminder" }],
      processVersion: null,
    },
    author: "petra",
  });
  const writesBefore = ((await (await fetch(`${STUB_URL}/_control/writes`)).json()) as unknown[]).length;
  const moved = await linked.retargetTodo(RENAME_REPO, created.id, "invoice-handling", {
    process: "billing",
    file: "processes/sub/billing.bpmn",
  });
  assert.equal(moved, "moved");
  const writes = (await (await fetch(`${STUB_URL}/_control/writes`)).json()) as Array<{ labels?: string[] }>;
  assert.equal(writes.length - writesBefore, 1, "labels and body change in ONE PATCH");
  assert.deepEqual(writes.at(-1)?.labels, ["todo", "process:billing"]);

  assert.equal((await linked.listTodos(RENAME_REPO, "invoice-handling")).length, 0, "gone from the old process");
  const [todo] = await linked.listTodos(RENAME_REPO, "billing");
  assert.equal(todo?.id, created.id);
  assert.deepEqual(todo?.anchor, {
    process: "billing",
    file: "processes/sub/billing.bpmn",
    elements: [{ id: "Task_Remind", name: "Send reminder" }],
    processVersion: null,
  });
  assert.equal(todo?.body, "Reminder wording is outdated.", "the author's text is untouched");
  const raw = (await (await fetch(`${STUB_URL}/repos/${RENAME_REPO}/issues/${created.id}`)).json()) as {
    body: string;
  };
  assert.ok(raw.body.includes("https://design.example/r/acme/renames/p/billing?element=Task_Remind"), raw.body);
  assert.ok(!raw.body.includes("/p/invoice-handling"), "no deep link left on the old id");

  assert.equal(
    await linked.retargetTodo(RENAME_REPO, created.id, "invoice-handling", {
      process: "billing",
      file: "processes/sub/billing.bpmn",
    }),
    "unchanged",
  );
});

test("retargetTodo: a hand-filed item (no anchor) only changes its labels; other labels survive", async () => {
  await control({
    addIssue: { repo: RENAME_REPO, title: "by hand", body: "plain text", labels: ["todo", "process:a", "urgent"] },
  });
  const [item] = await linked.listTodos(RENAME_REPO, "a");
  assert.ok(item);
  await linked.retargetTodo(RENAME_REPO, item.id, "a", { process: "b", file: "processes/b.bpmn" });
  const raw = (await (await fetch(`${STUB_URL}/repos/${RENAME_REPO}/issues/${item.id}`)).json()) as {
    body: string;
    labels: Array<{ name: string }>;
  };
  assert.equal(raw.body, "plain text");
  assert.deepEqual(
    raw.labels.map((l) => l.name),
    ["todo", "urgent", "process:b"],
  );
});

test("retargetTodo: a secondary rate limit surfaces as TrackerRateLimited with the asked-for wait", async () => {
  const [item] = await linked.listTodos(RENAME_REPO, "b");
  assert.ok(item);
  await control({ rateLimitWrites: 1 });
  await assert.rejects(
    () => linked.retargetTodo(RENAME_REPO, item.id, "b", { process: "c", file: "processes/c.bpmn" }),
    (e: unknown) => e instanceof TrackerRateLimited && e.retryAfterMs === 1000,
  );
  // the next attempt goes through
  assert.equal(
    await linked.retargetTodo(RENAME_REPO, item.id, "b", { process: "c", file: "processes/c.bpmn" }),
    "moved",
  );
});

test("retargetBody: only a body anchored to `from` changes — anchor block and deep links, nothing else", () => {
  const body = todoBody(deepLinkInput, { publicUrl: "https://design.example", repoFullName: "acme/x" });
  const out = retargetBody(
    body,
    "order-to-cash",
    { process: "o2c", file: "processes/o2c.bpmn" },
    { publicUrl: "https://design.example", repoFullName: "acme/x" },
  );
  assert.equal(
    out,
    todoBody(
      { ...deepLinkInput, anchor: { ...deepLinkInput.anchor, process: "o2c", file: "processes/o2c.bpmn" } },
      { publicUrl: "https://design.example", repoFullName: "acme/x" },
    ),
  );
  assert.equal(retargetBody(body, "other", { process: "o2c", file: "x" }), body, "anchored elsewhere: untouched");
  assert.equal(retargetBody("hand-written", "order-to-cash", { process: "o2c", file: "x" }), "hand-written");
});

test("rateLimitWait: retry-after, an exhausted quota and the secondary message are waits; a plain 403 is not", () => {
  const res = (status: number, headers: Record<string, string>) => ({ status, headers: new Headers(headers) });
  assert.equal(rateLimitWait(res(403, { "retry-after": "30" }), ""), 30_000);
  assert.equal(rateLimitWait(res(429, {}), "You have exceeded a secondary rate limit"), 60_000);
  assert.equal(
    rateLimitWait(res(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1010" }), "", 1_000_000),
    10_000,
  );
  assert.equal(rateLimitWait(res(403, {}), "Resource not accessible by integration"), undefined);
  assert.equal(rateLimitWait(res(500, { "retry-after": "5" }), ""), undefined);
});
