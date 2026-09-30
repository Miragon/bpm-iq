import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiagramEdge, DiagramShape } from "../../src/diagram/plane.ts";
import { withForks } from "../../src/layout/router/branches.ts";
import { DOWN, LEFT, RIGHT, UP } from "../../src/layout/router/ports.ts";
import { flow, plane, rect, shape } from "../support/fixtures.ts";

const split = shape("gateway_split", rect(100, 100, 50, 50), { type: "ExclusiveGateway" });
const right = {
  from: { point: { x: 150, y: 125 }, direction: RIGHT },
  to: { point: { x: 300, y: 140 }, direction: LEFT },
};
const down = { from: { point: { x: 125, y: 150 }, direction: DOWN }, to: right.to };
// a sibling already leaving the gateway to the right, straight on into its row
const straight = flow("flow_straight", "gateway_split", "task_level", [
  { x: 150, y: 125 },
  { x: 300, y: 125 },
]);
const level = shape("task_level", rect(300, 85, 100, 80));

function forks(source: DiagramShape, target: DiagramShape, siblings: readonly DiagramEdge[]) {
  const edge = flow("flow_branch", source.id, target.id, []);
  return (candidates: readonly (typeof right)[]) =>
    withForks(plane([source, target, level], [...siblings, edge]), edge, candidates);
}

test("withForks turns a branch sharing the right side of its gateway into a fork 30 px behind it", () => {
  const work = shape("task_work", rect(300, 250, 100, 80));

  const [forked, plain] = forks(split, work, [straight])([right, down]);

  assert.deepEqual(forked, {
    ...right,
    lead: { x: 150, y: 125 },
    from: { point: { x: 180, y: 125 }, direction: DOWN },
  });
  assert.deepEqual(plain, down);
  assert.equal(forks(split, shape("task_above", rect(300, -100, 100, 80)), [straight])([right])[0]?.from.direction, UP);
});

test("withForks leaves a branch alone on the right side, into its own row or out of anything but a gateway as it is", () => {
  const work = shape("task_work", rect(300, 250, 100, 80));
  const task = shape("task_source", rect(50, 85, 100, 80));

  assert.deepEqual(forks(split, work, [])([right]), [right]);
  assert.deepEqual(forks(split, level, [straight])([right]), [right]);
  assert.deepEqual(forks(task, work, [])([right]), [right]);
});
