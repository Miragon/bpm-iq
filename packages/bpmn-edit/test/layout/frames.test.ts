import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiagramPlane, DiagramShape } from "../../src/diagram/plane.ts";
import { readPlanes } from "../../src/diagram/reader.ts";
import type { Rect } from "../../src/geometry/geometry.ts";
import { alignEndEvents } from "../../src/layout/end-events.ts";
import { withinHardLimits } from "../../src/layout/score.ts";
import { makeSpace } from "../../src/layout/space.ts";
import { separate } from "../../src/layout/tidy.ts";
import { measurePlane } from "../../src/metrics/metrics.ts";
import { countOutsideFrames } from "../../src/metrics/rules.ts";
import { fixture } from "../support/fixtures.ts";

async function lanes(): Promise<DiagramPlane> {
  const [plane] = await readPlanes(fixture("lanes.bpmn"), "lanes.bpmn");
  assert.ok(plane);
  return plane;
}

function boundsOf(plane: DiagramPlane, id: string): Rect {
  const bounds = plane.shapes.find((shape) => shape.id === id)?.bounds;
  assert.ok(bounds, `no shape ${id}`);
  return bounds;
}

function moved(plane: DiagramPlane, id: string, bounds: Partial<Rect>): DiagramPlane {
  const shift = (shape: DiagramShape): DiagramShape =>
    shape.id === id ? { ...shape, bounds: { ...shape.bounds, ...bounds } } : shape;
  return { ...plane, shapes: plane.shapes.map(shift) };
}

test("the reader knows the pool and the lane of every flow node and the pool of every lane", async () => {
  const plane = await lanes();
  const member = (id: string): [string | undefined, string | undefined] => {
    const shape = plane.shapes.find((candidate) => candidate.id === id);
    return [shape?.pool, shape?.lane];
  };

  assert.deepEqual(member("task_check"), ["Pool_Order", "Lane_Sales"]);
  assert.deepEqual(member("endEvent_shipped"), ["Pool_Order", "Lane_Stock"]);
  assert.deepEqual(member("Lane_Stock"), ["Pool_Order", undefined]);
  assert.deepEqual(member("Pool_Customer"), [undefined, undefined]);
});

test("separate brings a flow node dragged into another lane back into its own lane", async () => {
  const dragged = moved(await lanes(), "task_pick", { y: 110 });

  const { plane: result } = separate(dragged);

  assert.equal(countOutsideFrames(dragged), 1);
  assert.equal(countOutsideFrames(result), 0);
});

test("separate lets a crowded lane grow and moves the lanes and pools below it down", async () => {
  const plane = await lanes();
  // a second task in the lower lane, just below the first one
  const extra: DiagramShape = {
    id: "task_extra",
    type: "Task",
    bounds: { x: 420, y: 245, width: 100, height: 80 },
    container: false,
    lane: "Lane_Stock",
    pool: "Pool_Order",
  };
  const crowded: DiagramPlane = { ...plane, shapes: [...plane.shapes, extra] };

  const { plane: result } = separate(crowded);
  const stock = boundsOf(result, "Lane_Stock");

  assert.equal(measurePlane(result).shapeOverlaps, 0);
  assert.ok(stock.height > 125);
  assert.equal(boundsOf(result, "Lane_Sales").y + boundsOf(result, "Lane_Sales").height, stock.y);
  assert.ok(boundsOf(result, "Pool_Customer").y >= stock.y + stock.height);
});

test("makeSpace grows a container that reaches across the line and moves one beyond it", async () => {
  const plane = await lanes();

  const { plane: result } = makeSpace(plane, { axis: "y", line: 250, delta: 100 });

  assert.equal(boundsOf(result, "Lane_Stock").height, 225);
  assert.equal(boundsOf(result, "Pool_Order").height, 350);
  assert.equal(boundsOf(result, "Lane_Sales").height, 125);
  assert.equal(boundsOf(result, "Pool_Customer").y, 480);
});

test("the hard limits let a step add a crossing only when it removes a more severe defect", async () => {
  const clean = measurePlane(await lanes());
  const outside = { ...clean, outsideFrames: 1 };

  assert.equal(withinHardLimits(await lanes(), { ...clean, edgeCrossings: clean.edgeCrossings - 1 }), false);
  assert.equal(withinHardLimits(await lanes(), { ...outside, edgeCrossings: clean.edgeCrossings - 1 }), true);
});

test("alignEndEvents puts the end events of a pool in its column and widens the pool and its lanes for it", async () => {
  // the task moves right up to the border of the pool, the end event sits left of it
  const plane = moved(moved(await lanes(), "task_pick", { x: 580 }), "endEvent_shipped", { x: 450 });

  const { plane: result, moved: ids } = alignEndEvents(plane);
  const end = boundsOf(result, "endEvent_shipped");

  assert.deepEqual([...ids], ["endEvent_shipped"]);
  assert.ok(end.x > 680);
  assert.ok(boundsOf(result, "Pool_Order").x + boundsOf(result, "Pool_Order").width >= end.x + end.width);
  assert.equal(
    boundsOf(result, "Lane_Stock").x + boundsOf(result, "Lane_Stock").width,
    boundsOf(result, "Pool_Order").x + boundsOf(result, "Pool_Order").width,
  );
  assert.equal(countOutsideFrames(result), 0);
});

test("separate keeps nested lanes inside their parent lane and lets the crowded one grow", () => {
  const frame = (id: string, type: string, bounds: Rect, extra: Partial<DiagramShape> = {}): DiagramShape => ({
    id,
    type,
    bounds,
    container: true,
    ...extra,
  });
  const task = (id: string, y: number): DiagramShape => ({
    id,
    type: "Task",
    bounds: { x: 200, y, width: 100, height: 80 },
    container: false,
    lane: "Lane_Lower",
    pool: "Pool_Nested",
  });
  const nested: DiagramPlane = {
    id: "Collaboration_Nested",
    shapes: [
      frame("Pool_Nested", "Participant", { x: 0, y: 0, width: 600, height: 300 }),
      frame("Lane_Outer", "Lane", { x: 30, y: 0, width: 570, height: 300 }, { pool: "Pool_Nested" }),
      frame(
        "Lane_Upper",
        "Lane",
        { x: 60, y: 0, width: 540, height: 150 },
        { pool: "Pool_Nested", lane: "Lane_Outer" },
      ),
      frame(
        "Lane_Lower",
        "Lane",
        { x: 60, y: 150, width: 540, height: 150 },
        { pool: "Pool_Nested", lane: "Lane_Outer" },
      ),
      task("task_first", 170),
      task("task_second", 190),
    ],
    edges: [],
  };

  const { plane: result } = separate(nested);
  const [upper, lower, outer] = ["Lane_Upper", "Lane_Lower", "Lane_Outer"].map((id) => boundsOf(result, id));
  assert.ok(upper && lower && outer);

  assert.equal(measurePlane(result).shapeOverlaps, 0);
  assert.equal(countOutsideFrames(result), 0);
  assert.ok(lower.height > 150);
  assert.equal(upper.y + upper.height, lower.y);
  assert.equal(lower.y + lower.height, outer.y + outer.height);
});
