import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiagramEdge } from "../../src/diagram/plane.ts";
import { distantLabels, placeLabels } from "../../src/layout/labels.ts";
import { plane, rect, shape } from "../support/fixtures.ts";

test("placeLabels keeps the label of a flow at the flow even when no segment is long enough for it", () => {
  const split = shape("gateway_split", rect(100, 100, 50, 50), { type: "ExclusiveGateway" });
  const work = shape("task_work", rect(190, 85, 100, 80));
  // a wide label left far away by the old drawing, on a flow of only 40 px
  const short: DiagramEdge = {
    id: "flow_splitToWork",
    type: "SequenceFlow",
    source: "gateway_split",
    target: "task_work",
    waypoints: [
      { x: 150, y: 125 },
      { x: 190, y: 125 },
    ],
    label: rect(600, 900, 120, 40),
  };

  const placed = placeLabels(plane([split, work], [short]), new Set(["flow_splitToWork"]));
  const label = placed.edges[0]?.label;

  assert.ok(label);
  assert.ok(Math.abs(label.y + label.height / 2 - 125) < label.height);
  assert.ok(label.x < 190 && label.x + label.width > 150);
});

test("distantLabels finds a label left far away from its element", () => {
  const near = shape("endEvent_near", rect(0, 0, 36, 36), { type: "EndEvent", label: rect(0, 44, 60, 14) });
  const lost = shape("endEvent_lost", rect(200, 0, 36, 36), { type: "EndEvent", label: rect(600, 600, 60, 14) });

  assert.deepEqual([...distantLabels(plane([near, lost]))], ["endEvent_lost"]);
});

test("placeLabels puts the labels of forking branches on the branches, right behind the fork and lined up", () => {
  const split = shape("gateway_split", rect(100, 100, 50, 50), { type: "ExclusiveGateway" });
  const targets = [
    shape("task_upper", rect(400, -65, 100, 80)),
    shape("task_middle", rect(400, 85, 100, 80)),
    shape("task_lower", rect(400, 235, 100, 80)),
  ];
  const branch = (id: string, y: number): DiagramEdge => ({
    id,
    type: "SequenceFlow",
    source: "gateway_split",
    target: `task_${id}`,
    waypoints:
      y === 125
        ? [
            { x: 150, y: 125 },
            { x: 400, y: 125 },
          ]
        : [
            { x: 150, y: 125 },
            { x: 180, y: 125 },
            { x: 180, y },
            { x: 400, y },
          ],
    label: rect(0, 0, 40, 14),
  });
  const edges = [branch("upper", -25), branch("middle", 125), branch("lower", 275)];

  const placed = placeLabels(plane([split, ...targets], edges), new Set(edges.map((edge) => edge.id)));
  const labels = placed.edges.map((edge) => edge.label);

  assert.deepEqual(
    labels.map((label) => label?.x),
    [196, 196, 196],
  );
  assert.deepEqual(
    labels.map((label) => label?.y),
    [-25 - 14 - 8, 125 - 14 - 8, 275 - 14 - 8],
  );
});

test("placeLabels hangs the question of a gateway right above it, or below it when a flow leaves at the top", () => {
  const decide = shape("gateway_decide", rect(300, 100, 50, 50), { type: "ExclusiveGateway" });
  const labelled = { ...decide, name: "Order complete?", label: rect(300, 160, 50, 40) };
  const up: DiagramEdge = {
    id: "flow_up",
    type: "SequenceFlow",
    source: "gateway_decide",
    waypoints: [
      { x: 325, y: 100 },
      { x: 325, y: 0 },
    ],
  };

  const above = placeLabels(plane([labelled], []), new Set([labelled.id])).shapes[0]?.label;
  const below = placeLabels(plane([labelled], [up]), new Set([labelled.id])).shapes[0]?.label;

  assert.ok(above && below);
  assert.equal(above.y + above.height, 100 - 4);
  assert.equal(above.x + above.width / 2, 325);
  assert.equal(below.y, 150 + 4);
});

test("placeLabels puts the label of a boundary event right beside it, below the border of its host", () => {
  const host = shape("task_work", rect(100, 100, 100, 80));
  const boundary = shape("errorEvent_failed", rect(172, 162, 36, 36), {
    attachedTo: "task_work",
    type: "BoundaryEvent",
  });
  const labelled = { ...boundary, name: "Failed", label: rect(400, 400, 40, 14) };

  const label = placeLabels(plane([host, labelled], []), new Set([labelled.id])).shapes[1]?.label;

  assert.deepEqual(label && { x: label.x, y: label.y }, { x: 208 + 4, y: 180 + 8 });
});

test("placeLabels breaks the label of a flow too short for it on one line onto two lines beside the flow", () => {
  const split = shape("gateway_split", rect(100, 100, 50, 50), { type: "ExclusiveGateway" });
  const check = shape("task_check", rect(300, 85, 100, 80));
  const edge: DiagramEdge = {
    id: "flow_splitToCheck",
    type: "SequenceFlow",
    source: "gateway_split",
    target: "task_check",
    waypoints: [
      { x: 150, y: 125 },
      { x: 300, y: 125 },
    ],
    label: rect(0, 0, 40, 14),
    name: "Keine Ressourcenübernahme",
  };

  const label = placeLabels(plane([split, check], [edge]), new Set([edge.id])).edges[0]?.label;

  assert.ok(label);
  assert.equal(label.height, 28);
  assert.ok(label.x >= 150 && label.x + label.width <= 300, JSON.stringify(label));
});
