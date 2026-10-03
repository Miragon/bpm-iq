import assert from "node:assert/strict";
import { test } from "node:test";

import { parseOperations } from "../../src/operations/parse.ts";

test("parseOperations reads a batch and a single operation", () => {
  const batch = parseOperations(
    JSON.stringify([
      { op: "rename", id: "task_a", name: "A" },
      {
        op: "insertAfter",
        after: "task_a",
        element: { type: "serviceTask", id: "serviceTask_b", name: "B", row: "below" },
      },
    ]),
    "ops.json",
  );

  assert.deepEqual(batch[0], { op: "rename", id: "task_a", name: "A" });
  assert.deepEqual(batch[1], {
    op: "insertAfter",
    after: "task_a",
    via: undefined,
    element: { type: "serviceTask", id: "serviceTask_b", name: "B", row: "below", template: undefined },
  });
  assert.equal(parseOperations('{"op":"setCondition","flow":"f","condition":null}', "ops.json").length, 1);
});

test("parseOperations names the operation and the problem", () => {
  assert.throws(() => parseOperations('[{"op":"explode"}]', "ops.json"), /operation 0: needs "op" as one of/);
  assert.throws(() => parseOperations('[{"op":"rename","id":"a"}]', "ops.json"), /operation 0: name must be a string/);
  assert.throws(
    () => parseOperations('[{"op":"rename","id":"a","name":"b","color":"red"}]', "ops.json"),
    /unknown field color/,
  );
  assert.throws(
    () =>
      parseOperations('[{"op":"insertAfter","after":"a","element":{"type":"robot","id":"x","name":"y"}}]', "ops.json"),
    /element type must be one of/,
  );
  assert.throws(() => parseOperations("not json", "ops.json"), /ops\.json: not valid JSON/);
});
