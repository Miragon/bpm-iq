/**
 * checkDmnXml — the mechanical DMN invariants. Scope on purpose: everything
 * here is decidable from the XML alone. FEEL semantics and hit-policy
 * reachability belong to @bpmiq/decisions, not to this zero-dependency CLI.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkBpmnXml, checkDmnXml } from "../src/validate.ts";

const VALID = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/" xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/" id="Definitions_rabatt" name="Rabatt" namespace="http://bpmiq.dev/dmn/rabatt">
  <inputData id="InputData_kundentyp" name="Kundentyp"><variable id="v1" name="kundentyp" typeRef="string" /></inputData>
  <decision id="rabatt" name="Rabatt">
    <informationRequirement id="ir1"><requiredInput href="#InputData_kundentyp" /></informationRequirement>
    <decisionTable id="DT_rabatt" hitPolicy="FIRST">
      <input id="Input_1" label="Kundentyp">
        <inputExpression id="IE_1" typeRef="string"><text>kundentyp</text></inputExpression>
      </input>
      <output id="Output_1" name="rabatt" typeRef="number" />
      <rule id="Rule_stamm">
        <inputEntry id="e1"><text>"stamm"</text></inputEntry>
        <outputEntry id="e2"><text>10</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
  <dmndi:DMNDI>
    <dmndi:DMNDiagram id="DMNDiagram_1">
      <dmndi:DMNShape id="S1" dmnElementRef="rabatt"><dc:Bounds height="80" width="180" x="160" y="100" /></dmndi:DMNShape>
      <dmndi:DMNShape id="S2" dmnElementRef="InputData_kundentyp"><dc:Bounds height="45" width="125" x="180" y="240" /></dmndi:DMNShape>
    </dmndi:DMNDiagram>
  </dmndi:DMNDI>
</definitions>`;

const errors = (xml: string) => checkDmnXml(xml, { file: "rabatt.dmn" }).findings.filter((f) => f.severity === "ERROR");
const messages = (xml: string) => checkDmnXml(xml).findings.map((f) => f.message);

test("checkDmnXml: a complete decision has no findings at all", () => {
  assert.deepEqual(checkDmnXml(VALID, { file: "rabatt.dmn" }).findings, []);
});

test("checkDmnXml: not well-formed / not DMN", () => {
  assert.match(errors("<definitions").at(0)?.message ?? "", /not well-formed XML/);
  assert.match(errors("<not-dmn/>").at(0)?.message ?? "", /no <decision> element/);
});

test("checkDmnXml: rule rows must line up with the columns", () => {
  const extra = VALID.replace(
    '<inputEntry id="e1"><text>"stamm"</text></inputEntry>',
    '<inputEntry id="e1"><text>"stamm"</text></inputEntry><inputEntry id="e1b"><text>-</text></inputEntry>',
  );
  assert.match(errors(extra).at(0)?.message ?? "", /rule Rule_stamm .* has 2 input entries, expected 1/);

  const noOutput = VALID.replace(/<outputEntry id="e2">.*?<\/outputEntry>/, "");
  assert.match(errors(noOutput).at(0)?.message ?? "", /has 0 output entries, expected 1/);
});

test("checkDmnXml: a dangling information requirement is an ERROR", () => {
  const dangling = VALID.replace('href="#InputData_kundentyp"', 'href="#InputData_typo"');
  assert.match(errors(dangling).at(0)?.message ?? "", /requires 'InputData_typo', which does not exist/);
});

test("checkDmnXml: DMNDI — a missing shape breaks the editor, no DMNDI at all is one warning", () => {
  const partial = VALID.replace(/<dmndi:DMNShape id="S2".*?\/dmndi:DMNShape>/s, "");
  assert.match(errors(partial).at(0)?.message ?? "", /InputData_kundentyp has no DMNDI shape/);

  const none = VALID.replace(/<dmndi:DMNDI>[\s\S]*<\/dmndi:DMNDI>/, "");
  assert.deepEqual(errors(none), [], "a table authored outside a modeler is legal …");
  assert.ok(
    messages(none).some((m) => /no DMNDI section/.test(m)),
    "… but it is worth one warning",
  );
});

test("checkDmnXml: a decision without logic is a warning, an undeclared namespace an error", () => {
  const empty = VALID.replace(/<decisionTable[\s\S]*<\/decisionTable>/, "");
  assert.ok(messages(empty).some((m) => /neither a decisionTable nor a literalExpression/.test(m)));
  assert.deepEqual(errors(empty), []);

  const undeclared = VALID.replace('xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/"', "");
  assert.match(errors(undeclared).at(0)?.message ?? "", /namespace prefix 'dc:' is used but never declared/);
});

test("checkBpmnXml: a businessRuleTask pointing at no decision in the repo is a link warning", () => {
  const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC">
  <process id="p" isExecutable="false">
    <startEvent id="Start"><outgoing>f1</outgoing></startEvent>
    <businessRuleTask id="Rule_Credit" name="Check credit" camunda:decisionRef="credit-limit-check">
      <incoming>f1</incoming><outgoing>f2</outgoing>
    </businessRuleTask>
    <endEvent id="End"><incoming>f2</incoming></endEvent>
    <sequenceFlow id="f1" sourceRef="Start" targetRef="Rule_Credit" />
    <sequenceFlow id="f2" sourceRef="Rule_Credit" targetRef="End" />
  </process>
  <bpmndi:BPMNDiagram id="D"><bpmndi:BPMNPlane id="P" bpmnElement="p">
    <bpmndi:BPMNShape id="S1" bpmnElement="Start"><dc:Bounds x="0" y="0" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S2" bpmnElement="Rule_Credit"><dc:Bounds x="100" y="0" width="100" height="80" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S3" bpmnElement="End"><dc:Bounds x="300" y="0" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="E1" bpmnElement="f1"><di:waypoint x="36" y="18" /></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="E2" bpmnElement="f2"><di:waypoint x="200" y="18" /></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</definitions>`;

  const known = checkBpmnXml(bpmn, { file: "p.bpmn", decisionIds: new Set(["credit-limit-check"]) });
  assert.deepEqual(known.decides, ["credit-limit-check"], "the referenced decision is reported back");
  assert.deepEqual(
    known.findings.filter((f) => /businessRuleTask/.test(f.message)),
    [],
  );

  const dangling = checkBpmnXml(bpmn, { file: "p.bpmn", decisionIds: new Set(["something-else"]) });
  const finding = dangling.findings.find((f) => /businessRuleTask/.test(f.message));
  assert.equal(finding?.severity, "WARN", "a link to an external decision is a warning, never an error");
  assert.match(finding?.message ?? "", /decides 'credit-limit-check', which is not a decision in this repo/);

  // without decisionIds the check does not run at all (single-file library use)
  assert.deepEqual(
    checkBpmnXml(bpmn, { file: "p.bpmn" }).findings.filter((f) => /businessRuleTask/.test(f.message)),
    [],
  );
});

test("checkBpmnXml: the link check reads every spelling the platform follows — incl. calledElement", () => {
  // hand-written models spell the link calledElement (extract.ts follows it, so
  // get_process reports the decision) — a spelling the check misses is a link
  // the platform displays and never verifies (that drift shipped once)
  const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC">
  <process id="p" isExecutable="false">
    <startEvent id="Start"><outgoing>f1</outgoing></startEvent>
    <businessRuleTask id="Rule_Credit" name="Check credit" calledElement="credit-limit-check">
      <incoming>f1</incoming><outgoing>f2</outgoing>
    </businessRuleTask>
    <endEvent id="End"><incoming>f2</incoming></endEvent>
    <sequenceFlow id="f1" sourceRef="Start" targetRef="Rule_Credit" />
    <sequenceFlow id="f2" sourceRef="Rule_Credit" targetRef="End" />
  </process>
  <bpmndi:BPMNDiagram id="D"><bpmndi:BPMNPlane id="P" bpmnElement="p">
    <bpmndi:BPMNShape id="S1" bpmnElement="Start"><dc:Bounds x="0" y="0" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S2" bpmnElement="Rule_Credit"><dc:Bounds x="100" y="0" width="100" height="80" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S3" bpmnElement="End"><dc:Bounds x="300" y="0" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="E1" bpmnElement="f1"><di:waypoint x="36" y="18" /></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="E2" bpmnElement="f2"><di:waypoint x="200" y="18" /></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</definitions>`;

  const known = checkBpmnXml(bpmn, { file: "p.bpmn", decisionIds: new Set(["credit-limit-check"]) });
  assert.deepEqual(known.decides, ["credit-limit-check"]);

  const dangling = checkBpmnXml(bpmn, { file: "p.bpmn", decisionIds: new Set(["something-else"]) });
  const finding = dangling.findings.find((f) => /businessRuleTask/.test(f.message));
  assert.equal(finding?.severity, "WARN");
  assert.match(finding?.message ?? "", /decides 'credit-limit-check', which is not a decision in this repo/);
});
