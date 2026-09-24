import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkBpmnXml } from "../src/validate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (p: string): string => readFileSync(join(HERE, "fixtures", "content-repo", "processes", p), "utf8");

test("checkBpmnXml: a valid fixture has no ERROR findings", () => {
  const { findings } = checkBpmnXml(fixture("order-to-cash/order-to-cash.bpmn"), { file: "order-to-cash.bpmn" });
  const errors = findings.filter((f) => f.severity === "ERROR");
  assert.deepEqual(errors, [], `unexpected errors: ${JSON.stringify(errors)}`);
});

test("checkBpmnXml: non-BPMN xml → 'no <bpmn:process>' error", () => {
  const { findings } = checkBpmnXml("<not-bpmn/>");
  assert.ok(findings.some((f) => f.severity === "ERROR" && f.message.includes("no <bpmn:process>")));
});

test("checkBpmnXml: malformed xml → 'not well-formed' error", () => {
  const { findings } = checkBpmnXml("<a><b></a>");
  assert.ok(findings.some((f) => f.severity === "ERROR" && f.message.includes("not well-formed")));
});

test("checkBpmnXml: callActivity link integrity is checked against processIds", () => {
  const xml = fixture("order-to-cash/order-to-cash.bpmn");
  const { called } = checkBpmnXml(xml, { file: "x" });
  if (called.length === 0) return; // fixture has no callActivity — nothing to assert
  const missing = checkBpmnXml(xml, { file: "x", processIds: new Set() });
  assert.ok(
    missing.findings.some((f) => f.severity === "WARN" && f.message.includes("not a process in this repo")),
    "an unknown calledElement should warn",
  );
  const present = checkBpmnXml(xml, { file: "x", processIds: new Set(called) });
  assert.ok(
    !present.findings.some((f) => f.message.includes("not a process in this repo")),
    "a known calledElement should not warn",
  );
});

// #190: a group as bpmn-js writes it — the bpmn:Category root element, the
// group itself (here on the collaboration, where a group drawn over a pool
// lands) and the categoryValueRef bpmn-js stamps on every flow element the
// group encloses. None of it is flow structure; only the group's shape counts
const withGroup = (groupDi: boolean): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Defs" targetNamespace="http://example.com">
  <bpmn:collaboration id="Collab">
    <bpmn:participant id="Pool" name="Team" processRef="p" />
    <bpmn:group id="Group_story" categoryValueRef="CategoryValue_story" />
  </bpmn:collaboration>
  <bpmn:process id="p" isExecutable="false">
    <bpmn:group id="Group_inner" categoryValueRef="CategoryValue_story" />
    <bpmn:startEvent id="Start"><bpmn:outgoing>F1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="Task_submit" name="Submit application">
      <bpmn:categoryValueRef>CategoryValue_story</bpmn:categoryValueRef>
      <bpmn:incoming>F1</bpmn:incoming><bpmn:outgoing>F2</bpmn:outgoing>
    </bpmn:task>
    <bpmn:endEvent id="End"><bpmn:incoming>F2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="Task_submit" />
    <bpmn:sequenceFlow id="F2" sourceRef="Task_submit" targetRef="End">
      <bpmn:categoryValueRef>CategoryValue_story</bpmn:categoryValueRef>
    </bpmn:sequenceFlow>
  </bpmn:process>
  <bpmn:category id="Category_story">
    <bpmn:categoryValue id="CategoryValue_story" value="Apply" />
  </bpmn:category>
  <bpmndi:BPMNDiagram id="D">
    <bpmndi:BPMNPlane id="Plane" bpmnElement="Collab">
      <bpmndi:BPMNShape id="Pool_di" bpmnElement="Pool" isHorizontal="true"><dc:Bounds x="0" y="0" width="600" height="250" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Start_di" bpmnElement="Start"><dc:Bounds x="80" y="100" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_submit_di" bpmnElement="Task_submit"><dc:Bounds x="170" y="78" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="End_di" bpmnElement="End"><dc:Bounds x="330" y="100" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="F1_di" bpmnElement="F1"><di:waypoint x="116" y="118" /><di:waypoint x="170" y="118" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="F2_di" bpmnElement="F2"><di:waypoint x="270" y="118" /><di:waypoint x="330" y="118" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNShape id="Group_story_di" bpmnElement="Group_story"><dc:Bounds x="150" y="40" width="250" height="150" /></bpmndi:BPMNShape>
      ${groupDi ? '<bpmndi:BPMNShape id="Group_inner_di" bpmnElement="Group_inner"><dc:Bounds x="160" y="60" width="120" height="110" /></bpmndi:BPMNShape>' : ""}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

test("checkBpmnXml: groups with their category and categoryValueRefs validate clean (#190)", () => {
  const { findings } = checkBpmnXml(withGroup(true), { file: "grouped.bpmn" });
  assert.deepEqual(findings, [], `unexpected findings: ${JSON.stringify(findings)}`);
});

test("checkBpmnXml: a group without its BPMNDI shape is a DI error (#190)", () => {
  const { findings } = checkBpmnXml(withGroup(false), { file: "grouped.bpmn" });
  assert.deepEqual(
    findings.map((f) => `${f.severity} ${f.ruleId} ${f.message}`),
    ["ERROR bpmn/di Group_inner has no BPMNDI shape/edge (breaks the visual editor)"],
  );
});
