/**
 * Create-side use-cases (src/application/scaffold.ts) — folder listing/creation
 * and process creation against a tmpdir workspace, plus the blank-diagram
 * template (src/domain/bpmn-template.ts). Gates are typed AppErrors, mirroring
 * the release/sync test conventions.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CONTENT_KEY } from "@bpmiq/contracts/live";
import { AppError } from "@bpmiq/http-kit";
import * as Y from "yjs";

import {
  createDecision,
  createFolder,
  createNotationModel,
  createProcess,
  deleteModels,
  duplicateModel,
  listFolders,
  moveModels,
  type RenameDeps,
  renameModel,
} from "../src/application/scaffold.ts";
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

// ── createNotationModel (#139): the registry-generic create ─────────────────

test("createNotationModel: creates a wardley map from the blank template, ModelInfo row, opens under the models root", async () => {
  const ws = workspace();
  const created = await createNotationModel(REPO, ws, {
    notation: "wardley",
    name: "Platform Landscape",
    folder: "maps",
  });
  assert.equal(created.id, "platform-landscape");
  assert.equal(created.notation, "wardley");
  assert.equal(created.path, "processes/maps/platform-landscape.owm");
  assert.equal(created.folder, "maps");
  assert.equal(created.dirty, true);
  assert.equal(readFileSync(join(ws, created.path), "utf8"), "title Platform Landscape\n");
});

test("createNotationModel: team topology template is valid JSON matching the modeler's canonical shape", async () => {
  const ws = workspace();
  const created = await createNotationModel(REPO, ws, { notation: "team-topology", name: "Team Landscape" });
  assert.equal(created.path, "processes/team-landscape.tt");
  const doc = JSON.parse(readFileSync(join(ws, created.path), "utf8")) as Record<string, unknown>;
  assert.deepEqual(doc, { version: 3, title: "Team Landscape", nodes: [], interactions: [], flows: [] });
});

test("createNotationModel: event storming board from the title-only .storm template", async () => {
  const ws = workspace();
  const created = await createNotationModel(REPO, ws, { notation: "event-storming", name: "Order Checkout" });
  assert.equal(created.path, "processes/order-checkout.storm");
  assert.equal(created.notation, "event-storming");
  assert.equal(readFileSync(join(ws, created.path), "utf8"), "title Order Checkout\n");
});

test("createNotationModel: context map from the schema-model's canonical empty document", async () => {
  const ws = workspace();
  const created = await createNotationModel(REPO, ws, { notation: "context-map", name: "Conference Planner" });
  assert.equal(created.path, "processes/conference-planner.cm.json");
  assert.equal(created.notation, "context-map");
  assert.equal(created.id, "conference-planner");
  const doc = JSON.parse(readFileSync(join(ws, created.path), "utf8")) as Record<string, unknown>;
  assert.deepEqual(doc, { version: 1, title: "Conference Planner", contexts: [], relationships: [] });
});

test("createNotationModel: stems are unique PER NOTATION — a wardley map may share a stem with a bpmn process", async () => {
  const ws = workspace(); // workspace() already has processes/order.bpmn
  const created = await createNotationModel(REPO, ws, { notation: "wardley", name: "Order" });
  assert.equal(created.path, "processes/order.owm");
  // …but a SECOND wardley 'order' in another folder is refused
  await assert.rejects(
    () => createNotationModel(REPO, ws, { notation: "wardley", name: "Order", folder: "maps" }),
    rejectsWith("scaffold/model-exists", 409),
  );
});

test("createNotationModel: unknown notation and template-less notation are 422s", async () => {
  const ws = workspace();
  await assert.rejects(
    () => createNotationModel(REPO, ws, { notation: "uml", name: "Nope" }),
    rejectsWith("scaffold/unknown-notation", 422),
  );
  // value-chain is registered but has NO template — git-only by design
  await assert.rejects(
    () => createNotationModel(REPO, ws, { notation: "value-chain", name: "Nope" }),
    rejectsWith("scaffold/no-template", 422),
  );
});

test("createNotationModel: markdown documents are creatable (a first-class notation)", async () => {
  const ws = workspace();
  const created = await createNotationModel(REPO, ws, { notation: "markdown", name: "Architecture Notes" });
  assert.equal(created.path, "processes/architecture-notes.md");
  assert.equal(readFileSync(join(ws, created.path), "utf8"), "# Architecture Notes\n");
});

// ── moveModels (#182) ───────────────────────────────────────────────────────

/** a spy MoveDeps: the rooms currently live + every lineage rename */
function moveDeps(live: string[] = []) {
  const renamed: Array<[string, string]> = [];
  return {
    renamed,
    deps: { liveDocs: () => live, renameLineage: (from: string, to: string) => renamed.push([from, to]) },
  };
}

test("moveModels: a model moves into a (new) folder with its lineage, and back to the root", async () => {
  const ws = workspace();
  const { renamed, deps } = moveDeps();
  const out = await moveModels(REPO, ws, { paths: ["processes/order.bpmn"], folder: "sales/orders" }, deps);
  assert.deepEqual(out.moved, [{ from: "processes/order.bpmn", to: "processes/sales/orders/order.bpmn" }]);
  assert.ok(!existsSync(join(ws, "processes", "order.bpmn")));
  assert.equal(readFileSync(join(ws, "processes", "sales", "orders", "order.bpmn"), "utf8"), "<bpmn/>");
  assert.deepEqual(renamed, [["acme/models/processes/order.bpmn", "acme/models/processes/sales/orders/order.bpmn"]]);
  const back = await moveModels(REPO, ws, { paths: ["processes/sales/orders/order.bpmn"], folder: "" }, deps);
  assert.deepEqual(back.moved, [{ from: "processes/sales/orders/order.bpmn", to: "processes/order.bpmn" }]);
  assert.ok(existsSync(join(ws, "processes", "order.bpmn")));
});

test("moveModels: a decision takes its tests sidecar along; a model already there is skipped", async () => {
  const ws = workspace();
  writeFileSync(join(ws, "processes", "credit.dmn"), "<dmn/>");
  writeFileSync(join(ws, "processes", "credit.tests.yaml"), "cases: []\n");
  const { renamed, deps } = moveDeps();
  const out = await moveModels(
    REPO,
    ws,
    { paths: ["processes/credit.dmn", "processes/subprocesses/check-credit.bpmn"], folder: "subprocesses" },
    deps,
  );
  assert.deepEqual(out.moved, [
    { from: "processes/credit.dmn", to: "processes/subprocesses/credit.dmn" },
    { from: "processes/credit.tests.yaml", to: "processes/subprocesses/credit.tests.yaml" },
  ]);
  assert.equal(readFileSync(join(ws, "processes", "subprocesses", "credit.tests.yaml"), "utf8"), "cases: []\n");
  assert.equal(renamed.length, 2);
});

test("moveModels: an open model is refused (409) and NOTHING moves — nor any other file of the batch", async () => {
  const ws = workspace();
  const { renamed, deps } = moveDeps(["acme/models/processes/subprocesses/check-credit.bpmn"]);
  await assert.rejects(
    () =>
      moveModels(
        REPO,
        ws,
        { paths: ["processes/order.bpmn", "processes/subprocesses/check-credit.bpmn"], folder: "archive" },
        deps,
      ),
    rejectsWith("move/live-session", 409),
  );
  assert.ok(existsSync(join(ws, "processes", "order.bpmn")), "the first file of the batch stayed");
  assert.ok(!existsSync(join(ws, "processes", "archive")), "not even the target folder was created");
  assert.deepEqual(renamed, []);
});

test("moveModels: an occupied destination is a 409 and nothing moves (an orphaned tests sidecar in the target)", async () => {
  const ws = workspace();
  writeFileSync(join(ws, "processes", "credit.dmn"), "<dmn/>");
  writeFileSync(join(ws, "processes", "credit.tests.yaml"), "cases: []\n");
  mkdirSync(join(ws, "processes", "archive"));
  writeFileSync(join(ws, "processes", "archive", "credit.tests.yaml"), "orphan\n");
  await assert.rejects(
    () => moveModels(REPO, ws, { paths: ["processes/credit.dmn"], folder: "archive" }, moveDeps().deps),
    rejectsWith("move/target-exists", 409),
  );
  assert.ok(existsSync(join(ws, "processes", "credit.dmn")), "the decision stayed");
  assert.equal(readFileSync(join(ws, "processes", "archive", "credit.tests.yaml"), "utf8"), "orphan\n");
});

test("moveModels: only discovered models move — foreign files, traversal and bad folders are refused", async () => {
  const ws = workspace();
  const { deps } = moveDeps();
  for (const path of ["bpmiq.yml", "processes/../bpmiq.yml", "processes/missing.bpmn"]) {
    await assert.rejects(
      () => moveModels(REPO, ws, { paths: [path], folder: "archive" }, deps),
      rejectsWith("move/unknown-model", 404),
      path,
    );
  }
  await assert.rejects(
    () => moveModels(REPO, ws, { paths: ["processes/order.bpmn"], folder: "../outside" }, deps),
    rejectsWith("scaffold/invalid-folder", 400),
  );
  await assert.rejects(
    () => moveModels(REPO, ws, { paths: [], folder: "archive" }, deps),
    rejectsWith("move/no-paths", 400),
  );
});

test("moveModels: the moves are journaled for the release pairing (#208)", async () => {
  const ws = workspace();
  const journaled: Array<{ from: string; to: string }> = [];
  await moveModels(
    REPO,
    ws,
    { paths: ["processes/order.bpmn"], folder: "archive" },
    { ...moveDeps().deps, recordRenames: async (pairs) => void journaled.push(...pairs) },
  );
  assert.deepEqual(journaled, [{ from: "processes/order.bpmn", to: "processes/archive/order.bpmn" }]);
});

// ── renameModel (#208) ──────────────────────────────────────────────────────

const callerXml = (calls: string, decides: string) =>
  `<definitions><process id="caller"><callActivity id="Call_1" calledElement="${calls}" /><businessRuleTask id="Rule_1" decisionRef="${decides}" /></process></definitions>`;

/** a spy RenameDeps over an in-memory "live content" of the callers */
function renameDeps(opts: { live?: Record<string, string>; failEdit?: string[] } = {}) {
  const ws = { retired: [] as Array<[string, string]>, held: [] as string[][], released: 0 };
  const lineage = { saved: [] as string[], dropped: [] as string[], renamed: [] as Array<[string, string]> };
  const edits = new Map<string, string>();
  const journaled: Array<{ from: string; to: string }> = [];
  const deps = (root: string): RenameDeps => ({
    liveDocs: () => Object.keys(opts.live ?? {}),
    rooms: {
      retire: (room, notice) => {
        ws.retired.push([room, notice]);
        const content = opts.live?.[room];
        if (content === undefined) return undefined;
        const doc = new Y.Doc();
        doc.getText(CONTENT_KEY).insert(0, content);
        return Y.encodeStateAsUpdate(doc);
      },
      hold: (rooms) => {
        ws.held.push(rooms);
        return () => void ws.released++;
      },
    },
    lineage: {
      save: (room) => void lineage.saved.push(room),
      drop: (room) => void lineage.dropped.push(room),
      rename: (from, to) => void lineage.renamed.push([from, to]),
    },
    editContent: async (path, edit) => {
      if (opts.failEdit?.includes(path)) throw new Error("boom");
      edits.set(path, edit(readFileSync(join(root, path), "utf8")));
    },
    recordRenames: async (pairs) => void journaled.push(...pairs),
  });
  return { ws, lineage, edits, journaled, deps };
}

test("renameModel: a closed process gets a new stem, its lineage follows and its callers are rewritten", async () => {
  const ws = workspace();
  writeFileSync(join(ws, "processes", "main.bpmn"), callerXml("check-credit", "none"));
  const spy = renameDeps();
  const out = await renameModel(
    REPO,
    ws,
    { path: "processes/subprocesses/check-credit.bpmn", name: "Credit Check" },
    "Petra",
    spy.deps(ws),
  );
  assert.equal(out.id, "credit-check");
  assert.equal(out.path, "processes/subprocesses/credit-check.bpmn");
  assert.deepEqual(out.renamed, [
    { from: "processes/subprocesses/check-credit.bpmn", to: "processes/subprocesses/credit-check.bpmn" },
  ]);
  assert.ok(!existsSync(join(ws, "processes", "subprocesses", "check-credit.bpmn")));
  assert.equal(readFileSync(join(ws, "processes", "subprocesses", "credit-check.bpmn"), "utf8"), "<bpmn/>");
  assert.deepEqual(spy.lineage.renamed, [
    ["acme/models/processes/subprocesses/check-credit.bpmn", "acme/models/processes/subprocesses/credit-check.bpmn"],
  ]);
  assert.deepEqual(out.updatedReferences, ["processes/main.bpmn"]);
  assert.deepEqual(out.failedReferences, []);
  assert.match(spy.edits.get("processes/main.bpmn") ?? "", /calledElement="credit-check"/);
  assert.deepEqual(spy.journaled, out.renamed);
  // the new room was held while the file moved, and released again
  assert.deepEqual(spy.ws.held, [["acme/models/processes/subprocesses/credit-check.bpmn"]]);
  assert.equal(spy.ws.released, 1);
});

test("renameModel: an OPEN decision migrates — notice, final live state to disk + lineage, sidecar along", async () => {
  const ws = workspace();
  writeFileSync(join(ws, "processes", "credit.dmn"), "<dmn>on disk</dmn>");
  writeFileSync(join(ws, "processes", "credit.tests.yaml"), "cases: []\n");
  writeFileSync(join(ws, "processes", "main.bpmn"), callerXml("order", "credit"));
  const spy = renameDeps({ live: { "acme/models/processes/credit.dmn": "<dmn>live, not yet written</dmn>" } });
  const out = await renameModel(
    REPO,
    ws,
    { path: "processes/credit.dmn", name: "credit-limit" },
    "Petra",
    spy.deps(ws),
  );
  assert.deepEqual(out.renamed, [
    { from: "processes/credit.dmn", to: "processes/credit-limit.dmn" },
    { from: "processes/credit.tests.yaml", to: "processes/credit-limit.tests.yaml" },
  ]);
  // the retired room's peers were told where the document went
  assert.deepEqual(spy.ws.retired[0], [
    "acme/models/processes/credit.dmn",
    JSON.stringify({
      type: "bpmiq/moved",
      to: "processes/credit-limit.dmn",
      room: "acme/models/processes/credit-limit.dmn",
      by: "Petra",
    }),
  ]);
  // the LIVE state (ahead of the debounced write-through) is what lands
  assert.equal(readFileSync(join(ws, "processes", "credit-limit.dmn"), "utf8"), "<dmn>live, not yet written</dmn>");
  assert.deepEqual(spy.lineage.saved, ["acme/models/processes/credit-limit.dmn"]);
  assert.deepEqual(spy.lineage.dropped, ["acme/models/processes/credit.dmn"]);
  // the closed sidecar simply took its lineage along
  assert.deepEqual(spy.lineage.renamed, [
    ["acme/models/processes/credit.tests.yaml", "acme/models/processes/credit-limit.tests.yaml"],
  ]);
  assert.equal(readFileSync(join(ws, "processes", "credit-limit.tests.yaml"), "utf8"), "cases: []\n");
  assert.match(spy.edits.get("processes/main.bpmn") ?? "", /decisionRef="credit-limit"/);
  assert.match(spy.edits.get("processes/main.bpmn") ?? "", /calledElement="order"/, "the call link stays");
});

test("renameModel: a caller that cannot be rewritten is reported, the rename stands", async () => {
  const ws = workspace();
  writeFileSync(join(ws, "processes", "main.bpmn"), callerXml("order", "none"));
  const spy = renameDeps({ failEdit: ["processes/main.bpmn"] });
  const out = await renameModel(REPO, ws, { path: "processes/order.bpmn", name: "o2c" }, "Petra", spy.deps(ws));
  assert.ok(existsSync(join(ws, "processes", "o2c.bpmn")));
  assert.deepEqual(out.updatedReferences, []);
  assert.deepEqual(out.failedReferences, ["processes/main.bpmn"]);
});

test("renameModel: a model calling ITSELF is rewritten at its new path", async () => {
  const ws = workspace();
  writeFileSync(join(ws, "processes", "loop.bpmn"), callerXml("loop", "none"));
  const spy = renameDeps();
  const out = await renameModel(REPO, ws, { path: "processes/loop.bpmn", name: "retry" }, "Petra", spy.deps(ws));
  assert.deepEqual(out.updatedReferences, ["processes/retry.bpmn"]);
  assert.match(spy.edits.get("processes/retry.bpmn") ?? "", /calledElement="retry"/);
});

test("renameModel: same name, empty slug, a taken id, an occupied or still-open target are refused — nothing moves", async () => {
  const ws = workspace();
  writeFileSync(join(ws, "processes", "credit.dmn"), "<dmn/>");
  writeFileSync(join(ws, "processes", "credit.tests.yaml"), "cases: []\n");
  writeFileSync(join(ws, "processes", "archive.tests.yaml"), "orphan\n");
  const spy = renameDeps();
  const cases: Array<[RenameDeps, { path: string; name: string }, string, number]> = [
    [spy.deps(ws), { path: "processes/order.bpmn", name: "Order" }, "rename/unchanged", 400],
    [spy.deps(ws), { path: "processes/order.bpmn", name: "!!!" }, "scaffold/invalid-name", 400],
    // process ids are unique repo-wide — the sub-folder's check-credit counts
    [spy.deps(ws), { path: "processes/order.bpmn", name: "Check credit" }, "rename/model-exists", 409],
    [spy.deps(ws), { path: "processes/missing.bpmn", name: "x" }, "rename/unknown-model", 404],
    [spy.deps(ws), { path: "bpmiq.yml", name: "x" }, "rename/unknown-model", 404],
    // an orphaned sidecar squats on the new tests path
    [spy.deps(ws), { path: "processes/credit.dmn", name: "archive" }, "rename/target-exists", 409],
    [
      { ...spy.deps(ws), liveDocs: () => ["acme/models/processes/o2c.bpmn"] },
      { path: "processes/order.bpmn", name: "o2c" },
      "rename/target-exists",
      409,
    ],
  ];
  for (const [deps, body, code, status] of cases) {
    await assert.rejects(() => renameModel(REPO, ws, body, "Petra", deps), rejectsWith(code, status), body.name);
  }
  assert.ok(existsSync(join(ws, "processes", "order.bpmn")));
  assert.ok(existsSync(join(ws, "processes", "credit.dmn")));
  assert.deepEqual(spy.ws.retired, []);
  // a decision MAY share a process's id (separate namespaces, like create)
  const ok = await renameModel(REPO, ws, { path: "processes/credit.dmn", name: "order" }, "Petra", spy.deps(ws));
  assert.equal(ok.path, "processes/order.dmn");
});

// ── duplicateModel (#209) ───────────────────────────────────────────────────

test("duplicateModel: the LIVE content lands next to the source under the new id, the tests sidecar too", async () => {
  const ws = workspace();
  writeFileSync(join(ws, "processes", "subprocesses", "credit.dmn"), "<dmn>disk</dmn>");
  writeFileSync(join(ws, "processes", "subprocesses", "credit.tests.yaml"), "cases: [disk]\n");
  const live: Record<string, string> = {
    "processes/subprocesses/credit.dmn": "<dmn>live</dmn>",
    "processes/subprocesses/credit.tests.yaml": "cases: [live]\n",
  };
  const out = await duplicateModel(
    REPO,
    ws,
    { path: "processes/subprocesses/credit.dmn", name: "credit-copy" },
    { readContent: async (path) => live[path] ?? "" },
  );
  assert.deepEqual(out.created, [
    "processes/subprocesses/credit-copy.dmn",
    "processes/subprocesses/credit-copy.tests.yaml",
  ]);
  assert.deepEqual(out.model, {
    repo: "acme/models",
    id: "credit-copy",
    name: "credit-copy",
    path: "processes/subprocesses/credit-copy.dmn",
    notation: "dmn",
    folder: "subprocesses",
    dirty: true,
    liveSessions: 0,
  });
  assert.equal(readFileSync(join(ws, "processes", "subprocesses", "credit-copy.dmn"), "utf8"), "<dmn>live</dmn>");
  assert.equal(
    readFileSync(join(ws, "processes", "subprocesses", "credit-copy.tests.yaml"), "utf8"),
    "cases: [live]\n",
  );
  // the source is untouched
  assert.equal(readFileSync(join(ws, "processes", "subprocesses", "credit.dmn"), "utf8"), "<dmn>disk</dmn>");
});

test("duplicateModel: a taken id is a 409, a failed read leaves no half copy", async () => {
  const ws = workspace();
  await assert.rejects(
    () => duplicateModel(REPO, ws, { path: "processes/order.bpmn", name: "order" }, { readContent: async () => "" }),
    rejectsWith("duplicate/model-exists", 409),
  );
  await assert.rejects(() =>
    duplicateModel(
      REPO,
      ws,
      { path: "processes/order.bpmn", name: "order-copy" },
      {
        readContent: async () => {
          throw new Error("room gone");
        },
      },
    ),
  );
  assert.ok(!existsSync(join(ws, "processes", "order-copy.bpmn")));
});

// ── deleteModels (#210) ─────────────────────────────────────────────────────

test("deleteModels: models go with their tests sidecar and lineage", async () => {
  const ws = workspace();
  writeFileSync(join(ws, "processes", "credit.dmn"), "<dmn/>");
  writeFileSync(join(ws, "processes", "credit.tests.yaml"), "cases: []\n");
  const dropped: string[] = [];
  const out = await deleteModels(
    REPO,
    ws,
    { paths: ["processes/credit.dmn", "processes/order.bpmn", "processes/credit.dmn"] },
    { liveDocs: () => [], dropLineage: (room) => void dropped.push(room) },
  );
  assert.deepEqual(out.deleted, ["processes/credit.dmn", "processes/credit.tests.yaml", "processes/order.bpmn"]);
  for (const path of out.deleted) assert.ok(!existsSync(join(ws, path)), path);
  assert.deepEqual(
    dropped,
    out.deleted.map((p) => `acme/models/${p}`),
  );
  assert.ok(existsSync(join(ws, "processes", "subprocesses", "check-credit.bpmn")), "the rest stays");
});

test("deleteModels: one open or unknown model refuses the whole batch — nothing is deleted", async () => {
  const ws = workspace();
  const deps = { liveDocs: () => ["acme/models/processes/subprocesses/check-credit.bpmn"], dropLineage: () => {} };
  await assert.rejects(
    () => deleteModels(REPO, ws, { paths: ["processes/order.bpmn", "processes/subprocesses/check-credit.bpmn"] }, deps),
    rejectsWith("delete/live-session", 409),
  );
  await assert.rejects(
    () => deleteModels(REPO, ws, { paths: ["processes/order.bpmn", "bpmiq.yml"] }, deps),
    rejectsWith("delete/unknown-model", 404),
  );
  await assert.rejects(() => deleteModels(REPO, ws, { paths: [" "] }, deps), rejectsWith("delete/no-paths", 400));
  assert.ok(existsSync(join(ws, "processes", "order.bpmn")));
  assert.ok(existsSync(join(ws, "bpmiq.yml")));
});

test("renameModel: a failed file rename keeps an OPEN model's live state under its old name", async () => {
  const ws = workspace();
  const spy = renameDeps({ live: { "acme/models/processes/order.bpmn": "<bpmn>unsaved</bpmn>" } });
  // a read-only folder makes the fs rename fail AFTER the retire
  const failing: RenameDeps = { ...spy.deps(ws), liveDocs: () => [] };
  chmodSync(join(ws, "processes"), 0o555);
  try {
    await assert.rejects(() => renameModel(REPO, ws, { path: "processes/order.bpmn", name: "o2c" }, "Petra", failing));
  } finally {
    chmodSync(join(ws, "processes"), 0o755);
  }
  assert.deepEqual(spy.lineage.saved, ["acme/models/processes/order.bpmn"], "the edits stay with the old room");
  assert.ok(existsSync(join(ws, "processes", "order.bpmn")));
  assert.equal(spy.ws.released, 1, "the new room is released again");
});
