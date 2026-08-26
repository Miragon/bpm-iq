/**
 * The structured lane's snapshot helpers (src/structured.ts) — the merge
 * properties the whole shape exists for: element-wise AND attribute-wise
 * granularity, so concurrent edits on different elements — or different
 * attributes of ONE element — converge instead of replacing each other.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ELEMENTS_KEY } from "@bpmiq/contracts/live";
import * as Y from "yjs";

import { readSnapshot, reconcileSnapshot, type StructuredSnapshot } from "../src/structured.ts";

const BOARD: StructuredSnapshot = {
  meta: { title: "Order" },
  elements: {
    e1: { type: "command", text: "Place order", x: 20 },
    e2: { type: "event", text: "Order placed", x: 100 },
  },
};

/** two clients sharing a seeded doc, then editing OFFLINE — merge() exchanges
 *  the pending updates afterwards (true concurrency, not sequential sync) */
function pair(seed: StructuredSnapshot): { a: Y.Doc; b: Y.Doc; merge: () => void } {
  const a = new Y.Doc();
  reconcileSnapshot(a, seed);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const merge = (): void => {
    const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(b, fromA);
    Y.applyUpdate(a, fromB);
  };
  return { a, b, merge };
}

test("read ∘ reconcile round-trips; reconcile is idempotent", () => {
  const doc = new Y.Doc();
  reconcileSnapshot(doc, BOARD);
  assert.deepEqual(readSnapshot(doc), BOARD);
  reconcileSnapshot(doc, BOARD);
  assert.deepEqual(readSnapshot(doc), BOARD);
});

test("reconcile touches ONLY what differs — deletions, additions, changed attrs", () => {
  const doc = new Y.Doc();
  reconcileSnapshot(doc, BOARD);
  const next: StructuredSnapshot = {
    meta: { title: "Order v2" },
    elements: {
      e1: { type: "command", text: "Place order", x: 25 }, // one attr moved
      e3: { type: "event", text: "Paid" }, // added; e2 removed
    },
  };
  reconcileSnapshot(doc, next);
  assert.deepEqual(readSnapshot(doc), next);
});

test("a whole-board save merges with a concurrent edit on ANOTHER element", () => {
  const { a, b, merge } = pair(BOARD);

  // OFFLINE: client B drags e2 while an agent (on A's replica) saves a whole
  // board that renames e1 — reconcile emits NO op for e2 (target matches A's
  // state), so Yjs merges both edits on exchange
  (b.getMap(ELEMENTS_KEY).get("e2") as Y.Map<unknown>).set("x", 400);
  reconcileSnapshot(a, {
    ...BOARD,
    elements: { ...BOARD.elements, e1: { type: "command", text: "Submit order", x: 20 } },
  });
  merge();

  const merged = readSnapshot(a);
  assert.equal(merged.elements.e1?.text, "Submit order", "the agent's rename landed");
  assert.equal(merged.elements.e2?.x, 400, "the co-editor's concurrent drag survived");
  assert.deepEqual(readSnapshot(b), merged, "both clients converge");
});

test("attribute-wise: concurrent edits on DIFFERENT attrs of ONE element both survive", () => {
  const { a, b, merge } = pair(BOARD);

  (b.getMap(ELEMENTS_KEY).get("e1") as Y.Map<unknown>).set("x", 99); // B moves e1
  reconcileSnapshot(a, {
    ...BOARD,
    elements: { ...BOARD.elements, e1: { type: "command", text: "Renamed", x: 20 } }, // A renames e1
  });
  merge();

  const merged = readSnapshot(a);
  assert.equal(merged.elements.e1?.text, "Renamed");
  assert.equal(merged.elements.e1?.x, 99, "the move on the OTHER attribute was not stomped");
  assert.deepEqual(readSnapshot(b), merged, "both clients converge");
});

test("an element named after an Object.prototype member stays deletable (hasOwn, not `in`)", () => {
  const doc = new Y.Doc();
  reconcileSnapshot(doc, { meta: {}, elements: { toString: { type: "ghost" }, e1: { t: 1 } } });
  reconcileSnapshot(doc, { meta: {}, elements: { e1: { t: 1 } } });
  assert.deepEqual(readSnapshot(doc).elements, { e1: { t: 1 } }, "the toString element was deleted");
});

test("BOUNDARY: concurrent CREATION of one element id resolves whole-element LWW", () => {
  // attribute-level merge holds for EXISTING elements; two clients creating
  // the SAME id offline race on the map entry — one side's entire attribute
  // set wins, and the loser's retained Y.Map reference is orphaned (its later
  // writes vanish). Documented in @bpmiq/contracts/live; editors must re-read
  // the element from ELEMENTS_KEY after a sync and use collision-safe ids.
  const { a, b, merge } = pair({ meta: {}, elements: {} });
  reconcileSnapshot(a, { meta: {}, elements: { e5: { from: "A" } } });
  const bMap = new Y.Map<unknown>();
  b.getMap(ELEMENTS_KEY).set("e5", bMap);
  bMap.set("from", "B");
  merge();
  const winner = readSnapshot(a).elements.e5;
  assert.ok(winner?.from === "A" || winner?.from === "B", "exactly one creation wins wholesale");
  assert.deepEqual(readSnapshot(b).elements.e5, winner, "both replicas converge on the same winner");
});
