import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiagramEdge, DiagramPlane, DiagramShape } from "../../../src/diagram/plane.ts";
import { readPlanes } from "../../../src/diagram/reader.ts";
import type { Point } from "../../../src/geometry/geometry.ts";
import { layoutGlobally } from "../../../src/layout/global/global.ts";
import { gridOf } from "../../../src/layout/global/level.ts";
import { center } from "../../../src/layout/space.ts";
import { measurePlane } from "../../../src/metrics/metrics.ts";
import { fixture, plane, rect, shape } from "../../support/fixtures.ts";
import { boundsOf, event, flows, gateway, task } from "./support.ts";

/** Sequence flows whose target lies left of their source. */
function backward(result: DiagramPlane): string[] {
  return result.edges
    .filter((edge) => edge.type === "SequenceFlow")
    .filter((edge) => center(boundsOf(result, edge.target ?? "")).x < center(boundsOf(result, edge.source ?? "")).x)
    .map((edge) => edge.id);
}

// a messy drawing: everything piled up at the same place, a loop back from the check to the work
const loop = plane(
  [
    event("start", "StartEvent", 300, 300),
    task("task_work", 300, 300),
    gateway("gateway_check", 300, 300),
    task("task_finish", 300, 300),
    event("end", "EndEvent", 300, 300),
  ],
  flows([
    ["start", "task_work"],
    ["task_work", "gateway_check"],
    ["gateway_check", "task_finish"],
    ["gateway_check", "task_work"],
    ["task_finish", "end"],
  ]),
);

test("gridOf puts every node right of its predecessors and ignores the loop return", () => {
  const grid = gridOf(loop, loop.shapes);

  assert.deepEqual(
    ["start", "task_work", "gateway_check", "task_finish", "end"].map((id) => grid.column.get(id)),
    [0, 1, 2, 3, 4],
  );
});

test("gridOf puts all end events into the last column", () => {
  const ends = plane(
    [
      event("start", "StartEvent"),
      gateway("gateway_split"),
      task("task_long"),
      task("task_longer"),
      event("endEvent_early", "EndEvent"),
      event("endEvent_late", "EndEvent"),
    ],
    flows([
      ["start", "gateway_split"],
      ["gateway_split", "endEvent_early"],
      ["gateway_split", "task_long"],
      ["task_long", "task_longer"],
      ["task_longer", "endEvent_late"],
    ]),
  );

  const grid = gridOf(ends, ends.shapes);

  assert.equal(grid.column.get("endEvent_early"), 4);
  assert.equal(grid.column.get("endEvent_late"), 4);
});

test("layoutGlobally turns a messy drawing into a left to right flow; only the loop return runs back, below", () => {
  const result = layoutGlobally(loop);
  const metrics = measurePlane(result);
  const back = result.edges.find((edge) => edge.id === "flow_gateway_checkTotask_work");
  const lowest = Math.max(...result.shapes.map((node) => node.bounds.y + node.bounds.height));

  assert.equal(metrics.shapeOverlaps, 0);
  assert.equal(metrics.edgeThroughShape, 0);
  assert.deepEqual(backward(result), ["flow_gateway_checkTotask_work"]);
  assert.ok(back && Math.max(...back.waypoints.map((point) => point.y)) > lowest);
});

test("layoutGlobally puts a branch that starts later on the side where it crosses no other branch", () => {
  // split -> (upper -> join) | (split2 -> (middle -> join) | (lower -> join2)); join -> join2 -> end
  const nested = plane(
    [
      event("start", "StartEvent"),
      gateway("gateway_split"),
      task("task_upper"),
      gateway("gateway_split2"),
      task("task_middle"),
      task("task_lower"),
      task("task_lower2"),
      gateway("gateway_join"),
      gateway("gateway_join2"),
      event("end", "EndEvent"),
    ],
    flows([
      ["start", "gateway_split"],
      ["gateway_split", "gateway_split2"],
      ["gateway_split", "task_upper"],
      ["gateway_split2", "task_middle"],
      ["gateway_split2", "task_lower"],
      ["task_lower", "task_lower2"],
      ["task_upper", "gateway_join"],
      ["task_middle", "gateway_join"],
      ["gateway_join", "gateway_join2"],
      ["task_lower2", "gateway_join2"],
      ["gateway_join2", "end"],
    ]),
  );

  const result = layoutGlobally(nested);

  assert.equal(measurePlane(result).edgeCrossings, 0);
  assert.deepEqual(backward(result), []);
});

test("layoutGlobally keeps flow nodes in their lanes and the pools and lanes around them", async () => {
  const [lanes] = await readPlanes(fixture("lanes.bpmn"), "lanes.bpmn");
  assert.ok(lanes);

  const result = layoutGlobally(lanes);
  const metrics = measurePlane(result);

  assert.equal(metrics.outsideFrames, 0);
  assert.equal(metrics.shapeOverlaps, 0);
  assert.deepEqual(backward(result), []);
});

test("layoutGlobally lays out the content of an expanded sub-process inside it", async () => {
  const [main] = await readPlanes(fixture("planes.bpmn"), "planes.bpmn");
  assert.ok(main);

  const result = layoutGlobally(main);

  assert.equal(measurePlane(result).outsideFrames, 0);
  assert.equal(measurePlane(result).shapeOverlaps, 0);
});

const line = (extra: DiagramShape[], edges: DiagramEdge[] = []): DiagramPlane =>
  plane(
    [event("start", "StartEvent", 0, 22), task("task_work", 100, 0), event("end", "EndEvent", 300, 22), ...extra],
    [
      ...flows([
        ["start", "task_work"],
        ["task_work", "end"],
      ]),
      ...edges,
    ],
  );

test("layoutGlobally puts a node without flows (an event sub-process) below the grid, not into a column", () => {
  const sub = shape("subProcess_event", rect(-400, 0, 300, 200), { type: "SubProcess", container: true });

  const result = layoutGlobally(line([sub]));
  const [start, work, placed] = ["start", "task_work", "subProcess_event"].map((id) => boundsOf(result, id));

  assert.ok(start && work && placed);
  assert.ok(placed.y > work.y + work.height);
  assert.equal(work.x - (start.x + start.width), 100);
});

test("layoutGlobally keeps an annotation at its offset to the node it is associated with", () => {
  const annotation = shape("textAnnotation_note", rect(160, 190, 100, 30), { type: "TextAnnotation" });
  const association: DiagramEdge = {
    id: "association_note",
    type: "Association",
    source: "task_work",
    target: "textAnnotation_note",
    waypoints: [],
  };

  const result = layoutGlobally(line([annotation], [association]));
  const [work, note] = ["task_work", "textAnnotation_note"].map((id) => boundsOf(result, id));

  assert.ok(work && note);
  assert.deepEqual([center(note).x - center(work).x, center(note).y - center(work).y], [60, 165]);
});

test("layoutGlobally stacks the channels of nested loops, the inner loop nearest to the content", () => {
  // start -> a -> b -> inner (back to b) -> c -> outer (back to a) -> end
  const nested = plane(
    [
      event("start", "StartEvent"),
      task("task_a"),
      task("task_b"),
      gateway("gateway_inner"),
      task("task_c"),
      gateway("gateway_outer"),
      event("end", "EndEvent"),
    ],
    flows([
      ["start", "task_a"],
      ["task_a", "task_b"],
      ["task_b", "gateway_inner"],
      ["gateway_inner", "task_b"],
      ["gateway_inner", "task_c"],
      ["task_c", "gateway_outer"],
      ["gateway_outer", "task_a"],
      ["gateway_outer", "end"],
    ]),
  );

  const result = layoutGlobally(nested);
  const channel = (id: string): number =>
    Math.max(...(result.edges.find((edge) => edge.id === id)?.waypoints ?? []).map((point) => point.y));

  assert.deepEqual(backward(result).sort(), ["flow_gateway_innerTotask_b", "flow_gateway_outerTotask_a"]);
  assert.ok(channel("flow_gateway_innerTotask_b") < channel("flow_gateway_outerTotask_a"));
  assert.equal(measurePlane(result).edgeCrossings, 0);
});

test("layoutGlobally puts the branch that loops back at the bottom, so its return crosses no other branch", () => {
  // start -> work -> decide -> (end | abort end | retry -> check -> back to work)
  const retry = plane(
    [
      event("start", "StartEvent"),
      task("task_work"),
      gateway("gateway_decide"),
      event("endEvent_done", "EndEvent"),
      event("endEvent_aborted", "EndEvent"),
      task("task_retry"),
      gateway("gateway_check"),
    ],
    flows([
      ["start", "task_work"],
      ["task_work", "gateway_decide"],
      ["gateway_decide", "task_retry"],
      ["gateway_decide", "endEvent_done"],
      ["gateway_decide", "endEvent_aborted"],
      ["task_retry", "gateway_check"],
      ["gateway_check", "task_work"],
      ["gateway_check", "endEvent_done"],
    ]),
  );

  const result = layoutGlobally(retry);
  const [done, aborted, retryTask] = ["endEvent_done", "endEvent_aborted", "task_retry"].map((id) =>
    boundsOf(result, id),
  );

  assert.ok(done && aborted && retryTask);
  assert.ok(retryTask.y > done.y && retryTask.y > aborted.y);
  assert.equal(measurePlane(result).edgeCrossings, 0);
});

test("layoutGlobally lets only the loop return leave a gateway downwards; the other branches share its right side", () => {
  // start -> work -> decide -> (done | escalate | redo, back to work)
  const branches = plane(
    [
      event("start", "StartEvent"),
      task("task_work"),
      gateway("gateway_decide"),
      task("task_done"),
      task("task_escalate"),
      event("endEvent_done", "EndEvent"),
      event("endEvent_escalated", "EndEvent"),
    ],
    flows([
      ["start", "task_work"],
      ["task_work", "gateway_decide"],
      ["gateway_decide", "task_done"],
      ["gateway_decide", "task_escalate"],
      ["gateway_decide", "task_work"],
      ["task_done", "endEvent_done"],
      ["task_escalate", "endEvent_escalated"],
    ]),
  );

  const result = layoutGlobally(branches);
  const decide = boundsOf(result, "gateway_decide");
  const start = (id: string): Point | undefined => result.edges.find((edge) => edge.id === id)?.waypoints[0];
  const right = { x: decide.x + decide.width, y: decide.y + decide.height / 2 };

  assert.deepEqual(start("flow_gateway_decideTotask_done"), right);
  assert.deepEqual(start("flow_gateway_decideTotask_escalate"), right);
  assert.deepEqual(start("flow_gateway_decideTotask_work"), {
    x: decide.x + decide.width / 2,
    y: decide.y + decide.height,
  });
  assert.equal(measurePlane(result).edgeOverlaps, 0);
});

test("layoutGlobally lets all branches of a wide split leave the gateway to the right and fork right behind it", () => {
  const wide = plane(
    [
      event("start", "StartEvent"),
      gateway("gateway_kind"),
      task("task_first"),
      task("task_second"),
      task("task_third"),
      gateway("gateway_join"),
      event("end", "EndEvent"),
    ],
    flows([
      ["start", "gateway_kind"],
      ["gateway_kind", "task_first"],
      ["gateway_kind", "task_second"],
      ["gateway_kind", "task_third"],
      ["task_first", "gateway_join"],
      ["task_second", "gateway_join"],
      ["task_third", "gateway_join"],
      ["gateway_join", "end"],
    ]),
  );

  const result = layoutGlobally(wide);
  const kind = boundsOf(result, "gateway_kind");
  const right = kind.x + kind.width;
  const branches = ["task_first", "task_second", "task_third"].map(
    (id) => result.edges.find((edge) => edge.id === `flow_gateway_kindTo${id}`)?.waypoints ?? [],
  );

  for (const [start, turn, ...rest] of branches) {
    assert.deepEqual(start, { x: right, y: kind.y + kind.height / 2 });
    // a branch into another row turns off the trunk at most 50 px behind the gateway
    assert.ok(
      rest.length === 0 || (turn && turn.x - right <= 50),
      `forks at ${String(turn?.x)}, gateway ends at ${String(right)}`,
    );
  }
  assert.equal(measurePlane(result).edgeOverlaps, 0);
});
