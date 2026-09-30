import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiagramPlane, DiagramShape } from "../../src/diagram/plane.ts";
import { readPlanes } from "../../src/diagram/reader.ts";
import type { Rect } from "../../src/geometry/geometry.ts";
import { alignEndEvents } from "../../src/layout/end-events.ts";
import { separate } from "../../src/layout/tidy.ts";
import { measurePlane } from "../../src/metrics/metrics.ts";
import { countOutsideFrames } from "../../src/metrics/rules.ts";
import { fixture } from "../support/fixtures.ts";

function node(id: string, bounds: Rect, parent?: string, type = "Task"): DiagramShape {
  return { id, type, bounds, container: false, ...(parent ? { parent } : {}) };
}

function subProcess(id: string, bounds: Rect, parent?: string): DiagramShape {
  return { id, type: "SubProcess", bounds, container: true, ...(parent ? { parent } : {}) };
}

function boundsOf(plane: DiagramPlane, id: string): Rect {
  const bounds = plane.shapes.find((shape) => shape.id === id)?.bounds;
  assert.ok(bounds, `no shape ${id}`);
  return bounds;
}

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

test("the reader knows the expanded sub-process that holds a flow node", async () => {
  const [plane] = await readPlanes(fixture("planes.bpmn"), "planes.bpmn");

  assert.equal(plane?.shapes.find((shape) => shape.id === "task_insideExpanded")?.parent, "subProcess_expanded");
  assert.equal(plane?.shapes.find((shape) => shape.id === "serviceTask_work")?.parent, undefined);
});

test("separate brings the content of a sub-process back inside and lets the sub-process grow around it", () => {
  const plane: DiagramPlane = {
    id: "Process_Sub",
    shapes: [
      subProcess("subProcess_outer", { x: 100, y: 100, width: 300, height: 200 }),
      node("task_first", { x: 150, y: 150, width: 100, height: 80 }, "subProcess_outer"),
      // overlaps the first task and sticks out of the sub-process on the right
      node("task_second", { x: 340, y: 160, width: 100, height: 80 }, "subProcess_outer"),
    ],
    edges: [],
  };

  const { plane: result } = separate(plane);
  const outer = boundsOf(result, "subProcess_outer");

  assert.equal(measurePlane(result).shapeOverlaps, 0);
  assert.ok(inside(boundsOf(result, "task_first"), outer));
  assert.ok(inside(boundsOf(result, "task_second"), outer));
  assert.ok(outer.width >= 300);
});

test("separate moves a sub-process with its content when it gives way on its own level", () => {
  const plane: DiagramPlane = {
    id: "Process_Sub",
    shapes: [
      node("task_before", { x: 100, y: 120, width: 100, height: 80 }),
      subProcess("subProcess_next", { x: 180, y: 100, width: 250, height: 150 }),
      node("task_inner", { x: 250, y: 140, width: 100, height: 80 }, "subProcess_next"),
    ],
    edges: [],
  };

  const { plane: result } = separate(plane);
  const before = boundsOf(plane, "task_inner");
  const after = boundsOf(result, "task_inner");
  const shift = boundsOf(result, "subProcess_next").x - 180;

  assert.equal(measurePlane(result).shapeOverlaps, 0);
  assert.ok(shift !== 0);
  assert.equal(after.x - before.x, shift);
  assert.ok(inside(after, boundsOf(result, "subProcess_next")));
  assert.equal(countOutsideFrames(result), 0);
});

test("alignEndEvents lines up the end events of a sub-process in a column of their own inside it", () => {
  const plane: DiagramPlane = {
    id: "Process_Sub",
    shapes: [
      subProcess("subProcess_outer", { x: 100, y: 100, width: 500, height: 250 }),
      node("task_inner", { x: 300, y: 150, width: 100, height: 80 }, "subProcess_outer"),
      node("endEvent_inner", { x: 150, y: 250, width: 36, height: 36 }, "subProcess_outer", "EndEvent"),
      node("task_outer", { x: 700, y: 150, width: 100, height: 80 }),
    ],
    edges: [],
  };

  const { plane: result } = alignEndEvents(plane);
  const end = boundsOf(result, "endEvent_inner");

  assert.ok(end.x > 400);
  assert.ok(inside(end, boundsOf(result, "subProcess_outer")));
});

test("separate keeps a boundary event on the bottom border of a sub-process that grows to the left and down", () => {
  const plane: DiagramPlane = {
    id: "Process_Sub",
    shapes: [
      subProcess("subProcess_host", { x: 200, y: 100, width: 300, height: 150 }),
      // too close to the left and bottom border: the sub-process has to grow there
      node("task_inner", { x: 205, y: 160, width: 100, height: 80 }, "subProcess_host"),
      {
        id: "errorEvent_host",
        type: "BoundaryEvent",
        bounds: { x: 400, y: 232, width: 36, height: 36 },
        container: false,
        attachedTo: "subProcess_host",
      },
    ],
    edges: [],
  };

  const { plane: result } = separate(plane);
  const host = boundsOf(result, "subProcess_host");
  const event = boundsOf(result, "errorEvent_host");

  assert.ok(host.x < 200 && host.y + host.height > 250);
  assert.equal(event.y + event.height / 2, host.y + host.height);
  assert.equal(event.x - host.x, 400 - 200);
});
