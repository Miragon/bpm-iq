/**
 * Create-side use-cases (src/application/scaffold.ts) — folder listing/creation
 * and process creation against a tmpdir workspace, plus the blank-diagram
 * template (src/domain/bpmn-template.ts). Gates are typed AppErrors, mirroring
 * the release/sync test conventions.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AppError } from "@bpmiq/http-kit";

import { createDecision, createFolder, createProcess, listFolders } from "../src/application/scaffold.ts";
import { escapeXml, newBpmnXml, xmlProcessId } from "../src/domain/bpmn-template.ts";
import { newDmnXml } from "../src/domain/dmn-template.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};

/** a content-repo workspace: bpmiq.yml + one nested process */
function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "bpm-scaffold-"));
  writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
  mkdirSync(join(ws, "processes", "subprocesses"), { recursive: true });
  writeFileSync(join(ws, "processes", "order.bpmn"), "<bpmn/>");
  writeFileSync(join(ws, "processes", "subprocesses", "check-credit.bpmn"), "<bpmn/>");
  return ws;
}

const rejectsWith = (code: string, status: number) => (e: unknown) => {
  assert.ok(e instanceof AppError, `expected AppError, got ${String(e)}`);
  assert.equal(e.code, code);
  assert.equal(e.status, status);
  return true;
};

// ── listFolders ─────────────────────────────────────────────────────────────

test("listFolders: every folder under the processes root, empty ones included", async () => {
  const ws = workspace();
  mkdirSync(join(ws, "processes", "orders", "archive"), { recursive: true }); // empty nested
  mkdirSync(join(ws, "processes", ".hidden")); // dot → invisible
  mkdirSync(join(ws, "processes", "node_modules")); // noise → invisible
  assert.deepEqual(await listFolders(ws), {
    isContentRepo: true,
    folders: ["orders", "orders/archive", "subprocesses"],
  });
});

test("listFolders: no bpmiq.yml → not a content repo; missing folder still is one", async () => {
  const empty = mkdtempSync(join(tmpdir(), "bpm-scaffold-empty-"));
  assert.deepEqual(await listFolders(empty), { isContentRepo: false, folders: [] });
  // a bpmiq.yml whose processes folder does not exist yet is still a content
  // repo — an empty tree, not a missing config (create would just mkdir it)
  writeFileSync(join(empty, "bpmiq.yml"), "processes: not-there\n");
  assert.deepEqual(await listFolders(empty), { isContentRepo: true, folders: [] });
});

// ── createFolder ────────────────────────────────────────────────────────────

test("createFolder: creates (nested) and normalizes the path", async () => {
  const ws = workspace();
  assert.equal(await createFolder(REPO, ws, "orders/archive/"), "orders/archive");
  assert.ok(existsSync(join(ws, "processes", "orders", "archive")));
  assert.deepEqual(await listFolders(ws), {
    isContentRepo: true,
    folders: ["orders", "orders/archive", "subprocesses"],
  });
});

test("createFolder: rejects invalid names, traversal and noise segments", async () => {
  const ws = workspace();
  for (const bad of ["", "   ", ".hidden", "a/../b", "..", "node_modules", "a b", "a//b", "ä"]) {
    await assert.rejects(() => createFolder(REPO, ws, bad), rejectsWith("scaffold/invalid-folder", 400), bad);
  }
});

test("createFolder: an existing folder (or file of that name) is a 409", async () => {
  const ws = workspace();
  await assert.rejects(() => createFolder(REPO, ws, "subprocesses"), rejectsWith("scaffold/folder-exists", 409));
  await assert.rejects(() => createFolder(REPO, ws, "order.bpmn"), rejectsWith("scaffold/folder-exists", 409));
});

test("createFolder/createProcess: a path segment that is a FILE is a 409, not a 500", async () => {
  const ws = workspace();
  await assert.rejects(() => createFolder(REPO, ws, "order.bpmn/sub"), rejectsWith("scaffold/conflict", 409));
  await assert.rejects(
    () => createProcess(REPO, ws, { name: "Nested", folder: "order.bpmn" }),
    rejectsWith("scaffold/conflict", 409),
  );
});

test("createFolder/createProcess: a symlinked folder escaping the checkout is refused", async () => {
  const ws = workspace();
  const outside = mkdtempSync(join(tmpdir(), "bpm-scaffold-outside-"));
  symlinkSync(outside, join(ws, "processes", "evil"));
  await assert.rejects(() => createFolder(REPO, ws, "evil/sub"), rejectsWith("scaffold/outside-processes-root", 400));
  await assert.rejects(
    () => createProcess(REPO, ws, { name: "Escape", folder: "evil" }),
    rejectsWith("scaffold/outside-processes-root", 400),
  );
  assert.ok(!existsSync(join(outside, "sub")), "nothing was written outside the workspace");
  assert.ok(!existsSync(join(outside, "escape.bpmn")), "nothing was written outside the workspace");
});

test("createFolder: a repo without bpmiq.yml is a 422", async () => {
  const empty = mkdtempSync(join(tmpdir(), "bpm-scaffold-nocfg-"));
  await assert.rejects(() => createFolder(REPO, empty, "orders"), rejectsWith("scaffold/not-a-content-repo", 422));
});

// ── createProcess ───────────────────────────────────────────────────────────

test("createProcess: writes the template and returns the wire row (dirty)", async () => {
  const ws = workspace();
  const created = await createProcess(REPO, ws, { name: "Order to Cash", folder: "orders" });
  assert.deepEqual(created, {
    repo: "acme/models",
    id: "order-to-cash",
    name: "order-to-cash",
    bpmn: "processes/orders/order-to-cash.bpmn",
    models: [{ notation: "bpmn", path: "processes/orders/order-to-cash.bpmn" }],
    folder: "orders",
    dirty: true,
    liveSessions: 0,
  });
  const xml = readFileSync(join(ws, "processes", "orders", "order-to-cash.bpmn"), "utf8");
  assert.match(xml, /<bpmn:process id="order-to-cash" name="Order to Cash" isExecutable="false">/);
  assert.match(xml, /<bpmn:participant [^>]*name="Order to Cash"/, "pool name carries the title (derived view)");
  assert.match(xml, /<bpmndi:BPMNEdge id="Flow_1_di"/, "complete BPMNDI (start, end, flow)");
});

test("createProcess: slugs the title with the shared rule (umlauts, punctuation)", async () => {
  const ws = workspace();
  const created = await createProcess(REPO, ws, { name: "  Auftrags-Prüfung (v2)!  " });
  assert.equal(created.id, "auftrags-prufung-v2");
  assert.equal(created.folder, "");
  assert.equal(created.bpmn, "processes/auftrags-prufung-v2.bpmn");
});

test("createProcess: a name without letters/digits is a 400", async () => {
  const ws = workspace();
  await assert.rejects(() => createProcess(REPO, ws, { name: "!!!" }), rejectsWith("scaffold/invalid-name", 400));
});

test("createProcess: duplicate id in ANY folder is a 409 (ids are repo-wide)", async () => {
  const ws = workspace();
  await assert.rejects(
    () => createProcess(REPO, ws, { name: "Check Credit", folder: "orders" }),
    rejectsWith("scaffold/process-exists", 409),
  );
  assert.ok(!existsSync(join(ws, "processes", "orders")), "nothing is created on a refused duplicate");
});

test("createProcess: invalid folder and missing config gate like createFolder", async () => {
  const ws = workspace();
  await assert.rejects(
    () => createProcess(REPO, ws, { name: "Ok", folder: "../out" }),
    rejectsWith("scaffold/invalid-folder", 400),
  );
  const empty = mkdtempSync(join(tmpdir(), "bpm-scaffold-nocfg2-"));
  await assert.rejects(
    () => createProcess(REPO, empty, { name: "Ok" }),
    rejectsWith("scaffold/not-a-content-repo", 422),
  );
});

test("createProcess: processes root at '.' works (config 'processes: .')", async () => {
  const ws = mkdtempSync(join(tmpdir(), "bpm-scaffold-root-"));
  writeFileSync(join(ws, "bpmiq.yml"), "processes: .\n");
  const created = await createProcess(REPO, ws, { name: "Intake" });
  assert.equal(created.bpmn, "intake.bpmn");
  assert.equal(created.folder, "");
  assert.ok(existsSync(join(ws, "intake.bpmn")));
});

// ── createDecision ──────────────────────────────────────────────────────────

test("createDecision: writes the template and returns the wire row (dirty)", async () => {
  const ws = workspace();
  const created = await createDecision(REPO, ws, { name: "Credit Check", folder: "orders" });
  assert.deepEqual(created, {
    repo: "acme/models",
    id: "credit-check",
    name: "credit-check",
    path: "processes/orders/credit-check.dmn",
    folder: "orders",
    dirty: true,
    liveSessions: 0,
  });
  const xml = readFileSync(join(ws, "processes", "orders", "credit-check.dmn"), "utf8");
  assert.match(xml, /<decision id="credit-check" name="Credit Check">/);
  assert.match(xml, /<decisionTable id="DecisionTable_credit-check"/, "starts as a decision table");
  assert.match(xml, /<dmndi:DMNShape [^>]*dmnElementRef="credit-check"/, "DMNDI present (DRD renders)");
});

test("createDecision: duplicate .dmn stem in ANY folder is a 409; a same-named PROCESS is not", async () => {
  const ws = workspace();
  await createDecision(REPO, ws, { name: "Credit Check", folder: "orders" });
  await assert.rejects(
    () => createDecision(REPO, ws, { name: "Credit Check" }),
    rejectsWith("scaffold/decision-exists", 409),
  );
  // process ids and decision ids are separate namespaces (different extensions)
  const sameStem = await createDecision(REPO, ws, { name: "Order" });
  assert.equal(sameStem.path, "processes/order.dmn");
});

test("createDecision: invalid name/folder and missing config gate like createProcess", async () => {
  const ws = workspace();
  await assert.rejects(() => createDecision(REPO, ws, { name: "!!!" }), rejectsWith("scaffold/invalid-name", 400));
  await assert.rejects(
    () => createDecision(REPO, ws, { name: "Ok", folder: "../out" }),
    rejectsWith("scaffold/invalid-folder", 400),
  );
  const empty = mkdtempSync(join(tmpdir(), "bpm-scaffold-nocfg3-"));
  await assert.rejects(
    () => createDecision(REPO, empty, { name: "Ok" }),
    rejectsWith("scaffold/not-a-content-repo", 422),
  );
});

test("createDecision: a symlinked folder escaping the checkout is refused", async () => {
  const ws = workspace();
  const outside = mkdtempSync(join(tmpdir(), "bpm-scaffold-outside2-"));
  symlinkSync(outside, join(ws, "processes", "evil"));
  await assert.rejects(
    () => createDecision(REPO, ws, { name: "Escape", folder: "evil" }),
    rejectsWith("scaffold/outside-processes-root", 400),
  );
  assert.ok(!existsSync(join(outside, "escape.dmn")), "nothing was written outside the workspace");
});

// ── blank-diagram template ──────────────────────────────────────────────────

test("dmn template: XML ids stay NCNames for digit-leading stems; title is escaped", () => {
  const xml = newDmnXml("2nd-check", `Tom & Jerry's "Check"`);
  assert.match(xml, /<decision id="p-2nd-check" name="Tom &amp; Jerry's &quot;Check&quot;">/);
  assert.match(xml, /dmnElementRef="p-2nd-check"/);
});

test("template: XML ids stay NCNames for digit-leading stems; title is escaped", () => {
  assert.equal(xmlProcessId("order-to-cash"), "order-to-cash");
  assert.equal(xmlProcessId("2nd-level-support"), "p-2nd-level-support");
  assert.equal(escapeXml(`a & <b> "c"`), "a &amp; &lt;b&gt; &quot;c&quot;");
  const xml = newBpmnXml("2nd-level-support", `Tom & Jerry's "Support"`);
  assert.match(xml, /<bpmn:process id="p-2nd-level-support" name="Tom &amp; Jerry's &quot;Support&quot;"/);
  assert.match(xml, /processRef="p-2nd-level-support"/);
});
