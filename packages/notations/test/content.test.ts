/**
 * The content-repo contract (content.ts) — designiq.yml parsing + .bpmn discovery,
 * the shared definition of "what is a process" that the Live Host, MCP and
 * validator all trust. The "degrade, never crash" contract and the path
 * normalization are pinned here (the canonical copy; live-host re-exports it).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CONTENT_CONFIG_FILE,
  CONTENT_CONFIG_FILES,
  CONTENT_CONFIG_NAMES,
  type ContentConfig,
  contentConfigConflict,
  discoverModels,
  discoverProcesses,
  hasContentConfig,
  legacyContentConfigFile,
  loadContentConfig,
  notAContentRepoReason,
  resolveContentConfigFile,
} from "../content.ts";

const ws = (): string => mkdtempSync(join(tmpdir(), "designiq-content-"));
/** models and processes always name the same folder (the legacy alias) */
const cfg = (folder: string): ContentConfig => ({ models: folder, processes: folder });

test("loadContentConfig: reads the models folder from designiq.yml", () => {
  const w = ws();
  writeFileSync(join(w, CONTENT_CONFIG_FILE), "models: processes\n");
  assert.deepEqual(loadContentConfig(w), cfg("processes"));
});

test("loadContentConfig: no contract file → undefined (not a content repo)", () => {
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
    writeFileSync(join(w, CONTENT_CONFIG_FILE), `models: "${input}"\n`);
    assert.deepEqual(loadContentConfig(w)?.processes, expected, `input '${input}'`);
  }
});

test("loadContentConfig: rejects absolute paths, traversal, ill-typed, unparseable", () => {
  const w = ws();
  for (const bad of ["/etc", "../up", "a/../../b"]) {
    writeFileSync(join(w, CONTENT_CONFIG_FILE), `models: "${bad}"\n`);
    assert.equal(loadContentConfig(w), undefined, `'${bad}'`);
  }
  writeFileSync(join(w, CONTENT_CONFIG_FILE), "models: [1,2]\n");
  assert.equal(loadContentConfig(w), undefined, "not a string");
  writeFileSync(join(w, CONTENT_CONFIG_FILE), "models: [unclosed\n");
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
  writeFileSync(join(w, CONTENT_CONFIG_FILE), "processes: processes\n");
  assert.deepEqual(loadContentConfig(w), cfg("processes"));
  writeFileSync(join(w, CONTENT_CONFIG_FILE), "models: models\n");
  assert.deepEqual(loadContentConfig(w), cfg("models"));
  // both keys present: models wins (the canonical spelling)
  writeFileSync(join(w, CONTENT_CONFIG_FILE), "models: models\nprocesses: legacy\n");
  assert.deepEqual(loadContentConfig(w), cfg("models"));
});

// ── the contract file's two names (CONTENT_CONFIG_FILES) ────────────────────

test("content config: the names in precedence order — designiq.yml first, and documented", () => {
  assert.deepEqual([...CONTENT_CONFIG_FILES], ["designiq.yml", "bpmiq.yml"]); // legacy-name-ok: pins the legacy name
  // the name every writer creates is the one read first
  assert.equal(CONTENT_CONFIG_FILE, "designiq.yml");
  assert.equal(CONTENT_CONFIG_FILE, CONTENT_CONFIG_FILES[0]);
  const w = ws();
  assert.equal(resolveContentConfigFile(w), undefined);
  assert.equal(hasContentConfig(w), false);
  assert.equal(contentConfigConflict(w), undefined);
  assert.equal(legacyContentConfigFile(w), undefined);
});

test("content config: messages name the documented file AND the legacy one", () => {
  assert.equal(CONTENT_CONFIG_NAMES, "designiq.yml (or legacy bpmiq.yml)"); // legacy-name-ok: pins the legacy wording
  assert.equal(
    notAContentRepoReason("acme/models"),
    "acme/models has no usable designiq.yml (or legacy bpmiq.yml) at its root — not a content repo", // legacy-name-ok: pins the legacy wording
  );
});

test("legacyContentConfigFile: set exactly when the legacy file is the one in use", () => {
  const w = ws();
  writeFileSync(join(w, "bpmiq.yml"), "processes: processes\n"); // legacy-name-ok: pins the legacy path
  assert.equal(legacyContentConfigFile(w), "bpmiq.yml"); // legacy-name-ok: pins the legacy path
  // a folder squatting on the documented name does not make the repo "renamed"
  mkdirSync(join(w, "designiq.yml"));
  assert.equal(legacyContentConfigFile(w), "bpmiq.yml"); // legacy-name-ok: pins the legacy path
  // both FILES (agreeing or not): designiq.yml is read — nothing to nudge
  const both = ws();
  writeFileSync(join(both, "designiq.yml"), "models: processes\n");
  writeFileSync(join(both, "bpmiq.yml"), "processes: processes\n"); // legacy-name-ok: pins the legacy path
  assert.equal(legacyContentConfigFile(both), undefined);
  const documented = ws();
  writeFileSync(join(documented, "designiq.yml"), "models: processes\n");
  assert.equal(legacyContentConfigFile(documented), undefined);
});

test("content config: the legacy name alone stays a content repo, unchanged", () => {
  const w = ws();
  writeFileSync(join(w, "bpmiq.yml"), "processes: processes\n"); // legacy-name-ok: pins the legacy path
  assert.equal(resolveContentConfigFile(w), "bpmiq.yml"); // legacy-name-ok: pins the legacy path
  assert.equal(hasContentConfig(w), true);
  assert.deepEqual(loadContentConfig(w), cfg("processes"));
  assert.equal(contentConfigConflict(w), undefined, "one file can not disagree with itself");
});

test("content config: designiq.yml alone is a content repo", () => {
  const w = ws();
  writeFileSync(join(w, "designiq.yml"), "models: models\n");
  assert.equal(resolveContentConfigFile(w), "designiq.yml");
  assert.equal(hasContentConfig(w), true);
  assert.deepEqual(loadContentConfig(w), cfg("models"));
  assert.equal(contentConfigConflict(w), undefined);
  // the legacy key is an alias in this file too — the name changed, not the format
  writeFileSync(join(w, "designiq.yml"), "processes: legacy\n");
  assert.deepEqual(loadContentConfig(w), cfg("legacy"));
});

test("content config: both names agreeing — designiq.yml is read, nothing reported", () => {
  const w = ws();
  writeFileSync(join(w, "designiq.yml"), "models: models\n");
  // another SPELLING of the same folder under the legacy key still agrees
  writeFileSync(join(w, "bpmiq.yml"), "processes: ./models/\n"); // legacy-name-ok: pins the legacy path
  assert.equal(resolveContentConfigFile(w), "designiq.yml");
  assert.deepEqual(loadContentConfig(w), cfg("models"));
  assert.equal(contentConfigConflict(w), undefined);
});

test("content config: both names disagreeing — designiq.yml wins, the conflict is reported", () => {
  const w = ws();
  writeFileSync(join(w, "designiq.yml"), "models: new\n");
  writeFileSync(join(w, "bpmiq.yml"), "processes: old\n"); // legacy-name-ok: pins the legacy path
  assert.deepEqual(loadContentConfig(w), cfg("new"));
  assert.deepEqual(contentConfigConflict(w), {
    used: "designiq.yml",
    ignored: "bpmiq.yml", // legacy-name-ok: pins the legacy path
    usedFolder: "new",
    ignoredFolder: "old",
  });
  // an unusable legacy file next to a valid designiq.yml is a disagreement too
  writeFileSync(join(w, "bpmiq.yml"), "processes: [unclosed\n"); // legacy-name-ok: pins the legacy path
  assert.deepEqual(loadContentConfig(w), cfg("new"));
  assert.deepEqual(contentConfigConflict(w), {
    used: "designiq.yml",
    ignored: "bpmiq.yml", // legacy-name-ok: pins the legacy path
    usedFolder: "new",
    ignoredFolder: undefined,
  });
});

test("content config: an unusable designiq.yml NEVER falls back to the valid legacy file", () => {
  const w = ws();
  writeFileSync(join(w, "bpmiq.yml"), "processes: processes\n"); // legacy-name-ok: pins the legacy path
  // freshly created/empty, mid-edit, ill-typed, escaping — selection is by
  // existence only, so none of them may hand the folder to the other file
  for (const broken of ["", "models: [unclosed\n", "models: [1,2]\n", 'models: "../up"\n']) {
    writeFileSync(join(w, "designiq.yml"), broken);
    assert.equal(resolveContentConfigFile(w), "designiq.yml", `'${broken}'`);
    assert.equal(hasContentConfig(w), true, `'${broken}'`);
    assert.equal(loadContentConfig(w), undefined, `'${broken}'`);
    assert.deepEqual(
      contentConfigConflict(w),
      {
        used: "designiq.yml",
        ignored: "bpmiq.yml", // legacy-name-ok: pins the legacy path
        usedFolder: undefined,
        ignoredFolder: "processes",
      },
      `'${broken}'`,
    );
  }
  // both unusable: nothing to prefer — simply not a content repo, no conflict
  writeFileSync(join(w, "bpmiq.yml"), "processes: [1,2]\n"); // legacy-name-ok: pins the legacy path
  assert.equal(loadContentConfig(w), undefined);
  assert.equal(contentConfigConflict(w), undefined);
});

test("content config: a FOLDER carrying a contract name is not the contract file", () => {
  const w = ws();
  writeFileSync(join(w, "bpmiq.yml"), "models: .\n"); // legacy-name-ok: pins the legacy path
  // models at the root: anyone may create a folder there, under any name
  mkdirSync(join(w, "designiq.yml"));
  assert.equal(resolveContentConfigFile(w), "bpmiq.yml"); // legacy-name-ok: pins the legacy path
  assert.deepEqual(loadContentConfig(w), cfg("."));
  assert.equal(contentConfigConflict(w), undefined);
  // and a root with nothing but such a folder is no content repo at all
  const bare = ws();
  mkdirSync(join(bare, "designiq.yml"));
  assert.equal(hasContentConfig(bare), false);
});

test("discoverModels: every registry notation, id = modelStem, per-notation namespaces", async () => {
  const w = ws();
  mkdirSync(join(w, "models", "sub"), { recursive: true });
  writeFileSync(join(w, "models", "order.bpmn"), "<b/>");
  // same stem, different notation — BOTH survive (separate namespaces)
  writeFileSync(join(w, "models", "order.dmn"), "<d/>");
  writeFileSync(join(w, "models", "tea-shop.owm"), "component Tea [0.5, 0.5]");
  writeFileSync(join(w, "models", "teams.tt"), "{}");
  writeFileSync(join(w, "models", "checkout.storm"), "title Checkout");
  // compound extension: the id is the FULL-extension stem
  writeFileSync(join(w, "models", "sub", "supply.vc.json"), "{}");
  writeFileSync(join(w, "models", "landscape.cm.json"), "{}");
  // markdown IS a registered notation (epic #118 step 3) — docs are models
  writeFileSync(join(w, "models", "notes.md"), "x");
  // not a registered notation — invisible to discovery
  writeFileSync(join(w, "models", "cases.tests.yaml"), "cases: []");
  assert.deepEqual(await discoverModels(w, cfg("models")), [
    { id: "checkout", path: "models/checkout.storm", notation: "event-storming" },
    { id: "landscape", path: "models/landscape.cm.json", notation: "context-map" },
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
