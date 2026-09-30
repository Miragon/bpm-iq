import assert from "node:assert/strict";
import { test } from "node:test";

import { rectGap } from "../../src/geometry/geometry.ts";
import { separate } from "../../src/layout/tidy.ts";
import { plane, rect, shape } from "../support/fixtures.ts";

test("separate removes an overlap with at least the minimum gap and keeps the order", () => {
  const first = shape("task_first", rect(100, 100, 100, 80));
  const second = shape("task_second", rect(150, 100, 100, 80));

  const { plane: result, moved } = separate(plane([first, second]));
  const [a, b] = result.shapes;

  assert.equal(moved.size, 2);
  assert.ok(a && b && rectGap(a.bounds, b.bounds) >= 19.5);
  assert.ok(a && b && a.bounds.x < b.bounds.x);
});

test("separate leaves a pinned shape in place and moves the other one", () => {
  const pinned = shape("task_pinned", rect(100, 100, 100, 80));
  const free = shape("task_free", rect(150, 100, 100, 80));

  const { plane: result, moved } = separate(plane([pinned, free]), new Set(["task_pinned"]));

  assert.deepEqual([...moved], ["task_free"]);
  assert.deepEqual(result.shapes[0]?.bounds, pinned.bounds);
});

test("separate does not move shapes that already keep their distance", () => {
  const { moved } = separate(plane([shape("task_a", rect(0, 0, 100, 80)), shape("task_b", rect(200, 0, 100, 80))]));

  assert.equal(moved.size, 0);
});
