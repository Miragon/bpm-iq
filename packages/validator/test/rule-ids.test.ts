/**
 * Every finding carries a stable ruleId — the declared hook for per-repo
 * severity config (epic #118). One representative finding per family is
 * pinned here so a typo'd or silently renamed id cannot ship.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkBpmnXml, checkDmnXml, checkModelBaseline, type Finding } from "../src/validate.ts";

const ruleOf = (findings: Finding[], pattern: RegExp): string | undefined =>
  findings.find((f) => pattern.test(f.message))?.ruleId;

test("bpmn rule families", () => {
  assert.equal(ruleOf(checkBpmnXml("<a").findings, /not well-formed/), "bpmn/xml");
  assert.equal(ruleOf(checkBpmnXml("<definitions/>").findings, /no <bpmn:process>/), "bpmn/structure");

  const tasks = Array.from({ length: 10 }, (_, i) => `<userTask id="T${i}"/>`).join("");
  const many = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="p">${tasks}</process></definitions>`;
  const findings = checkBpmnXml(many, { file: "m.bpmn" }).findings;
  assert.equal(ruleOf(findings, /7±2/), "bpmn/complexity");
  assert.equal(ruleOf(findings, /is unreachable/), "bpmn/flow");
  assert.equal(ruleOf(findings, /no BPMNDI/), "bpmn/di");

  const laned = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="p">
    <laneSet id="ls"><lane id="L1" name="A"><flowNodeRef>S</flowNodeRef></lane></laneSet>
    <startEvent id="S"/><task id="T"/><endEvent id="E"/>
    <sequenceFlow id="f1" sourceRef="S" targetRef="T"/><sequenceFlow id="f2" sourceRef="T" targetRef="E"/>
  </process>
</definitions>`;
  assert.equal(ruleOf(checkBpmnXml(laned).findings, /not assigned to any lane/), "bpmn/lanes");
});

test("dmn rule families", () => {
  assert.equal(ruleOf(checkDmnXml("<a").findings, /not well-formed/), "dmn/xml");
  assert.equal(ruleOf(checkDmnXml("<definitions/>").findings, /no <decision>/), "dmn/structure");

  const dmn = `<?xml version="1.0"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/">
  <decision id="d">
    <decisionTable id="t">
      <input id="i1"><inputExpression id="ie"><text>x</text></inputExpression></input>
      <output id="o1"/>
      <rule id="r1"><inputEntry id="e1"><text>1</text></inputEntry><inputEntry id="e2"><text>2</text></inputEntry><outputEntry id="e3"><text>ok</text></outputEntry></rule>
    </decisionTable>
    <informationRequirement id="req"><requiredInput href="#missing"/></informationRequirement>
  </decision>
</definitions>`;
  const findings = checkDmnXml(dmn, { file: "d.dmn" }).findings;
  assert.equal(ruleOf(findings, /input entries, expected/), "dmn/rules");
  assert.equal(ruleOf(findings, /requires 'missing'/), "dmn/requirements");
  assert.equal(ruleOf(findings, /no DMNDI section/), "dmn/di");
});

test("baseline rule family", () => {
  assert.equal(
    ruleOf(checkModelBaseline("{ nope", { file: "t.tt", notation: "team-topology" }), /not parseable as JSON/),
    "baseline/parse",
  );
});
