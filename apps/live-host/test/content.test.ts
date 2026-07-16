/**
 * The content-repo contract (src/repos/content.ts) — bpmiq.yml parsing and
 * .bpmn discovery. These are the seam every consumer (overview, release,
 * rooms) trusts, so the "degrade, never crash" contract and the path
 * normalization that keeps discovery and the room gate in agreement are
 * pinned here.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { discoverProcesses, loadContentConfig } from "../src/repos/content.ts";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "bpm-content-"));
}

// ── loadContentConfig ─────────────────────────────────────────────────────────

test("loadContentConfig: reads the processes folder from bpmiq.yml", () => {
  const ws = workspace();
  writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
  assert.deepEqual(loadContentConfig(ws), { processes: "processes" });
});

test("loadContentConfig: no bpmiq.yml → undefined (not a content repo)", () => {
  assert.equal(loadContentConfig(workspace()), undefined);
});

test("loadContentConfig: normalizes equivalent spellings to one canonical value", () => {
  const ws = workspace();
  for (const [input, expected] of [
    ["./processes", "processes"],
    ["a//b", "a/b"],
    ["p/.", "p"],
    ["processes/", "processes"],
    [".", "."],
    ["", undefined],
  ] as const) {
    writeFileSync(join(ws, "bpmiq.yml"), `processes: "${input}"\n`);
    assert.deepEqual(loadContentConfig(ws)?.processes, expected, `input '${input}'`);
  }
});

test("loadContentConfig: rejects absolute paths and traversal", () => {
  const ws = workspace();
  for (const bad of ["/etc", "../up", "a/../../b"]) {
    writeFileSync(join(ws, "bpmiq.yml"), `processes: "${bad}"\n`);
    assert.equal(loadContentConfig(ws), undefined, `'${bad}' must be refused`);
  }
});

test("loadContentConfig: ill-typed or unparseable config degrades to undefined", () => {
  const ws = workspace();
  writeFileSync(join(ws, "bpmiq.yml"), "processes: [1, 2, 3]\n"); // not a string
  assert.equal(loadContentConfig(ws), undefined);
  writeFileSync(join(ws, "bpmiq.yml"), "processes: [unclosed\n"); // parse error
  assert.equal(loadContentConfig(ws), undefined);
  writeFileSync(join(ws, "bpmiq.yml"), "other: thing\n"); // no processes key
  assert.equal(loadContentConfig(ws), undefined);
});

// ── discoverProcesses ─────────────────────────────────────────────────────────

test("discoverProcesses: finds every .bpmn recursively, id = file stem, sorted by path", async () => {
  const ws = workspace();
  mkdirSync(join(ws, "processes", "sub"), { recursive: true });
  writeFileSync(join(ws, "processes", "order.bpmn"), "<b/>");
  writeFileSync(join(ws, "processes", "sub", "credit.bpmn"), "<b/>");
  writeFileSync(join(ws, "processes", "notes.md"), "x"); // not a model
  const found = await discoverProcesses(ws, { processes: "processes" });
  assert.deepEqual(found, [
    { id: "order", path: "processes/order.bpmn" },
    { id: "credit", path: "processes/sub/credit.bpmn" },
  ]);
});

test("discoverProcesses: '.' lists root-level .bpmn and skips dot-dirs + node_modules", async () => {
  const ws = workspace();
  writeFileSync(join(ws, "root.bpmn"), "<b/>");
  mkdirSync(join(ws, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(ws, "node_modules", "pkg", "dep.bpmn"), "<b/>");
  mkdirSync(join(ws, ".hidden"), { recursive: true });
  writeFileSync(join(ws, ".hidden", "secret.bpmn"), "<b/>");
  const found = await discoverProcesses(ws, { processes: "." });
  assert.deepEqual(found, [{ id: "root", path: "root.bpmn" }]);
});

test("discoverProcesses: missing folder or a config naming a FILE degrades to []", async () => {
  const ws = workspace();
  assert.deepEqual(await discoverProcesses(ws, { processes: "not-there" }), []);
  writeFileSync(join(ws, "afile.bpmn"), "<b/>");
  // processes points at a file → readdir ENOTDIR must not crash (contract: degrade)
  assert.deepEqual(await discoverProcesses(ws, { processes: "afile.bpmn" }), []);
});

test("discoverProcesses: a duplicate file stem keeps the first (sorted), skips the shadow", async () => {
  const ws = workspace();
  mkdirSync(join(ws, "processes", "a"), { recursive: true });
  mkdirSync(join(ws, "processes", "b"), { recursive: true });
  writeFileSync(join(ws, "processes", "a", "order.bpmn"), "<b/>");
  writeFileSync(join(ws, "processes", "b", "order.bpmn"), "<b/>");
  const found = await discoverProcesses(ws, { processes: "processes" });
  assert.deepEqual(found, [{ id: "order", path: "processes/a/order.bpmn" }]);
});
