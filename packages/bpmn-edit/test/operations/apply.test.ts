import assert from "node:assert/strict";
import { test } from "node:test";

import { readPlanes } from "../../src/diagram/reader.ts";
import type { Rect } from "../../src/geometry/geometry.ts";
import { applyOperations } from "../../src/operations/apply.ts";
import type { Operation } from "../../src/operations/types.ts";
import { outline } from "../../src/outline/outline.ts";
import type { ProcessOutline } from "../../src/outline/types.ts";
import { fixture } from "../support/fixtures.ts";

const OPTIONS = { depth: 2, bounds: true, full: false };

async function apply(operations: Operation[], file = "ops.bpmn"): Promise<{ xml: string; process: ProcessOutline }> {
  const { xml } = await applyOperations(fixture(file), operations, file);
  const [process] = (await outline(xml, OPTIONS, "result")).processes;
  assert.ok(process);
  return { xml, process };
}

function flowsOf(process: ProcessOutline): string[] {
  return process.flows.map((flow) => `${flow.from}->${flow.to}`).sort();
}

test("insertAfter splits the outgoing flow, places the task in the row and makes room to the right", async () => {
  const outcome = await applyOperations(
    fixture("ops.bpmn"),
    [
      {
        op: "insertAfter",
        after: "task_check",
        element: { type: "serviceTask", id: "serviceTask_score", name: "Score" },
      },
    ],
    "ops.bpmn",
  );
  const [process] = (await outline(outcome.xml, OPTIONS, "result")).processes;
  const bounds = (id: string): Rect | undefined => process?.elements.find((element) => element.id === id)?.bounds;

  assert.ok(process);
  assert.ok(flowsOf(process).includes("task_check->serviceTask_score"));
  assert.ok(flowsOf(process).includes("serviceTask_score->gateway_ok"));
  assert.equal(bounds("serviceTask_score")?.y, bounds("task_check")?.y);
  assert.ok((bounds("gateway_ok")?.x ?? 0) > (bounds("serviceTask_score")?.x ?? 0) + 100);
  assert.deepEqual(
    [outcome.after[0]?.shapeOverlaps, outcome.after[0]?.labelOverlaps, outcome.after[0]?.edgeCrossings],
    [0, 0, 0],
  );
});

test("insertBetween with a template (Camunda 8) keeps the gateway condition on the split flow", async () => {
  const { process } = await apply(
    [
      {
        op: "insertBetween",
        flow: "flow_okYes",
        element: { type: "userTask", id: "userTask_confirm", name: "Confirm", template: { id: "T", version: 2 } },
      },
    ],
    "ops-c8.bpmn",
  );
  const yes = process.flows.find((flow) => flow.id === "flow_okYes");
  const task = process.elements.find((element) => element.id === "userTask_confirm");

  assert.deepEqual([yes?.to, yes?.condition], ["userTask_confirm", "=ok = true"]);
  assert.deepEqual(task?.template, { id: "T", version: "2" });
});

test("addErrorBoundary creates the event, its error definition and the flow; remove takes all of it back", async () => {
  const added = await apply([
    {
      op: "addErrorBoundary",
      attachTo: "task_ship",
      id: "errorEvent_failed",
      name: "Failed",
      errorCode: "SHIP_FAILED",
      to: "endEvent_rejected",
    },
  ]);
  const event = added.process.elements.find((element) => element.id === "errorEvent_failed");

  assert.deepEqual([event?.attachedTo, event?.trigger], ["task_ship", "error: SHIP_FAILED"]);
  assert.ok(flowsOf(added.process).includes("errorEvent_failed->endEvent_rejected"));

  const removed = await applyOperations(added.xml, [{ op: "remove", id: "errorEvent_failed" }], "added");
  assert.doesNotMatch(removed.xml, /SHIP_FAILED|errorEvent_failed/);
});

test("remove of a sub-process drops the error definitions only its content referenced", async () => {
  const withSubProcess = fixture("ops.bpmn")
    .replace(
      '<bpmn:endEvent id="endEvent_rejected" name="Order rejected">',
      '<bpmn:subProcess id="subProcess_inner"><bpmn:endEvent id="endEvent_innerFailed"><bpmn:errorEventDefinition errorRef="Error_Inner" /></bpmn:endEvent></bpmn:subProcess>\n    <bpmn:endEvent id="endEvent_rejected" name="Order rejected">',
    )
    .replace("</bpmn:process>", '</bpmn:process>\n  <bpmn:error id="Error_Inner" name="Inner" errorCode="INNER" />');

  const outcome = await applyOperations(withSubProcess, [{ op: "remove", id: "subProcess_inner" }], "ops.bpmn");

  assert.doesNotMatch(outcome.xml, /Error_Inner|subProcess_inner/);
});

test("remove with reconnect joins predecessor and successor and closes the gap", async () => {
  const outcome = await applyOperations(
    fixture("ops.bpmn"),
    [{ op: "remove", id: "task_ship", reconnect: true }],
    "ops.bpmn",
  );
  const [process] = (await outline(outcome.xml, OPTIONS, "result")).processes;

  assert.ok(process);
  assert.ok(flowsOf(process).includes("gateway_ok->endEvent_shipped"));
  assert.ok((outcome.after[0]?.width ?? 0) < (outcome.before[0]?.width ?? 0));
});

test("mappings, headers (Camunda 8), conditions and the default flow are set and removed", async () => {
  const { process } = await apply(
    [
      { op: "setInput", id: "task_ship", target: "address", source: "=customer.address" },
      { op: "setOutput", id: "task_ship", target: "trackingId", source: "=result.id" },
      { op: "setHeader", id: "task_ship", key: "retries", value: "3" },
      { op: "setCondition", flow: "flow_okYes", condition: null },
      { op: "setDefault", gateway: "gateway_ok", flow: "flow_okYes" },
      { op: "setCondition", flow: "flow_okNo", condition: "=ok = false" },
    ],
    "ops-c8.bpmn",
  );
  const ship = process.elements.find((element) => element.id === "task_ship");

  assert.deepEqual(ship?.inputs, { address: "=customer.address" });
  assert.deepEqual(ship?.outputs, { trackingId: "=result.id" });
  assert.deepEqual(ship?.headers, { retries: "3" });
  assert.equal(process.elements.find((element) => element.id === "gateway_ok")?.default, "flow_okYes");
  assert.equal(process.flows.find((flow) => flow.id === "flow_okNo")?.condition, "=ok = false");
});

test("a failing operation stops the batch with its index and nothing is returned", async () => {
  await assert.rejects(
    applyOperations(
      fixture("ops.bpmn"),
      [
        { op: "rename", id: "task_check", name: "Check" },
        { op: "setCondition", flow: "flow_okNo", condition: "=x" },
      ],
      "ops.bpmn",
    ),
    /operation 1 \(setCondition\): 'flow_okNo' is the default flow of 'gateway_ok'/,
  );
  await assert.rejects(
    applyOperations(
      fixture("ops.bpmn"),
      [{ op: "insertAfter", after: "gateway_ok", element: { type: "task", id: "task_x", name: "X" } }],
      "ops.bpmn",
    ),
    /has 2 outgoing flows \(flow_okYes, flow_okNo\); name one with via/,
  );
  await assert.rejects(
    applyOperations(fixture("ops.bpmn"), [{ op: "rename", id: "task_nope", name: "X" }], "ops.bpmn"),
    /no element with id 'task_nope'/,
  );
});

test("connect adds a routed flow with name and condition; comments in the source are reported", async () => {
  const commented = fixture("ops.bpmn").replace(
    '<bpmn:process id="Process_Ops"',
    '<!-- note -->\n  <bpmn:process id="Process_Ops"',
  );

  const outcome = await applyOperations(
    commented,
    [{ op: "connect", from: "task_check", to: "endEvent_rejected", name: "invalid", condition: "=invalid" }],
    "ops.bpmn",
  );
  const [plane] = await readPlanes(outcome.xml, "result");
  const created = plane?.edges.find((edge) => edge.source === "task_check" && edge.target === "endEvent_rejected");

  assert.ok(created && created.waypoints.length >= 2);
  assert.equal(created?.waypoints[0]?.x, 350);
  assert.match(outcome.diagnostics[0] ?? "", /XML comments/);
});

test("new DI ids follow the convention of the file (Shape_<id> of the Camunda Modeler)", async () => {
  const modelerStyle = fixture("ops.bpmn")
    .replace(/<bpmndi:BPMNShape id="(\w+)_di"/g, '<bpmndi:BPMNShape id="Shape_$1"')
    .replace(/<bpmndi:BPMNEdge id="(\w+)_di"/g, '<bpmndi:BPMNEdge id="Edge_$1"');

  const { xml } = await applyOperations(
    modelerStyle,
    [{ op: "insertAfter", after: "task_check", element: { type: "task", id: "task_score", name: "Score" } }],
    "ops.bpmn",
  );

  assert.match(xml, /id="Shape_task_score"/);
  assert.match(xml, /id="Edge_flow_scoreToOk"/);
  assert.doesNotMatch(xml, /_di"/);
});

test("a flow into an element that already has one is reported as a fake join", async () => {
  const outcome = await applyOperations(
    fixture("ops.bpmn"),
    [{ op: "connect", from: "task_check", to: "endEvent_shipped" }],
    "ops.bpmn",
  );

  assert.match(outcome.diagnostics.join("\n"), /'endEvent_shipped' now has several incoming flows/);
});
