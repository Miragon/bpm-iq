/**
 * CHARACTERIZATION of checkBpmnXml's exact findings LIST (content + order) on
 * a nested, deliberately broken model — landed BEFORE the readBpmn refactor.
 * The DI-error block additionally pins diRequired's insertion order: ids are
 * added INLINE during the walk (node ids and flow ids interleaved at their
 * tag-key positions, the child container's o_f1 between O_task and Rule,
 * participants + messageFlow ids appended by the collaboration pass) — a
 * post-hoc reassembly from flat lists would reorder this block.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkBpmnXml } from "../src/validate.ts";

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

test("checkBpmnXml: the full findings list of a nested broken model is pinned", () => {
  const out = checkBpmnXml(BPMN, {
    file: "charfix.bpmn",
    processIds: new Set(["other"]),
    decisionIds: new Set(["other-decision"]),
  });
  assert.deepEqual(out.called, ["sub-proc"]);
  assert.deepEqual(out.decides, ["discount"]);
  assert.deepEqual(out.findings, [
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "B is unreachable (no incoming flow, process P)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "B is a dead end (no outgoing flow, process P)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "Outer is a dead end (no outgoing flow, process P)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "Rule is unreachable (no incoming flow, process P)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "Rule is a dead end (no outgoing flow, process P)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "Call is unreachable (no incoming flow, process P)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "Call is a dead end (no outgoing flow, process P)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "Bnd is a dead end (no outgoing flow, process P)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "End is unreachable (no incoming flow, process P)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "Inner is a dead end (no outgoing flow, subProcess Outer)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "O_task is unreachable (no incoming flow, subProcess Outer)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "O_task is a dead end (no outgoing flow, subProcess Outer)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "Deep is unreachable (no incoming flow, subProcess Inner)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/flow",
      file: "charfix.bpmn",
      message: "Deep is a dead end (no outgoing flow, subProcess Inner)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "Start has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "A has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "B has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "Outer has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "O_start has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "Inner has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "Deep has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "O_task has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "o_f1 has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "Rule has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "Call has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "Bnd has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "End has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "f1 has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "f2 has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "Pool_A has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "mf1 has no BPMNDI shape/edge (breaks the visual editor)",
    },
    {
      severity: "ERROR",
      ruleId: "bpmn/di",
      file: "charfix.bpmn",
      message: "lane L1 has no BPMNDI shape (breaks the visual editor)",
    },
    { severity: "ERROR", ruleId: "bpmn/lanes", file: "charfix.bpmn", message: "B is not assigned to any lane" },
    { severity: "ERROR", ruleId: "bpmn/lanes", file: "charfix.bpmn", message: "Outer is not assigned to any lane" },
    { severity: "ERROR", ruleId: "bpmn/lanes", file: "charfix.bpmn", message: "Rule is not assigned to any lane" },
    { severity: "ERROR", ruleId: "bpmn/lanes", file: "charfix.bpmn", message: "Call is not assigned to any lane" },
    { severity: "ERROR", ruleId: "bpmn/lanes", file: "charfix.bpmn", message: "End is not assigned to any lane" },
    {
      severity: "WARN",
      ruleId: "refs/dangling",
      file: "charfix.bpmn",
      message: "callActivity calls 'sub-proc', which is not a process in this repo (external or dangling?)",
    },
    {
      severity: "WARN",
      ruleId: "refs/dangling",
      file: "charfix.bpmn",
      message: "businessRuleTask Rule decides 'discount', which is not a decision in this repo (external or dangling?)",
    },
  ]);
});

test("7±2: adHocSubProcess and transaction count as activities — like deriveProcess's steps", () => {
  // 8 userTask + 1 transaction + 1 adHocSubProcess = 10 activities. The old
  // predicate (endsWith("task") || callActivity || subProcess) counted 8 and
  // stayed silent while deriveProcess reported stats.steps = 10 — the two
  // classifiers now share @bpmiq/notations/bpmn-kinds.
  const tasks = Array.from({ length: 8 }, (_, i) => `<userTask id="T${i}"/>`).join("");
  const bpmn = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="p">${tasks}<transaction id="Tx"/><adHocSubProcess id="AH"/></process>
</definitions>`;
  const { findings } = checkBpmnXml(bpmn, { file: "many.bpmn" });
  const warning = findings.find((f) => /7±2/.test(f.message));
  assert.equal(warning?.severity, "WARN");
  assert.match(warning?.message ?? "", /10 activities/);
});
