/**
 * changedElementIds (src/domain/model-diff.ts) — which elements a save
 * touched, from two ModelGraphs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelGraph } from "@bpmiq/notations/extract";

import { changedElementIds, MAX_CHANGED_IDS } from "../src/domain/model-diff.ts";

const base: ModelGraph = {
  notation: "bpmn",
  nodes: [
    { id: "Start", type: "startEvent", name: "Order received" },
    { id: "Task_1", type: "userTask", name: "Check order", extra: { lane: "Sales" } },
    { id: "End", type: "endEvent", name: "Order shipped" },
  ],
  edges: [{ id: "Flow_1", from: "Start", to: "Task_1", kind: "sequenceFlow" }],
};

test("identical graphs → nothing changed", () => {
  assert.deepEqual(changedElementIds(base, structuredClone(base)), []);
});

test("a renamed node, a re-laned node, a re-routed edge and a NEW element are reported; a removed one is not", () => {
  const next: ModelGraph = {
    notation: "bpmn",
    nodes: [
      { id: "Start", type: "startEvent", name: "Order received" },
      { id: "Task_1", type: "userTask", name: "Check order", extra: { lane: "Support" } }, // re-laned
      { id: "Task_2", type: "serviceTask", name: "Bill customer" }, // new
      // End removed
    ],
    edges: [
      { id: "Flow_1", from: "Start", to: "Task_2", kind: "sequenceFlow" }, // re-routed
      { id: "Flow_2", from: "Task_2", to: "Task_1", kind: "sequenceFlow" }, // new
    ],
  };
  assert.deepEqual(changedElementIds(base, next), ["Task_1", "Task_2", "Flow_1", "Flow_2"]);
});

test("key order is not a change; a missing side counts as everything new / nothing", () => {
  const reordered: ModelGraph = {
    ...base,
    nodes: base.nodes.map((n) => ({
      ...(n.name ? { name: n.name } : {}),
      type: n.type,
      id: n.id,
      ...(n.extra ? { extra: n.extra } : {}),
    })),
  };
  assert.deepEqual(changedElementIds(base, reordered), []);
  assert.deepEqual(changedElementIds(undefined, base), ["Start", "Task_1", "End", "Flow_1"]);
  assert.deepEqual(changedElementIds(base, undefined), []);
});

test("capped at MAX_CHANGED_IDS — the client renders no more outlines anyway", () => {
  const big: ModelGraph = {
    notation: "bpmn",
    nodes: Array.from({ length: MAX_CHANGED_IDS + 20 }, (_, i) => ({ id: `N${i}`, type: "task" })),
    edges: [],
  };
  assert.equal(changedElementIds(undefined, big).length, MAX_CHANGED_IDS);
});
