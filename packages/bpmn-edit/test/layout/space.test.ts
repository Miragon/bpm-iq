import assert from "node:assert/strict";
import { test } from "node:test";

import { makeSpace } from "../../src/layout/space.ts";
import { flow, plane, rect, shape } from "../support/fixtures.ts";

test("makeSpace moves shapes and waypoints beyond the line, a boundary event with its host", () => {
  const left = shape("task_left", rect(100, 100, 100, 80));
  const right = shape("task_right", rect(300, 100, 100, 80));
  const boundary = shape("errorEvent_left", rect(172, 162, 36, 36), { attachedTo: "task_left", type: "BoundaryEvent" });
  const edge = flow("flow_lr", "task_left", "task_right", [
    { x: 200, y: 140 },
    { x: 300, y: 140 },
  ]);

  const { plane: result, moved } = makeSpace(plane([left, right, boundary], [edge]), {
    axis: "x",
    line: 250,
    delta: 50,
  });

  assert.deepEqual([...moved], ["task_right"]);
  assert.equal(result.shapes.find((candidate) => candidate.id === "task_right")?.bounds.x, 350);
  assert.equal(result.shapes.find((candidate) => candidate.id === "errorEvent_left")?.bounds.x, 172);
  assert.deepEqual(result.edges[0]?.waypoints, [
    { x: 200, y: 140 },
    { x: 350, y: 140 },
  ]);
});

test("makeSpace keeps the given shapes in place", () => {
  const kept = shape("task_kept", rect(300, 100, 100, 80));

  const { moved } = makeSpace(plane([kept]), { axis: "x", line: 250, delta: 50 }, new Set(["task_kept"]));

  assert.equal(moved.size, 0);
});

test("makeSpace on the side before the line moves shapes and waypoints in front of it", () => {
  const upper = shape("task_upper", rect(100, 0, 100, 80));
  const lower = shape("task_lower", rect(100, 200, 100, 80));
  const edge = flow("flow_ul", "task_upper", "task_lower", [
    { x: 150, y: 80 },
    { x: 150, y: 200 },
  ]);

  const { plane: result, moved } = makeSpace(plane([upper, lower], [edge]), {
    axis: "y",
    line: 100,
    delta: -50,
    side: "before",
  });

  assert.deepEqual([...moved], ["task_upper"]);
  assert.equal(result.shapes[0]?.bounds.y, -50);
  assert.deepEqual(result.edges[0]?.waypoints, [
    { x: 150, y: 30 },
    { x: 150, y: 200 },
  ]);
});
