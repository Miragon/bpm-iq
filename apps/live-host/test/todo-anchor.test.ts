/**
 * Todo anchor codec (src/domain/todo-anchor.ts) — the platform-owned block that
 * ties a tracker item to a process/model elements. Round-trips through
 * encodeAnchor/parseAnchor, tolerant parsing of hand-written blocks, and the
 * name-flattening that keeps the line format unambiguous.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeAnchor, parseAnchor, type TodoAnchor } from "@bpmiq/contracts/todo-anchor";

test("roundtrip: encode → parse yields the same anchor", () => {
  const anchor: TodoAnchor = {
    process: "order-to-cash",
    file: "processes/order-to-cash/order-to-cash.bpmn",
    elements: [
      { id: "Task_CheckCredit", name: "Bonität prüfen" },
      { id: "Gateway_Approved", name: "Freigabe erteilt?" },
    ],
    processVersion: "1.4.0",
  };
  assert.deepEqual(parseAnchor(encodeAnchor(anchor)), anchor);
});

test("roundtrip survives being embedded in a larger issue body", () => {
  const anchor: TodoAnchor = { process: "p1", file: null, elements: [], processVersion: null };
  const body = `Some intro text.\n\n${encodeAnchor(anchor)}\n\nDiscussion below.\n_Created by @petra_`;
  assert.deepEqual(parseAnchor(body), anchor);
});

test("names with pipes/newlines are flattened at encode time (line format stays unambiguous)", () => {
  const anchor: TodoAnchor = {
    process: "order-to-cash",
    file: null,
    elements: [{ id: "Task_A", name: "a|b\nc" }],
    processVersion: null,
  };
  const parsed = parseAnchor(encodeAnchor(anchor));
  assert.deepEqual(parsed?.elements, [{ id: "Task_A", name: "a b c" }]);
  assert.equal(parsed?.process, "order-to-cash");
});

test("element without a name round-trips as name null", () => {
  const anchor: TodoAnchor = {
    process: "p",
    file: null,
    elements: [{ id: "Task_X", name: null }],
    processVersion: null,
  };
  assert.deepEqual(parseAnchor(encodeAnchor(anchor))?.elements, [{ id: "Task_X", name: null }]);
});

test("missing/unclosed block yields null", () => {
  assert.equal(parseAnchor("just an ordinary issue body"), null);
  assert.equal(parseAnchor(""), null);
  assert.equal(parseAnchor("<!-- bpmiq:todo v1\nprocess: x"), null, "opened but never closed");
});

test("a block without a process line yields null (process is the one required field)", () => {
  assert.equal(parseAnchor("<!-- bpmiq:todo v1\nfile: some/file.bpmn\n-->"), null);
});

test("hand-written sloppy block parses (indentation, blank lines, unknown keys skipped)", () => {
  const body = [
    "Please double-check this.",
    "<!-- bpmiq:todo v1",
    "   process: order-to-cash   ",
    "",
    "priority: high", // unknown key — skipped
    "not a key-value line", // no ': ' separator — skipped
    "  element: Task_1 ", // element without a name snapshot
    "  element: Task_2 | Angebot senden",
    "-->",
    "trailing text",
  ].join("\n");
  const anchor = parseAnchor(body);
  assert.equal(anchor?.process, "order-to-cash");
  assert.equal(anchor?.file, null);
  assert.equal(anchor?.processVersion, null);
  assert.deepEqual(anchor?.elements, [
    { id: "Task_1", name: null },
    { id: "Task_2", name: "Angebot senden" },
  ]);
});
