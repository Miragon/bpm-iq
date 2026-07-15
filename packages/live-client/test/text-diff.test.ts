/**
 * diffRegion edge cases + updateText's minimal-diff guarantee: the write must
 * touch ONLY the changed middle (delete/insert on the diff region), never
 * replace the whole text — asserted by inspecting the Y.Text event delta.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { diffRegion, updateText } from "../src/text-diff.ts";

/* ── diffRegion ─────────────────────────────────────────────────────────── */

test("diffRegion: equal strings → empty region at the end", () => {
  assert.deepEqual(diffRegion("abc", "abc"), { start: 3, endPrev: 3, endNext: 3 });
});

test("diffRegion: both empty → empty region at 0", () => {
  assert.deepEqual(diffRegion("", ""), { start: 0, endPrev: 0, endNext: 0 });
});

test("diffRegion: empty prev → whole next is the insert", () => {
  assert.deepEqual(diffRegion("", "abc"), { start: 0, endPrev: 0, endNext: 3 });
});

test("diffRegion: empty next → whole prev is the delete", () => {
  assert.deepEqual(diffRegion("abc", ""), { start: 0, endPrev: 3, endNext: 0 });
});

test("diffRegion: pure insertion after common prefix", () => {
  // "ab" → "abc": common prefix "ab", nothing to delete, insert "c"
  assert.deepEqual(diffRegion("ab", "abc"), { start: 2, endPrev: 2, endNext: 3 });
});

test("diffRegion: change at the start keeps the common suffix", () => {
  // "Xbc" → "Ybc": suffix "bc" is trimmed, only index 0 differs
  assert.deepEqual(diffRegion("Xbc", "Ybc"), { start: 0, endPrev: 1, endNext: 1 });
});

test("diffRegion: middle change trims prefix and suffix", () => {
  const r = diffRegion("hello world", "hello brave world");
  assert.deepEqual(r, { start: 6, endPrev: 6, endNext: 12 });
  assert.equal("hello brave world".slice(r.start, r.endNext), "brave ");
});

/* ── updateText ─────────────────────────────────────────────────────────── */

interface DeltaOp {
  retain?: number;
  insert?: string;
  delete?: number;
}

function makeYText(initial: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, initial);
  const deltas: DeltaOp[][] = [];
  const origins: unknown[] = [];
  ytext.observe((event, tx) => {
    deltas.push(event.delta as DeltaOp[]);
    origins.push(tx.origin);
  });
  return { doc, ytext, deltas, origins };
}

const sum = (ops: DeltaOp[], pick: (op: DeltaOp) => number) => ops.reduce((n, op) => n + pick(op), 0);
const deleted = (ops: DeltaOp[]) => sum(ops, (op) => op.delete ?? 0);
const inserted = (ops: DeltaOp[]) => sum(ops, (op) => op.insert?.length ?? 0);

test("updateText: insertion in the middle retains the prefix — no full replace", () => {
  const { ytext, deltas } = makeYText("hello world");
  updateText(ytext, "hello brave world");

  assert.equal(ytext.toString(), "hello brave world");
  assert.equal(deltas.length, 1);
  const ops = deltas[0]!;
  // minimal diff: keep "hello " (retain 6), insert "brave ", delete nothing
  assert.equal(ops[0]?.retain, 6, `expected a leading retain, got ${JSON.stringify(ops)}`);
  assert.equal(deleted(ops), 0, "pure insertion must not delete anything");
  assert.equal(inserted(ops), "brave ".length);
});

test("updateText: replacement touches only the changed middle", () => {
  const { ytext, deltas } = makeYText("aaaBBBccc");
  updateText(ytext, "aaaXXccc");

  assert.equal(ytext.toString(), "aaaXXccc");
  const ops = deltas[0]!;
  // full replace would be delete 9 / insert 8 with no retain
  assert.equal(ops[0]?.retain, 3, `expected a leading retain, got ${JSON.stringify(ops)}`);
  assert.equal(deleted(ops), 3, "only the changed middle may be deleted");
  assert.equal(inserted(ops), 2, "only the changed middle may be inserted");
});

test("updateText: pure deletion keeps prefix and suffix", () => {
  const { ytext, deltas } = makeYText("hello brave world");
  updateText(ytext, "hello world");

  assert.equal(ytext.toString(), "hello world");
  const ops = deltas[0]!;
  assert.equal(ops[0]?.retain, 6, `expected a leading retain, got ${JSON.stringify(ops)}`);
  assert.equal(deleted(ops), "brave ".length);
  assert.equal(inserted(ops), 0, "pure deletion must not insert anything");
});

test("updateText: equal content is a no-op — no transaction fired", () => {
  const { ytext, deltas } = makeYText("same");
  updateText(ytext, "same");
  assert.equal(ytext.toString(), "same");
  assert.equal(deltas.length, 0, "no observer round for a no-op write");
});

test("updateText: empty → content and content → empty", () => {
  const a = makeYText("");
  updateText(a.ytext, "fresh");
  assert.equal(a.ytext.toString(), "fresh");

  const b = makeYText("gone");
  updateText(b.ytext, "");
  assert.equal(b.ytext.toString(), "");
  assert.equal(deleted(b.deltas[0]!), 4);
});

test("updateText: tags the transaction with the given origin", () => {
  const { ytext, origins } = makeYText("hello world");
  updateText(ytext, "hello there world", "my-origin");
  assert.deepEqual(origins, ["my-origin"]);
});

test("updateText: a Y.Text without a doc is rejected", () => {
  const detached = new Y.Text("x");
  assert.throws(() => updateText(detached, "y"), /attached to a Y.Doc/);
});
