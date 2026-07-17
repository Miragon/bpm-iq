/**
 * The content-repo contract (content.ts) — bpmiq.yml parsing + .bpmn discovery,
 * the shared definition of "what is a process" that the Live Host, MCP and
 * validator all trust. The "degrade, never crash" contract and the path
 * normalization are pinned here (the canonical copy; live-host re-exports it).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { discoverProcesses, loadContentConfig } from "../content.ts";

const ws = (): string => mkdtempSync(join(tmpdir(), "bpm-content-"));

test("loadContentConfig: reads the processes folder from bpmiq.yml", () => {
  const w = ws();
  writeFileSync(join(w, "bpmiq.yml"), "processes: processes\n");
  assert.deepEqual(loadContentConfig(w), { processes: "processes" });
});

test("loadContentConfig: no bpmiq.yml → undefined (not a content repo)", () => {
  assert.equal(loadContentConfig(ws()), undefined);
});

test("loadContentConfig: normalizes equivalent spellings", () => {
  const w = ws();
  for (const [input, expected] of [
    ["./processes", "processes"],
    ["a//b", "a/b"],
    ["p/.", "p"],
    ["processes/", "processes"],
    [".", "."],
    ["", undefined],
  ] as const) {
    writeFileSync(join(w, "bpmiq.yml"), `processes: "${input}"\n`);
    assert.deepEqual(loadContentConfig(w)?.processes, expected, `input '${input}'`);
  }
});

test("loadContentConfig: rejects absolute paths, traversal, ill-typed, unparseable", () => {
  const w = ws();
  for (const bad of ["/etc", "../up", "a/../../b"]) {
    writeFileSync(join(w, "bpmiq.yml"), `processes: "${bad}"\n`);
    assert.equal(loadContentConfig(w), undefined, `'${bad}'`);
  }
  writeFileSync(join(w, "bpmiq.yml"), "processes: [1,2]\n");
  assert.equal(loadContentConfig(w), undefined, "not a string");
  writeFileSync(join(w, "bpmiq.yml"), "processes: [unclosed\n");
  assert.equal(loadContentConfig(w), undefined, "parse error");
});

test("discoverProcesses: every .bpmn recursively, id = stem, sorted by path", async () => {
  const w = ws();
  mkdirSync(join(w, "processes", "sub"), { recursive: true });
  writeFileSync(join(w, "processes", "order.bpmn"), "<b/>");
  writeFileSync(join(w, "processes", "sub", "credit.bpmn"), "<b/>");
  writeFileSync(join(w, "processes", "notes.md"), "x");
  assert.deepEqual(await discoverProcesses(w, { processes: "processes" }), [
    { id: "order", path: "processes/order.bpmn" },
    { id: "credit", path: "processes/sub/credit.bpmn" },
  ]);
});

test("discoverProcesses: '.' root, skips dot-dirs + node_modules", async () => {
  const w = ws();
  writeFileSync(join(w, "root.bpmn"), "<b/>");
  mkdirSync(join(w, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(w, "node_modules", "pkg", "dep.bpmn"), "<b/>");
  mkdirSync(join(w, ".hidden"), { recursive: true });
  writeFileSync(join(w, ".hidden", "s.bpmn"), "<b/>");
  assert.deepEqual(await discoverProcesses(w, { processes: "." }), [{ id: "root", path: "root.bpmn" }]);
});

test("discoverProcesses: missing folder or a config naming a FILE degrades to []", async () => {
  const w = ws();
  assert.deepEqual(await discoverProcesses(w, { processes: "nope" }), []);
  writeFileSync(join(w, "afile.bpmn"), "<b/>");
  assert.deepEqual(await discoverProcesses(w, { processes: "afile.bpmn" }), []);
});

test("discoverProcesses: a duplicate file stem keeps the first (sorted)", async () => {
  const w = ws();
  mkdirSync(join(w, "processes", "a"), { recursive: true });
  mkdirSync(join(w, "processes", "b"), { recursive: true });
  writeFileSync(join(w, "processes", "a", "order.bpmn"), "<b/>");
  writeFileSync(join(w, "processes", "b", "order.bpmn"), "<b/>");
  assert.deepEqual(await discoverProcesses(w, { processes: "processes" }), [
    { id: "order", path: "processes/a/order.bpmn" },
  ]);
});
