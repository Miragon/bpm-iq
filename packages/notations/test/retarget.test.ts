/**
 * retargetRefs (retarget.ts) — the write-side twin of the refs emitter: a
 * rename (#208) points every reference at the new id. Pinned: exactly the
 * spellings the emitter reads are rewritten (and nothing else — same-valued
 * names, ids and other-kind links stay), the rewrite is byte-minimal, and the
 * result resolves under the new id when extracted again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractModelGraph, type ModelGraph } from "../extract.ts";
import { refsOf } from "../refs.ts";
import { retargetRefs } from "../retarget.ts";

const CALLER = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0">
  <bpmn:process id="order" name="order">
    <bpmn:callActivity id="Call_1" name="order" calledElement="invoice-handling" />
    <bpmn:callActivity id="Call_2" calledElement='invoice-handling'>
      <bpmn:incoming>Flow_1</bpmn:incoming>
    </bpmn:callActivity>
    <bpmn:callActivity id="Call_3" calledElement="invoice-handling-v2" />
    <bpmn:businessRuleTask id="Rule_1" camunda:decisionRef="invoice-handling" />
    <bpmn:businessRuleTask id="Rule_2" calledDecision=" credit-check " />
    <bpmn:businessRuleTask id="Rule_3">
      <bpmn:extensionElements>
        <zeebe:calledDecision decisionId="credit-check" resultVariable="r" />
      </bpmn:extensionElements>
    </bpmn:businessRuleTask>
  </bpmn:process>
</bpmn:definitions>`;

const refs = (xml: string) => refsOf(extractModelGraph("bpmn", xml) as ModelGraph);

test("retargetRefs: a renamed PROCESS — every callActivity naming it follows, nothing else changes", () => {
  const out = retargetRefs("bpmn", CALLER, { notation: "bpmn", from: "invoice-handling", to: "billing" });
  assert.equal(
    out,
    CALLER.replace('calledElement="invoice-handling"', 'calledElement="billing"').replace(
      "calledElement='invoice-handling'",
      "calledElement='billing'",
    ),
  );
  // the decisionRef with the same value is a DECISION link — untouched
  assert.match(out, /camunda:decisionRef="invoice-handling"/);
  assert.deepEqual(
    refs(out)
      .filter((r) => r.rel === "calls")
      .map((r) => r.to.id),
    ["billing", "billing", "invoice-handling-v2"],
  );
});

test("retargetRefs: a renamed DECISION — every decides spelling follows (attribute and zeebe extension)", () => {
  const out = retargetRefs("bpmn", CALLER, { notation: "dmn", from: "credit-check", to: "credit-limit" });
  assert.deepEqual(
    refs(out)
      .filter((r) => r.rel === "decides")
      .map((r) => r.to.id),
    ["invoice-handling", "credit-limit", "credit-limit"],
  );
  assert.match(out, /calledDecision="credit-limit"/);
  assert.match(out, /<zeebe:calledDecision decisionId="credit-limit" resultVariable="r" \/>/);
  // calls stay calls
  assert.equal(refs(out).filter((r) => r.rel === "calls").length, 3);
});

test("retargetRefs: no reference, other notations, and a no-op rename return the content untouched", () => {
  assert.equal(retargetRefs("bpmn", CALLER, { notation: "bpmn", from: "ghost", to: "x" }), CALLER);
  assert.equal(retargetRefs("dmn", CALLER, { notation: "bpmn", from: "invoice-handling", to: "x" }), CALLER);
  assert.equal(retargetRefs("bpmn", CALLER, { notation: "bpmn", from: "order", to: "order" }), CALLER);
});

test("retargetRefs: ids are matched literally — regex characters and XML escaping are safe", () => {
  const xml = `<definitions><process id="p"><callActivity id="c" calledElement="a.b&amp;c" /><callActivity id="d" calledElement="aXb&amp;c" /></process></definitions>`;
  const out = retargetRefs("bpmn", xml, { notation: "bpmn", from: "a.b&c", to: "new" });
  assert.equal(
    out,
    `<definitions><process id="p"><callActivity id="c" calledElement="new" /><callActivity id="d" calledElement="aXb&amp;c" /></process></definitions>`,
  );
});
