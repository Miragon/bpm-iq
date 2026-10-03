import assert from "node:assert/strict";
import { test } from "node:test";

import { measure, measurePlane } from "../../src/metrics/metrics.ts";
import { fixture, flow, plane, rect, shape } from "../support/fixtures.ts";

const taskA = shape("task_a", rect(100, 100, 100, 80));
const taskB = shape("task_b", rect(300, 100, 100, 80));
const taskC = shape("task_c", rect(100, 300, 100, 80));
const taskD = shape("task_d", rect(300, 300, 100, 80));

test("a clean left-to-right sequence has no problem in any metric", () => {
  const metrics = measurePlane(
    plane(
      [taskA, taskB],
      [
        flow("flow_ab", "task_a", "task_b", [
          { x: 200, y: 140 },
          { x: 300, y: 140 },
        ]),
      ],
    ),
  );

  assert.deepEqual(
    [metrics.shapeOverlaps, metrics.shapeGapViolations, metrics.labelOverlaps, metrics.edgeCrossings],
    [0, 0, 0, 0],
  );
  assert.deepEqual(
    [metrics.edgeOverlaps, metrics.edgeThroughShape, metrics.bends, metrics.backwardEdges],
    [0, 0, 0, 0],
  );
  assert.deepEqual([metrics.edgeLength, metrics.width, metrics.height], [100, 300, 80]);
});

test("overlapping shapes and shapes closer than 20 px are counted, a boundary event on its host is not", () => {
  const overlapping = shape("task_overlapping", rect(150, 40, 100, 80));
  const tooClose = shape("task_tooClose", rect(210, 300, 100, 80));
  const boundary = shape("errorEvent_onA", rect(172, 162, 36, 36), { attachedTo: "task_a", type: "BoundaryEvent" });
  const pool = shape("participant_pool", rect(0, 0, 1000, 1000), { container: true, type: "Participant" });

  const metrics = measurePlane(plane([taskA, overlapping, taskC, tooClose, boundary, pool]));

  assert.equal(metrics.shapeOverlaps, 1);
  assert.equal(metrics.shapeGapViolations, 1);
});

test("crossing flows count once per pair, a join at a common element is no crossing", () => {
  const across = flow("flow_ad", "task_a", "task_d", [
    { x: 200, y: 140 },
    { x: 250, y: 140 },
    { x: 250, y: 340 },
    { x: 300, y: 340 },
  ]);
  const up = flow("flow_cb", "task_c", "task_b", [
    { x: 200, y: 340 },
    { x: 230, y: 340 },
    { x: 230, y: 100 },
    { x: 350, y: 100 },
  ]);
  const join = flow("flow_cd", "task_c", "task_d", [
    { x: 200, y: 360 },
    { x: 300, y: 360 },
  ]);

  const metrics = measurePlane(plane([taskA, taskB, taskC, taskD], [across, up, join]));

  assert.equal(metrics.edgeCrossings, 1);
  assert.equal(metrics.bends, 4);
});

test("flows merging into the same target do not count as an overlap, flows into different targets do", () => {
  const toD = flow("flow_ad", "task_a", "task_d", [
    { x: 200, y: 140 },
    { x: 250, y: 140 },
    { x: 250, y: 340 },
    { x: 300, y: 340 },
  ]);
  const cToD = flow("flow_cd", "task_c", "task_d", [
    { x: 200, y: 340 },
    { x: 300, y: 340 },
  ]);
  const cToB = flow("flow_cb", "task_c", "task_b", [
    { x: 200, y: 340 },
    { x: 280, y: 340 },
    { x: 280, y: 140 },
    { x: 300, y: 140 },
  ]);

  assert.equal(measurePlane(plane([taskA, taskB, taskC, taskD], [toD, cToD])).edgeOverlaps, 0);
  assert.equal(measurePlane(plane([taskA, taskB, taskC, taskD], [toD, cToB])).edgeOverlaps, 1);
});

test("the branches of a split may share the trunk they fork from, not run together again behind the fork", () => {
  const split = shape("gateway_split", rect(0, 0, 50, 50), { type: "ExclusiveGateway" });
  const upper = shape("task_upper", rect(200, -150, 100, 80));
  const lower = shape("task_lower", rect(200, 100, 100, 80));
  const up = flow("flow_up", "gateway_split", "task_upper", [
    { x: 50, y: 25 },
    { x: 110, y: 25 },
    { x: 110, y: -110 },
    { x: 200, y: -110 },
  ]);
  const fork = flow("flow_down", "gateway_split", "task_lower", [
    { x: 50, y: 25 },
    { x: 80, y: 25 },
    { x: 80, y: 140 },
    { x: 200, y: 140 },
  ]);
  const rejoining = flow("flow_down", "gateway_split", "task_lower", [
    { x: 50, y: 25 },
    { x: 80, y: 25 },
    { x: 80, y: -110 },
    { x: 150, y: -110 },
    { x: 150, y: 140 },
    { x: 200, y: 140 },
  ]);

  assert.equal(measurePlane(plane([split, upper, lower], [up, fork])).edgeOverlaps, 0);
  assert.equal(measurePlane(plane([split, upper, lower], [up, rejoining])).edgeOverlaps, 1);
});

test("a flow through a foreign shape counts, its source, target and boundary host do not", () => {
  const boundary = shape("errorEvent_onA", rect(172, 162, 36, 36), { attachedTo: "task_a", type: "BoundaryEvent" });
  const long = flow("flow_ad", "task_a", "task_d", [
    { x: 150, y: 140 },
    { x: 350, y: 140 },
    { x: 350, y: 300 },
  ]);
  const fromBoundary = flow("flow_boundaryToC", "errorEvent_onA", "task_c", [
    { x: 190, y: 120 },
    { x: 150, y: 300 },
  ]);

  const metrics = measurePlane(plane([taskA, taskB, taskC, taskD, boundary], [long, fromBoundary]));

  assert.equal(metrics.edgeThroughShape, 1);
});

test("labels covering a foreign flow, shape or label count, the own element does not", () => {
  const labelled = shape("startEvent_a", rect(100, 122, 36, 36), { label: rect(90, 130, 60, 14), type: "StartEvent" });
  const onShape = shape("endEvent_b", rect(400, 122, 36, 36), { label: rect(310, 110, 60, 14), type: "EndEvent" });
  const onLabel = shape("endEvent_c", rect(400, 222, 36, 36), { label: rect(95, 132, 40, 14), type: "EndEvent" });
  const edge = flow("flow_ab", "startEvent_a", "task_b", [
    { x: 136, y: 140 },
    { x: 300, y: 140 },
  ]);

  const metrics = measurePlane(plane([labelled, taskB, onShape, onLabel], [edge]));

  assert.equal(metrics.labels, 3);
  assert.equal(metrics.labelOverlaps, 4);
});

test("a sequence flow ending left of its start is a backward edge", () => {
  const back = flow("flow_ba", "task_b", "task_a", [
    { x: 350, y: 180 },
    { x: 350, y: 220 },
    { x: 150, y: 220 },
    { x: 150, y: 180 },
  ]);

  assert.equal(measurePlane(plane([taskA, taskB], [back])).backwardEdges, 1);
});

test("measure reads every plane of a document", async () => {
  const metrics = await measure(fixture("planes.bpmn"), "planes.bpmn");

  assert.deepEqual(
    metrics.map((plane) => [plane.plane, plane.edges, plane.labels]),
    [
      ["Process_Planes", 4, 2],
      ["subProcess_collapsed", 1, 1],
    ],
  );
});
