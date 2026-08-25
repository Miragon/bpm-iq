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

import { type ContentConfig, discoverModels, discoverProcesses, loadContentConfig } from "../content.ts";

const ws = (): string => mkdtempSync(join(tmpdir(), "bpm-content-"));
/** models and processes always name the same folder (the legacy alias) */
const cfg = (folder: string): ContentConfig => ({ models: folder, processes: folder });

test("loadContentConfig: reads the processes folder from bpmiq.yml", () => {
  const w = ws();
  writeFileSync(join(w, "bpmiq.yml"), "processes: processes\n");
  assert.deepEqual(loadContentConfig(w), cfg("processes"));
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
  assert.deepEqual(await discoverProcesses(w, cfg("processes")), [
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
  assert.deepEqual(await discoverProcesses(w, cfg(".")), [{ id: "root", path: "root.bpmn" }]);
});

test("discoverProcesses: missing folder or a config naming a FILE degrades to []", async () => {
  const w = ws();
  assert.deepEqual(await discoverProcesses(w, cfg("nope")), []);
  writeFileSync(join(w, "afile.bpmn"), "<b/>");
  assert.deepEqual(await discoverProcesses(w, cfg("afile.bpmn")), []);
});

test("discoverProcesses: a duplicate file stem keeps the first (sorted)", async () => {
  const w = ws();
  mkdirSync(join(w, "processes", "a"), { recursive: true });
  mkdirSync(join(w, "processes", "b"), { recursive: true });
  writeFileSync(join(w, "processes", "a", "order.bpmn"), "<b/>");
  writeFileSync(join(w, "processes", "b", "order.bpmn"), "<b/>");
  assert.deepEqual(await discoverProcesses(w, cfg("processes")), [{ id: "order", path: "processes/a/order.bpmn" }]);
});

test("loadContentConfig: `models:` is the new key, `processes:` stays a full alias", () => {
  const w = ws();
  writeFileSync(join(w, "bpmiq.yml"), "models: models\n");
  assert.deepEqual(loadContentConfig(w), cfg("models"));
  // both keys present: models wins (the canonical spelling)
  writeFileSync(join(w, "bpmiq.yml"), "models: models\nprocesses: legacy\n");
  assert.deepEqual(loadContentConfig(w), cfg("models"));
});

test("discoverModels: every registry notation, id = modelStem, per-notation namespaces", async () => {
  const w = ws();
  mkdirSync(join(w, "models", "sub"), { recursive: true });
  writeFileSync(join(w, "models", "order.bpmn"), "<b/>");
  // same stem, different notation — BOTH survive (separate namespaces)
  writeFileSync(join(w, "models", "order.dmn"), "<d/>");
  writeFileSync(join(w, "models", "tea-shop.owm"), "component Tea [0.5, 0.5]");
  writeFileSync(join(w, "models", "teams.tt"), "{}");
  // compound extension: the id is the FULL-extension stem
  writeFileSync(join(w, "models", "sub", "supply.vc.json"), "{}");
  // markdown IS a registered notation (epic #118 step 3) — docs are models
  writeFileSync(join(w, "models", "notes.md"), "x");
  // not a registered notation — invisible to discovery
  writeFileSync(join(w, "models", "cases.tests.yaml"), "cases: []");
  assert.deepEqual(await discoverModels(w, cfg("models")), [
    { id: "notes", path: "models/notes.md", notation: "markdown" },
    { id: "order", path: "models/order.bpmn", notation: "bpmn" },
    { id: "order", path: "models/order.dmn", notation: "dmn" },
    { id: "supply", path: "models/sub/supply.vc.json", notation: "value-chain" },
    { id: "tea-shop", path: "models/tea-shop.owm", notation: "wardley" },
    { id: "teams", path: "models/teams.tt", notation: "team-topology" },
  ]);
});

test("discoverModels: a duplicate stem is skipped per notation, not globally", async () => {
  const w = ws();
  mkdirSync(join(w, "models", "a"), { recursive: true });
  mkdirSync(join(w, "models", "b"), { recursive: true });
  writeFileSync(join(w, "models", "a", "order.bpmn"), "<b/>");
  writeFileSync(join(w, "models", "b", "order.bpmn"), "<b/>");
  writeFileSync(join(w, "models", "b", "order.dmn"), "<d/>");
  assert.deepEqual(await discoverModels(w, cfg("models")), [
    { id: "order", path: "models/a/order.bpmn", notation: "bpmn" },
    { id: "order", path: "models/b/order.dmn", notation: "dmn" },
  ]);
});
