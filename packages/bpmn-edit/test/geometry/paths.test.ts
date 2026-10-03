import assert from "node:assert/strict";
import test from "node:test";

import { sharedStart, trimStart } from "../../src/geometry/paths.ts";

const trunkUp = [
  { x: 0, y: 0 },
  { x: 30, y: 0 },
  { x: 30, y: -100 },
  { x: 100, y: -100 },
];
const trunkDown = [
  { x: 0, y: 0 },
  { x: 30, y: 0 },
  { x: 30, y: 100 },
  { x: 100, y: 100 },
];
const straight = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
];

test("two flows share the way from their common start up to where they fork", () => {
  assert.equal(sharedStart(trunkUp, trunkDown), 30);
  assert.equal(sharedStart(straight, trunkDown), 30);
  assert.equal(sharedStart(straight, [{ x: 0, y: 10 }, ...straight.slice(1)]), 0);
});

test("trimming drops the shared start and keeps the rest of the route", () => {
  assert.deepEqual(trimStart(trunkDown, 30), trunkDown.slice(1));
  assert.deepEqual(trimStart(straight, 30), [
    { x: 30, y: 0 },
    { x: 100, y: 0 },
  ]);
  assert.deepEqual(trimStart(straight, 0), straight);
});

test("a repeated waypoint neither stops nor stalls the shared start", () => {
  const repeated = [{ x: 0, y: 0 }, ...trunkDown];

  assert.equal(sharedStart(repeated, trunkUp), 30);
});

test("trimming more than the whole route leaves its end point", () => {
  assert.deepEqual(trimStart(straight, 500), [{ x: 100, y: 0 }]);
});
