import assert from "node:assert/strict";
import { test } from "node:test";

import { rectGap } from "../../src/geometry/geometry.ts";
import { brokenEdges, repairBroken } from "../../src/layout/reroute.ts";
import { routeEdge } from "../../src/layout/router/router.ts";
import { moveShape } from "../../src/layout/space.ts";
import { stretchFlows } from "../../src/layout/stretch.ts";
import { separate } from "../../src/layout/tidy.ts";
import { flow, plane, rect, shape } from "../support/fixtures.ts";

const a = shape("task_a", rect(100, 100, 100, 80));
const b = shape("task_b", rect(400, 100, 100, 80));
const straight = flow("flow_ab", "task_a", "task_b", [
  { x: 200, y: 140 },
  { x: 400, y: 140 },
]);

test("stretchFlows keeps a flow straight when its end moves along it and adds a jog when it moves across", () => {
  const before = plane([a, b], [straight]);
  const along = plane([a, moveShape(b, 30, 0)], [straight]);
  const across = plane([a, moveShape(b, 0, 40)], [straight]);

  assert.deepEqual(stretchFlows(before, along, new Set(["task_b"])).plane.edges[0]?.waypoints, [
    { x: 200, y: 140 },
    { x: 430, y: 140 },
  ]);
  assert.deepEqual(stretchFlows(before, across, new Set(["task_b"])).plane.edges[0]?.waypoints, [
    { x: 200, y: 140 },
    { x: 300, y: 140 },
    { x: 300, y: 180 },
    { x: 400, y: 180 },
  ]);
});

test("stretchFlows leaves a flow for routing when the jog would leave stubs shorter than 20 px", () => {
  const close = plane(
    [a, shape("task_b", rect(230, 100, 100, 80))],
    [
      flow("flow_ab", "task_a", "task_b", [
        { x: 200, y: 140 },
        { x: 230, y: 140 },
      ]),
    ],
  );
  const moved = plane([a, shape("task_b", rect(230, 110, 100, 80))], close.edges.slice());

  assert.deepEqual([...stretchFlows(close, moved, new Set(["task_b"])).unresolved], ["flow_ab"]);
});

test("routeEdge connects shapes facing each other closer than two stubs with a straight line", () => {
  const near = shape("task_b", rect(225, 100, 100, 80));

  assert.deepEqual(routeEdge(plane([a, near]), flow("flow_ab", "task_a", "task_b", [])), [
    { x: 200, y: 140 },
    { x: 225, y: 140 },
  ]);
});

test("repairBroken reconnects a flow that a step left loose, not one that was loose before", () => {
  const moved = plane([a, moveShape(b, 0, 200)], [straight]);
  const looseBefore = plane(
    [a, b],
    [
      flow("flow_ab", "task_a", "task_b", [
        { x: 150, y: 400 },
        { x: 400, y: 400 },
      ]),
    ],
  );

  assert.deepEqual([...brokenEdges(moved)], ["flow_ab"]);
  assert.equal(brokenEdges(repairBroken(plane([a, b], [straight]), moved)).size, 0);
  assert.deepEqual(repairBroken(looseBefore, looseBefore).edges[0]?.waypoints, looseBefore.edges[0]?.waypoints);
});

test("separate takes back a small sideways shift when the shape keeps its distance without it", () => {
  const row = [shape("task_a", rect(100, 100, 100, 80)), shape("task_b", rect(210, 102, 100, 80))];

  const { plane: result } = separate(plane(row));

  const [first, second] = result.shapes;
  assert.equal(second?.bounds.y, 102);
  assert.ok(first && second && rectGap(first.bounds, second.bounds) >= 20);
});

test("separate keeps the minimum gap between all shapes after taking back small shifts", () => {
  const crowded = [
    shape("task_a", rect(100, 100, 100, 80)),
    shape("task_b", rect(205, 103, 100, 80)),
    shape("task_c", rect(312, 98, 100, 80)),
    shape("task_d", rect(210, 195, 100, 80)),
  ];

  const { plane: result } = separate(plane(crowded));

  result.shapes.forEach((first, index) => {
    for (const second of result.shapes.slice(index + 1)) {
      assert.ok(rectGap(first.bounds, second.bounds) >= 20, `${first.id} and ${second.id} are too close`);
    }
  });
});
