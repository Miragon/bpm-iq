/**
 * CHARACTERIZATION of extractBpmn's exact wire output — landed BEFORE the
 * readBpmn refactor so the one-walk rewrite has a regression net. Nothing
 * else pins these invariants (get_model returns the graph verbatim, but its
 * tests only probe with .some()):
 *
 *  - node ORDER is tag-grouped first-occurrence order with recursion inline
 *    at the sub-container key (fast-xml-parser groups repeated tags), so B
 *    precedes Outer here — NOT document order, NOT container-by-container;
 *  - a child container's sequenceFlows precede the parent's when the parent's
 *    sequenceFlow key first occurs later (o_f1 before f1/f2);
 *  - `extra` is ALWAYS an object ({} when empty) and carries exactly
 *    parent/calledElement/attachedTo/decisionRef;
 *  - meta.lanes is an identity projection (no ""-fallbacks), meta.pools maps
 *    absent attributes to "".
 *
 * Compared through a JSON round-trip: the WIRE representation is what is
 * pinned (in memory, absent attrs ride as `name: undefined` properties).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractModelGraph } from "../extract.ts";

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <collaboration id="Collab">
    <participant id="Pool_A" name="Sales" processRef="P"/>
    <messageFlow id="mf1" sourceRef="A" targetRef="Rule"/>
  </collaboration>
  <process id="P">
    <laneSet id="LS"><lane id="L1" name="Clerk"><flowNodeRef>Start</flowNodeRef><flowNodeRef>A</flowNodeRef></lane></laneSet>
    <startEvent id="Start"/>
    <task id="A" name="Check"/>
    <subProcess id="Outer">
      <startEvent id="O_start"/>
      <subProcess id="Inner">
        <task id="Deep"/>
      </subProcess>
      <task id="O_task"/>
      <sequenceFlow id="o_f1" sourceRef="O_start" targetRef="Inner"/>
    </subProcess>
    <businessRuleTask id="Rule" name="Decide" calledDecision="discount"/>
    <callActivity id="Call" calledElement="sub-proc"/>
    <boundaryEvent id="Bnd" attachedToRef="Outer"/>
    <task id="B"/>
    <endEvent id="End"/>
    <sequenceFlow id="f1" sourceRef="Start" targetRef="A"/>
    <sequenceFlow id="f2" sourceRef="A" targetRef="Outer"/>
  </process>
</definitions>`;

test("extractBpmn: the full wire output of a nested model is pinned", () => {
  const graph = extractModelGraph("bpmn", BPMN);
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "bpmn",
    nodes: [
      { id: "Start", type: "startEvent", extra: {} },
      { id: "A", type: "task", name: "Check", extra: {} },
      { id: "B", type: "task", extra: {} },
      { id: "Outer", type: "subProcess", extra: {} },
      { id: "O_start", type: "startEvent", extra: { parent: "Outer" } },
      { id: "Inner", type: "subProcess", extra: { parent: "Outer" } },
      { id: "Deep", type: "task", extra: { parent: "Inner" } },
      { id: "O_task", type: "task", extra: { parent: "Outer" } },
      { id: "Rule", type: "businessRuleTask", name: "Decide", extra: { decisionRef: "discount" } },
      { id: "Call", type: "callActivity", extra: { calledElement: "sub-proc" } },
      { id: "Bnd", type: "boundaryEvent", extra: { attachedTo: "Outer" } },
      { id: "End", type: "endEvent", extra: {} },
    ],
    edges: [
      { id: "o_f1", from: "O_start", to: "Inner", kind: "sequenceFlow" },
      { id: "f1", from: "Start", to: "A", kind: "sequenceFlow" },
      { id: "f2", from: "A", to: "Outer", kind: "sequenceFlow" },
      { id: "mf1", from: "A", to: "Rule", kind: "messageFlow" },
    ],
    meta: {
      lanes: [{ id: "L1", name: "Clerk", nodeIds: ["Start", "A"] }],
      pools: [{ id: "Pool_A", name: "Sales", processRef: "P" }],
    },
  });
});
