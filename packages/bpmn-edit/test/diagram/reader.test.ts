import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiagramShape } from "../../src/diagram/plane.ts";
import { readPlanes } from "../../src/diagram/reader.ts";
import { BpmnEditError } from "../../src/utils/errors.ts";
import { fixture, rect } from "../support/fixtures.ts";

test("readPlanes returns the process plane and one plane per collapsed sub-process", async () => {
  const planes = await readPlanes(fixture("planes.bpmn"), "planes.bpmn");

  assert.deepEqual(
    planes.map((plane) => [plane.id, plane.shapes.length, plane.edges.length]),
    [
      ["Process_Planes", 7, 4],
      ["subProcess_collapsed", 2, 1],
    ],
  );
});

test("readPlanes keeps the label bounds of named elements, the boundary host and the source and target", async () => {
  const [main] = await readPlanes(fixture("planes.bpmn"), "planes.bpmn");
  const shape = (id: string): DiagramShape | undefined => main?.shapes.find((candidate) => candidate.id === id);

  assert.deepEqual(shape("startEvent_started")?.label, rect(80, 165, 76, 14));
  assert.equal(shape("serviceTask_work")?.label, undefined);
  assert.equal(shape("errorEvent_failed")?.attachedTo, "serviceTask_work");
  assert.deepEqual(
    main?.edges.map((edge) => [edge.id, edge.source, edge.target, edge.waypoints.length]),
    [
      ["flow_startedToWork", "startEvent_started", "serviceTask_work", 2],
      ["flow_workToCollapsed", "serviceTask_work", "subProcess_collapsed", 2],
      ["flow_collapsedToExpanded", "subProcess_collapsed", "subProcess_expanded", 2],
      ["flow_failedToAborted", "errorEvent_failed", "endEvent_aborted", 3],
    ],
  );
});

test("readPlanes marks an expanded sub-process as container and a collapsed one as obstacle", async () => {
  const [main] = await readPlanes(fixture("planes.bpmn"), "planes.bpmn");
  const container = (id: string): boolean | undefined =>
    main?.shapes.find((candidate) => candidate.id === id)?.container;

  assert.equal(container("subProcess_expanded"), true);
  assert.equal(container("subProcess_collapsed"), false);
  assert.equal(container("task_insideExpanded"), false);
});

test("readPlanes rejects a document that is not BPMN with the source in the message", async () => {
  await assert.rejects(readPlanes("<not-bpmn", "broken.bpmn"), (error) => {
    assert.ok(error instanceof BpmnEditError);
    assert.match(error.message, /^broken\.bpmn: not a readable BPMN document/);
    return true;
  });
});
