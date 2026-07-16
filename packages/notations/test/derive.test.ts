/**
 * deriveProcess (derive.ts) — the BPMN ModelGraph → process view that replaces
 * the hand-written process.yaml. Driven through the real extractor so the two
 * stay in lockstep: parse a BPMN string, derive, assert the process shape.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveProcess } from "../derive.ts";
import { extractModelGraph } from "../extract.ts";

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:collaboration id="C">
    <bpmn:participant id="Pool_Sales" name="Sales" processRef="Process_Order" />
  </bpmn:collaboration>
  <bpmn:process id="Process_Order" name="Order to Cash">
    <bpmn:laneSet>
      <bpmn:lane id="Lane_Clerk" name="Clerk">
        <bpmn:flowNodeRef>Start</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_Check</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Gw</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_Billing" name="Billing">
        <bpmn:flowNodeRef>Call_Invoice</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>End</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start" name="Order received"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:userTask id="Task_Check" name="Check order"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:userTask>
    <bpmn:exclusiveGateway id="Gw" name="Approved?"><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing></bpmn:exclusiveGateway>
    <bpmn:callActivity id="Call_Invoice" name="Handle invoice" calledElement="invoice-handling"><bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:callActivity>
    <bpmn:endEvent id="End" name="Cash collected"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="Task_Check" />
    <bpmn:sequenceFlow id="f2" sourceRef="Task_Check" targetRef="Gw" />
    <bpmn:sequenceFlow id="f3" sourceRef="Gw" targetRef="Call_Invoice" name="yes" />
    <bpmn:sequenceFlow id="f4" sourceRef="Call_Invoice" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

test("deriveProcess: name from the single pool; steps/events/gateways split by type", () => {
  const graph = extractModelGraph(".bpmn", BPMN);
  assert.ok(graph);
  const p = deriveProcess(graph);

  assert.equal(p.name, "Sales"); // single pool name is the most process-like label
  assert.deepEqual(
    p.steps.map((s) => s.id).sort(),
    ["Call_Invoice", "Task_Check"],
    "activities: the user task + the call activity",
  );
  assert.deepEqual(p.events.map((e) => e.id).sort(), ["End", "Start"]);
  assert.deepEqual(
    p.gateways.map((g) => g.id),
    ["Gw"],
  );
  assert.equal(p.stats.flows, 4);
});

test("deriveProcess: lanes become roles, and each step carries its role", () => {
  const p = deriveProcess(extractModelGraph(".bpmn", BPMN)!);
  assert.deepEqual(
    p.roles.map((r) => r.name),
    ["Clerk", "Billing"],
  );
  assert.equal(p.steps.find((s) => s.id === "Task_Check")?.role, "Clerk");
  assert.equal(p.steps.find((s) => s.id === "Call_Invoice")?.role, "Billing");
});

test("deriveProcess: callActivity surfaces the sub-process it calls", () => {
  const p = deriveProcess(extractModelGraph(".bpmn", BPMN)!);
  assert.deepEqual(p.calls, [{ id: "Call_Invoice", name: "Handle invoice", calledElement: "invoice-handling" }]);
  assert.equal(p.steps.find((s) => s.id === "Call_Invoice")?.calls, "invoice-handling");
});

test("deriveProcess: multiple pools → name stays null, both pools listed", () => {
  const collab = `<?xml version="1.0"?>
    <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
      <bpmn:collaboration id="C">
        <bpmn:participant id="Pool_A" name="Customer" processRef="PA" />
        <bpmn:participant id="Pool_B" name="Supplier" processRef="PB" />
        <bpmn:messageFlow id="mf" sourceRef="t_a" targetRef="t_b" name="order" />
      </bpmn:collaboration>
      <bpmn:process id="PA"><bpmn:task id="t_a" name="Place order"/></bpmn:process>
      <bpmn:process id="PB"><bpmn:task id="t_b" name="Fulfil order"/></bpmn:process>
    </bpmn:definitions>`;
  const p = deriveProcess(extractModelGraph(".bpmn", collab)!);
  assert.equal(p.name, null, "two pools → no single derivable name");
  assert.deepEqual(p.pools.map((pool) => pool.name).sort(), ["Customer", "Supplier"]);
  assert.equal(p.steps.length, 2);
  // the message flow is an edge, kind messageFlow
  assert.ok(p.flows.some((f) => f.kind === "messageFlow" && f.name === "order"));
});

test("deriveProcess: a plain process with no pool/lanes derives with name=null, no roles", () => {
  const bare = `<?xml version="1.0"?>
    <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
      <bpmn:process id="P" name="Bare">
        <bpmn:startEvent id="s"/><bpmn:task id="t" name="Do"/><bpmn:endEvent id="e"/>
        <bpmn:sequenceFlow id="a" sourceRef="s" targetRef="t"/>
        <bpmn:sequenceFlow id="b" sourceRef="t" targetRef="e"/>
      </bpmn:process>
    </bpmn:definitions>`;
  const p = deriveProcess(extractModelGraph(".bpmn", bare)!);
  assert.equal(p.name, null); // no pool → no derived name (the file stem is the id)
  assert.deepEqual(p.roles, []);
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0]?.role, undefined);
});
