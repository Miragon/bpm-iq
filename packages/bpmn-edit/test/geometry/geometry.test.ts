import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boundingBox,
  collinearOverlap,
  isBend,
  rectGap,
  rectsOverlap,
  segmentCrossesRect,
  segmentsCross,
  segmentsOf,
} from "../../src/geometry/geometry.ts";
import { rect } from "../support/fixtures.ts";

test("rectsOverlap counts shared interior only, touching edges do not overlap", () => {
  assert.equal(rectsOverlap(rect(0, 0, 100, 80), rect(50, 40, 100, 80)), true);
  assert.equal(rectsOverlap(rect(0, 0, 100, 80), rect(100, 0, 100, 80)), false);
});

test("rectGap is the free space along the separating axis and 0 for overlapping rectangles", () => {
  assert.equal(rectGap(rect(0, 0, 100, 80), rect(110, 0, 100, 80)), 10);
  assert.equal(rectGap(rect(0, 0, 100, 80), rect(110, 200, 100, 80)), 120);
  assert.equal(rectGap(rect(0, 0, 100, 80), rect(50, 40, 100, 80)), 0);
});

test("segmentsCross detects a proper crossing but not a T-junction or parallel lines", () => {
  const horizontal = [
    { x: 0, y: 50 },
    { x: 100, y: 50 },
  ] as const;
  assert.equal(
    segmentsCross(horizontal, [
      { x: 50, y: 0 },
      { x: 50, y: 100 },
    ]),
    true,
  );
  assert.equal(
    segmentsCross(horizontal, [
      { x: 50, y: 0 },
      { x: 50, y: 50 },
    ]),
    false,
  );
  assert.equal(
    segmentsCross(horizontal, [
      { x: 0, y: 60 },
      { x: 100, y: 60 },
    ]),
    false,
  );
});

test("collinearOverlap measures the common stretch of two axis-parallel segments on one line", () => {
  const first = [
    { x: 0, y: 50 },
    { x: 100, y: 50 },
  ] as const;
  assert.equal(
    collinearOverlap(first, [
      { x: 60, y: 50 },
      { x: 200, y: 50 },
    ]),
    40,
  );
  assert.equal(
    collinearOverlap(first, [
      { x: 60, y: 51 },
      { x: 200, y: 51 },
    ]),
    0,
  );
  assert.equal(
    collinearOverlap(
      [
        { x: 10, y: 0 },
        { x: 10, y: 100 },
      ],
      [
        { x: 10, y: 90 },
        { x: 10, y: 30 },
      ],
    ),
    60,
  );
});

test("segmentCrossesRect finds segments through the interior, not along the border or outside", () => {
  const box = rect(100, 100, 100, 80);
  assert.equal(
    segmentCrossesRect(
      [
        { x: 0, y: 140 },
        { x: 300, y: 140 },
      ],
      box,
    ),
    true,
  );
  assert.equal(
    segmentCrossesRect(
      [
        { x: 0, y: 100 },
        { x: 300, y: 100 },
      ],
      box,
    ),
    false,
  );
  assert.equal(
    segmentCrossesRect(
      [
        { x: 0, y: 140 },
        { x: 100, y: 140 },
      ],
      box,
    ),
    false,
  );
  assert.equal(
    segmentCrossesRect(
      [
        { x: 0, y: 0 },
        { x: 300, y: 300 },
      ],
      box,
    ),
    true,
  );
});

test("isBend is true for a change of direction only", () => {
  assert.equal(isBend({ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }), true);
  assert.equal(isBend({ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }), false);
});

test("isBend ignores a sub-pixel wobble on long segments, the tolerance is a distance", () => {
  assert.equal(isBend({ x: 0, y: 0 }, { x: 100, y: 0.2 }, { x: 200, y: 0 }), false);
  assert.equal(isBend({ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1 }), true);
});

test("segmentsOf and boundingBox cover all points and rectangles", () => {
  assert.equal(
    segmentsOf([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]).length,
    2,
  );
  assert.deepEqual(boundingBox([rect(10, 10, 20, 20)], [{ x: 0, y: 50 }]), rect(0, 10, 30, 40));
  assert.equal(boundingBox([], []), undefined);
});
