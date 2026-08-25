/**
 * The refs capability (refs.ts) + the repo-wide index (content.ts
 * buildRepoIndex) — epic #118 step 4. Pinned: the BPMN emitter reproduces the
 * two historical link kinds (calls before decides — the validator's
 * wire-visible warning order), resolution is per (notation, id), and the
 * index degrades per broken file instead of failing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildRepoIndex, type ContentConfig } from "../content.ts";
import { extractModelGraph, type ModelGraph } from "../extract.ts";
import { refsOf } from "../refs.ts";

const cfg = (folder: string): ContentConfig => ({ models: folder, processes: folder });

const CALLER = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="P">
    <businessRuleTask id="Rule_1" calledDecision="credit-check"/>
    <callActivity id="Call_1" calledElement="invoice-handling"/>
    <callActivity id="Call_2" calledElement="ghost"/>
  </process>
</definitions>`;

test("refsOf(bpmn): calls before decides, typed targets, required strength", () => {
  const graph = extractModelGraph("bpmn", CALLER) as ModelGraph;
  assert.deepEqual(refsOf(graph), [
    { fromElement: "Call_1", rel: "calls", to: { id: "invoice-handling", notation: "bpmn" }, strength: "required" },
    { fromElement: "Call_2", rel: "calls", to: { id: "ghost", notation: "bpmn" }, strength: "required" },
    { fromElement: "Rule_1", rel: "decides", to: { id: "credit-check", notation: "dmn" }, strength: "required" },
  ]);
});

test("refsOf: notations without an emitter yield []", () => {
  assert.deepEqual(refsOf({ notation: "wardley", nodes: [], edges: [] }), []);
  assert.deepEqual(refsOf({ notation: "markdown", nodes: [], edges: [] }), []);
});

test("buildRepoIndex: artifacts + resolved/dangling refs + incoming/outgoing traversal", async () => {
  const w = mkdtempSync(join(tmpdir(), "bpm-refs-"));
  mkdirSync(join(w, "models", "sub"), { recursive: true });
  writeFileSync(join(w, "models", "caller.bpmn"), CALLER);
  writeFileSync(join(w, "models", "sub", "invoice-handling.bpmn"), "<definitions/>");
  writeFileSync(join(w, "models", "credit-check.dmn"), "<definitions/>");
  // a broken model must not fail the index — it just emits no refs
  writeFileSync(join(w, "models", "broken.tt"), "{ nope");

  const index = await buildRepoIndex(w, cfg("models"));
  assert.equal(index.artifacts.length, 4);
  assert.equal(index.byId("invoice-handling", "bpmn")?.path, "models/sub/invoice-handling.bpmn");
  assert.equal(index.byId("credit-check")?.notation, "dmn", "notation-less lookup finds the stem");

  const out = index.outgoing("models/caller.bpmn");
  assert.deepEqual(
    out.map((r) => `${r.rel}:${r.to.id}:${r.resolved ? "ok" : "dangling"}`),
    ["calls:invoice-handling:ok", "calls:ghost:dangling", "decides:credit-check:ok"],
  );
  assert.deepEqual(
    index.incoming("models/credit-check.dmn").map((r) => `${r.from.path}#${r.from.element}`),
    ["models/caller.bpmn#Rule_1"],
  );
  assert.deepEqual(index.incoming("models/broken.tt"), []);
});
