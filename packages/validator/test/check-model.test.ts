/**
 * checkModel — THE one check dispatch (epic #118 step 3), consumed by the CLI
 * and the Live Host's save gate. Pinned here: notation selection by path,
 * full-checker parity for BPMN/DMN, the baseline for everything else, and
 * `undefined` for non-model files.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkBpmnXml, checkDmnXml, checkModel, checkModelBaseline } from "../src/validate.ts";

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="P">
    <startEvent id="S"/><callActivity id="Call" calledElement="sub-proc"/><endEvent id="E"/>
    <sequenceFlow id="f1" sourceRef="S" targetRef="Call"/>
    <sequenceFlow id="f2" sourceRef="Call" targetRef="E"/>
  </process>
</definitions>`;

test("checkModel(bpmn): full-checker parity incl. the link warnings from modelIds", () => {
  const modelIds = new Map([
    ["bpmn", new Set(["other"])],
    ["dmn", new Set<string>()],
  ]);
  const viaDispatch = checkModel(BPMN, { path: "processes/p.bpmn", modelIds });
  const direct = checkBpmnXml(BPMN, {
    file: "processes/p.bpmn",
    processIds: new Set(["other"]),
    decisionIds: new Set(),
  }).findings;
  assert.deepEqual(viaDispatch, direct);
  // the dangling callActivity IS among them (sub-proc is not in modelIds)
  assert.ok(viaDispatch?.some((f) => f.message.includes("calls 'sub-proc'")));
});

test("checkModel(bpmn): dangling calls AND decides — historical texts, calls first", () => {
  const MIXED = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="P">
    <businessRuleTask id="Rule_1" calledDecision="ghost-decision"/>
    <callActivity id="Call_1" calledElement="ghost-process"/>
  </process>
</definitions>`;
  const findings = checkModel(MIXED, { path: "p.bpmn", modelIds: new Map() }) ?? [];
  const links = findings.filter((f) => f.ruleId === "refs/dangling");
  assert.deepEqual(
    links.map((f) => f.message),
    [
      "callActivity calls 'ghost-process', which is not a process in this repo (external or dangling?)",
      "businessRuleTask Rule_1 decides 'ghost-decision', which is not a decision in this repo (external or dangling?)",
    ],
    "exact historical wording, calls before decides",
  );
  assert.ok(links.every((f) => f.severity === "WARN"));
});

test("checkModel: NO refs verdict on not-well-formed XML (the checker's early return holds)", () => {
  // duplicate attribute: XMLValidator rejects it, the lenient parser would
  // still see the callActivity — main never warned here, neither must we
  const BROKEN = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P" id="P"><callActivity id="C" calledElement="ghost"/></process></definitions>`;
  const findings = checkModel(BROKEN, { path: "p.bpmn", modelIds: new Map() }) ?? [];
  assert.ok(findings.some((f) => f.ruleId === "bpmn/xml"));
  assert.ok(
    findings.every((f) => f.ruleId !== "refs/dangling"),
    `no dangling warning on unparseable XML, got: ${JSON.stringify(findings)}`,
  );
});

test("checkModel: an explicit ctx.notation dispatches when the path is a free-form label", () => {
  const findings = checkModel("<a", { path: "<bpmn>", notation: "bpmn" }) ?? [];
  assert.equal(findings[0]?.ruleId, "bpmn/xml");
  assert.equal(findings[0]?.file, "<bpmn>");
});

test("checkModel(bpmn): without modelIds the link checks are skipped, structure still runs", () => {
  const findings = checkModel(BPMN, { path: "p.bpmn" });
  assert.ok(findings && findings.every((f) => !f.message.includes("calls 'sub-proc'")));
});

test("checkModel(dmn): checkDmnXml parity", () => {
  const DMN = `<?xml version="1.0"?><definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"><decision id="d"/></definitions>`;
  assert.deepEqual(checkModel(DMN, { path: "d.dmn" }), checkDmnXml(DMN, { file: "d.dmn" }).findings);
});

test("checkModel: other notations run the baseline, non-models are undefined", () => {
  assert.deepEqual(
    checkModel("{ broken", { path: "teams/t.tt" }),
    checkModelBaseline("{ broken", { file: "teams/t.tt", notation: "team-topology" }),
  );
  assert.deepEqual(checkModel("# notes", { path: "docs/notes.md" }), []); // markdown: registered, no gate
  assert.equal(checkModel("cases: []", { path: "p.tests.yaml" }), undefined);
  assert.equal(checkModel("anything", { path: "no-extension" }), undefined);
});
