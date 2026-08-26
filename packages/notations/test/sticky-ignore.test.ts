/**
 * bpmiq:sticky extension elements (#117) are DISCUSSION artifacts — the
 * derive/extract toolchain must never see them: the extracted graph and the
 * derived process view of a diagram are byte-identical with and without
 * stickies. This is the pin the sticky feature stands on ("stickies never
 * appear as process steps" — MCP views, process-navigator, release PRs).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveView } from "../derive.ts";
import { extractModelGraph } from "../extract.ts";

const BPMN = (extensions: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    xmlns:bpmiq="https://bpmiq.io/schema/1.0/bpmiq"
    id="Defs_1" targetNamespace="http://bpmn.io/schema/bpmn" bpmiq:mode="workshop">
  <bpmn:process id="order" isExecutable="false">
    ${extensions}
    <bpmn:startEvent id="Start_1" name="Order placed" />
    <bpmn:task id="Task_1" name="Check order" />
    <bpmn:endEvent id="End_1" name="Order checked" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

const STICKIES =
  `<bpmn:extensionElements>` +
  `<bpmiq:sticky id="Sticky_a" text="really manual?" x="100" y="20" kind="question" attachedTo="Task_1" />` +
  `<bpmiq:sticky id="Sticky_b" text="v1 scope agreed" x="260" y="20" kind="decision" />` +
  `</bpmn:extensionElements>`;

test("extract: the model graph is identical with and without stickies (and the workshop mode flag)", () => {
  const clean = extractModelGraph("order.bpmn", BPMN(""));
  const stickied = extractModelGraph("order.bpmn", BPMN(STICKIES));
  assert.ok(clean && stickied);
  assert.deepEqual(JSON.parse(JSON.stringify(stickied)), JSON.parse(JSON.stringify(clean)));
  assert.ok(!JSON.stringify(stickied).includes("Sticky_"), "no sticky leaks into the graph");
});

test("derive: the process view is identical with and without stickies", () => {
  const clean = deriveView(extractModelGraph("order.bpmn", BPMN(""))!);
  const stickied = deriveView(extractModelGraph("order.bpmn", BPMN(STICKIES))!);
  assert.deepEqual(JSON.parse(JSON.stringify(stickied)), JSON.parse(JSON.stringify(clean)));
});
