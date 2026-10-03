import assert from "node:assert/strict";
import { test } from "node:test";

import { compact } from "../../src/layout/compact.ts";
import { flow, plane, rect, shape } from "../support/fixtures.ts";

const left = shape("task_left", rect(0, 0, 100, 80));
const right = shape("task_right", rect(1100, 0, 100, 80));

test("compact closes an empty strip that a flow only crosses straight down to the column gap", () => {
  const straight = flow("flow_lr", "task_left", "task_right", [
    { x: 100, y: 40 },
    { x: 1100, y: 40 },
  ]);

  const { plane: result, moved } = compact(plane([left, right], [straight]));

  assert.deepEqual([...moved], ["task_right"]);
  assert.equal(result.shapes[1]?.bounds.x, 200);
  assert.deepEqual(result.edges[0]?.waypoints, [
    { x: 100, y: 40 },
    { x: 200, y: 40 },
  ]);
});

test("compact keeps a strip that a bend of a flow splits into parts of a normal width", () => {
  const near = shape("task_right", rect(400, 0, 100, 80));
  const bent = flow("flow_lr", "task_left", "task_right", [
    { x: 100, y: 40 },
    { x: 250, y: 40 },
    { x: 250, y: 20 },
    { x: 400, y: 20 },
  ]);

  const { moved } = compact(plane([left, near], [bent]));

  assert.equal(moved.size, 0);
});
