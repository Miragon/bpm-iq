import assert from "node:assert/strict";
import { test } from "node:test";

import { segmentCrossesRect, segmentsOf } from "../../src/geometry/geometry.ts";
import { reroute } from "../../src/layout/reroute.ts";
import { routeEdge } from "../../src/layout/router/router.ts";
import { flow, plane, rect, shape } from "../support/fixtures.ts";

const source = shape("task_a", rect(100, 100, 100, 80));
const blocker = shape("task_blocker", rect(300, 100, 100, 80));
const target = shape("task_b", rect(500, 100, 100, 80));

test("routeEdge routes orthogonally around a shape in the way, out right and in left of activities", () => {
  const route = routeEdge(plane([source, blocker, target]), flow("flow_ab", "task_a", "task_b", []));

  assert.ok(route);
  assert.deepEqual(route[0], { x: 200, y: 140 });
  assert.deepEqual(route.at(-1), { x: 500, y: 140 });
  assert.ok(segmentsOf(route).every(([start, end]) => start.x === end.x || start.y === end.y));
  assert.ok(segmentsOf(route).every((segment) => !segmentCrossesRect(segment, blocker.bounds)));
});

test("routeEdge takes the straight line when nothing is in the way", () => {
  const route = routeEdge(plane([source, target]), flow("flow_ab", "task_a", "task_b", []));

  assert.deepEqual(route, [
    { x: 200, y: 140 },
    { x: 500, y: 140 },
  ]);
});

test("routeEdge leaves a boundary event downwards", () => {
  const boundary = shape("errorEvent_a", rect(172, 162, 36, 36), { attachedTo: "task_a", type: "BoundaryEvent" });
  const below = shape("task_c", rect(300, 300, 100, 80));

  const route = routeEdge(plane([source, boundary, below]), flow("flow_errorToC", "errorEvent_a", "task_c", []));

  assert.deepEqual(route?.slice(0, 2), [
    { x: 190, y: 198 },
    { x: 190, y: 340 },
  ]);
});

test("routeEdge returns undefined when an end has no shape", () => {
  assert.equal(routeEdge(plane([source]), flow("flow_x", "task_a", "task_missing", [])), undefined);
});

test("routeEdge falls back to the window of the whole plane when a wall blocks the near one", () => {
  const wall = shape("task_wall", rect(300, -1000, 100, 2200));

  const route = routeEdge(plane([source, wall, target]), flow("flow_ab", "task_a", "task_b", []));

  assert.ok(route);
  assert.ok(route.some((point) => point.y < -1000 || point.y > 1200));
  assert.ok(segmentsOf(route).every((segment) => !segmentCrossesRect(segment, wall.bounds)));
});

test("reroute keeps the waypoints of a flow that cannot be routed", () => {
  const walls = [
    shape("wall_top", rect(450, 0, 200, 60)),
    shape("wall_bottom", rect(450, 220, 200, 60)),
    shape("wall_left", rect(420, 0, 60, 280)),
    shape("wall_right", rect(620, 0, 60, 280)),
  ];
  const waypoints = [
    { x: 200, y: 140 },
    { x: 500, y: 140 },
  ];

  const result = reroute(
    plane([source, target, ...walls], [flow("flow_ab", "task_a", "task_b", waypoints)]),
    new Set(["flow_ab"]),
  );

  assert.deepEqual(result.edges[0]?.waypoints, waypoints);
});
