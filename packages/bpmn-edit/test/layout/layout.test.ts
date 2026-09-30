import assert from "node:assert/strict";
import { test } from "node:test";

import { choose } from "../../src/layout/choice.ts";
import { computeLayout, layout } from "../../src/layout/layout.ts";
import { fixture, flow, plane, rect, shape } from "../support/fixtures.ts";

test("layout tidy removes an overlap and reports the metrics before and after", async () => {
  const overlapping = fixture("ops.bpmn").replace('<dc:Bounds x="550" y="80"', '<dc:Bounds x="330" y="80"');

  const outcome = await layout(overlapping, { mode: "tidy", scope: { kind: "all" } }, "ops.bpmn");

  assert.ok((outcome.before[0]?.shapeOverlaps ?? 0) > 0);
  assert.equal(outcome.after[0]?.shapeOverlaps, 0);
  assert.ok(outcome.movedIds.length > 0);
});

test("layout leaves a plane alone when a step would not improve it and says so", async () => {
  const tidied = await layout(fixture("ops.bpmn"), { mode: "tidy", scope: { kind: "all" } }, "ops.bpmn");

  const outcome = await layout(tidied.xml, { mode: "tidy", scope: { kind: "all" } }, "ops.bpmn");

  assert.equal(outcome.xml, tidied.xml);
  assert.match(outcome.result.diagnostics[0]?.message ?? "", /would not improve plane 'Process_Ops'/);
});

test("layout tidy lines up the end events in one column on the right", async () => {
  const early = fixture("ops.bpmn").replace('<dc:Bounds x="752" y="252"', '<dc:Bounds x="600" y="252"');

  const outcome = await layout(early, { mode: "tidy", scope: { kind: "all" } }, "ops.bpmn");

  assert.ok((outcome.before[0]?.endEventsOffColumn ?? 0) > 0);
  assert.equal(outcome.after[0]?.endEventsOffColumn, 0);
  assert.equal(outcome.after[0]?.wrongSideFlows, 0);
});

test("computeLayout returns geometry only for what changed", async () => {
  const overlapping = fixture("ops.bpmn").replace('<dc:Bounds x="550" y="80"', '<dc:Bounds x="330" y="80"');

  const result = await computeLayout(overlapping, { mode: "tidy", scope: { kind: "all" } }, "ops.bpmn");

  assert.ok(result.shapes.length > 0 && result.shapes.length < 6);
  assert.ok(result.shapes.every((shape) => Number.isInteger(shape.x) && Number.isInteger(shape.y)));
});

test("layout rejects a scope without a plane that holds all elements", async () => {
  await assert.rejects(
    layout(fixture("ops.bpmn"), { mode: "relayout", scope: { kind: "fragmentOf", ids: ["nope"] } }, "ops.bpmn"),
    /no one plane with all given elements/,
  );
});

test("relayout never takes a variant that adds a crossing, a shape overlap or a flow through a shape", async () => {
  const outcome = await layout(
    fixture("ops.bpmn"),
    { mode: "relayout", scope: { kind: "fragmentOf", ids: ["task_ship"] } },
    "ops.bpmn",
  );
  const [before, after] = [outcome.before[0], outcome.after[0]];

  assert.ok(before && after);
  assert.ok(after.edgeCrossings <= before.edgeCrossings);
  assert.ok(after.shapeOverlaps <= before.shapeOverlaps);
  assert.ok(after.edgeThroughShape <= before.edgeThroughShape);
});

test("choose places only the covering labels anew when a new layout is no better than that", () => {
  const start = shape("startEvent_start", rect(0, 22, 36, 36), { type: "StartEvent", label: rect(110, 30, 60, 14) });
  const task = shape("task_work", rect(100, 0, 100, 80));
  const edge = flow("flow_startToWork", "startEvent_start", "task_work", [
    { x: 36, y: 40 },
    { x: 100, y: 40 },
  ]);
  const original = plane([start, task], [edge]);
  const worse = plane(
    [start, { ...task, bounds: rect(600, 0, 100, 80) }],
    [
      {
        ...edge,
        waypoints: [
          { x: 36, y: 40 },
          { x: 600, y: 40 },
        ],
      },
    ],
  );

  const chosen = choose(original, [{ plane: worse, moved: new Set(["task_work"]) }], "relayout");

  assert.match(chosen.diagnostics[0]?.message ?? "", /only covering labels placed anew/);
  assert.equal(chosen.after.shapes[1]?.bounds.x, 100);
  assert.notDeepEqual(chosen.after.shapes[0]?.label, start.label);
});
