import assert from "node:assert/strict";
import { test } from "node:test";

import { outline } from "../../src/outline/outline.ts";
import type { ElementOutline, OutlineOptions, ProcessOutline } from "../../src/outline/types.ts";
import { BpmnEditError } from "../../src/utils/errors.ts";
import { fixture } from "../support/fixtures.ts";

const DEFAULTS: OutlineOptions = { depth: 2, bounds: false, full: false };

async function processOf(file: string, options: Partial<OutlineOptions> = {}): Promise<ProcessOutline> {
  const [process] = (await outline(fixture(file), { ...DEFAULTS, ...options }, file)).processes;
  assert.ok(process);
  return process;
}

function element(process: ProcessOutline, id: string): ElementOutline {
  const found = process.elements.find((candidate) => candidate.id === id);
  assert.ok(found, `no element ${id}`);
  return found;
}

test("outline lists every element in document order, sub-process children with their parent", async () => {
  const process = await processOf("outline.bpmn");

  assert.equal(process.name, "Outline fixture");
  assert.equal(process.elements.length, 13);
  assert.equal(process.flows.length, 11);
  assert.equal(element(process, "userTask_approve").parent, "subProcess_handle");
  assert.equal(element(process, "serviceTask_getPet").parent, undefined);
});

test("outline reads template, task type, mappings and headers of a connector task with its XML line", async () => {
  const task = element(await processOf("outline.bpmn"), "serviceTask_getPet");

  assert.deepEqual(task.template, { id: "Fixture-GetPet", version: "3" });
  assert.equal(task.taskType, "io.camunda:http-json:1");
  assert.equal(task.inputs?.["petId"], "=petId");
  assert.equal(task.headers?.["resultExpression"], "={ petName: response.body.name }");
  assert.equal(task.line, 12);
});

test("outline shortens long values unless the full outline is requested", async () => {
  const short = element(await processOf("outline.bpmn"), "serviceTask_getPet").inputs?.["long"];
  const full = element(await processOf("outline.bpmn", { full: true }), "serviceTask_getPet").inputs?.["long"];

  assert.match(short ?? "", /^="0123456789.*\.\.\.\(\+23 chars\)$/);
  assert.equal(full?.length, 103);
});

test("outline reads user task, script, call activity and business rule details", async () => {
  const process = await processOf("outline.bpmn");

  assert.deepEqual(
    [element(process, "userTask_approve").formId, element(process, "userTask_approve").assignment],
    ["Form_Approve", "sales"],
  );
  assert.deepEqual(
    [element(process, "scriptTask_score").script, element(process, "scriptTask_score").resultVariable],
    ["=quantity * 2", "score"],
  );
  assert.equal(element(process, "callActivity_reserve").calledElement, "Process_Reserve");
  assert.equal(element(process, "businessRuleTask_check").calledDecision, "Decision_Check");
});

test("outline reads triggers, the boundary host, the gateway default and flow conditions", async () => {
  const process = await processOf("outline.bpmn");
  const yes = process.flows.find((flow) => flow.id === "flow_availableYes");

  assert.deepEqual(
    [element(process, "timerEvent_slow").trigger, element(process, "timerEvent_slow").attachedTo],
    ["timer: PT1H", "serviceTask_getPet"],
  );
  assert.equal(element(process, "endEvent_rejected").trigger, "error: ORDER_REJECTED");
  assert.equal(element(process, "gateway_available").default, "flow_availableNo");
  assert.deepEqual(
    [yes?.from, yes?.to, yes?.name, yes?.condition],
    ["gateway_available", "subProcess_handle", "yes", '=petStatus = "available"'],
  );
});

test("outline with around keeps the neighbourhood within depth and counts what it left out", async () => {
  const process = await processOf("outline.bpmn", { around: "gateway_available", depth: 1 });

  assert.deepEqual(
    process.elements.map((candidate) => candidate.id),
    ["serviceTask_getPet", "gateway_available", "subProcess_handle", "endEvent_rejected"],
  );
  assert.deepEqual(
    process.flows.map((flow) => flow.id),
    ["flow_getPetToAvailable", "flow_availableYes", "flow_availableNo"],
  );
  assert.deepEqual(process.omitted, { elements: 9, flows: 8 });
});

test("outline with around counts a boundary event as neighbour of its host", async () => {
  const process = await processOf("outline.bpmn", { around: "timerEvent_slow", depth: 1 });

  assert.deepEqual(
    process.elements.map((candidate) => candidate.id),
    ["serviceTask_getPet", "timerEvent_slow", "endEvent_rejected"],
  );
});

test("outline with around rejects an unknown element", async () => {
  await assert.rejects(outline(fixture("outline.bpmn"), { ...DEFAULTS, around: "nope" }, "outline.bpmn"), (error) => {
    assert.ok(error instanceof BpmnEditError);
    assert.match(error.message, /'nope'/);
    return true;
  });
});

test("outline adds the DI bounds on request", async () => {
  const process = await processOf("planes.bpmn", { bounds: true });

  assert.deepEqual(element(process, "serviceTask_work").bounds, { x: 200, y: 100, width: 100, height: 80 });
});
