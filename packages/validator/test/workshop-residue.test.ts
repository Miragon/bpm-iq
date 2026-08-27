/**
 * The workshop-residue check (#117) — bpmiq:sticky extension elements are
 * DISCUSSION artifacts: the validator must (a) surface leftover stickies as a
 * WARN (never an ERROR — a workshop board always saves) and (b) otherwise
 * ignore them entirely: a valid diagram with stickies stays valid, its
 * structural/DI verdicts byte-identical to the sticky-free version.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkBpmnXml } from "../src/validate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (p: string): string => readFileSync(join(HERE, "fixtures", "content-repo", "processes", p), "utf8");

/** inject stickies into a valid fixture's first process element — with the
 *  bpmiq namespace declared, exactly as the modeler serializes it */
function withStickies(xml: string, stickies: string): string {
  return xml
    .replace(/<bpmn:definitions /, `<bpmn:definitions xmlns:bpmiq="https://bpmiq.io/schema/1.0/bpmiq" `)
    .replace(/(<bpmn:process[^>]*>)/, `$1<bpmn:extensionElements>${stickies}</bpmn:extensionElements>`);
}

const STICKIES =
  `<bpmiq:sticky id="Sticky_a1" text="who owns this?" x="120" y="80" kind="question" />` +
  `<bpmiq:sticky id="Sticky_b2" text="ship v1 without refunds" x="340" y="80" kind="decision" />` +
  `<bpmiq:sticky id="Sticky_c3" text="parked" x="500" y="80" width="180" height="140" kind="note" />`;

test("stickies are a WARN (workshop residue), never an ERROR — and counts include open questions", () => {
  const xml = withStickies(fixture("order-to-cash/order-to-cash.bpmn"), STICKIES);
  const { findings } = checkBpmnXml(xml, { file: "order-to-cash.bpmn" });
  assert.deepEqual(
    findings.filter((f) => f.severity === "ERROR"),
    [],
    "a diagram with stickies must stay valid",
  );
  const residue = findings.filter((f) => f.ruleId === "bpmn/workshop-residue");
  assert.equal(residue.length, 1);
  assert.equal(residue[0]!.severity, "WARN");
  assert.match(residue[0]!.message, /3 stickies remain/);
  assert.match(residue[0]!.message, /1 open question\b/);
});

test("verdicts are otherwise UNCHANGED by stickies (toolchain ignores bpmiq:*)", () => {
  const clean = checkBpmnXml(fixture("order-to-cash/order-to-cash.bpmn"), { file: "x" });
  const stickied = checkBpmnXml(withStickies(fixture("order-to-cash/order-to-cash.bpmn"), STICKIES), { file: "x" });
  assert.deepEqual(
    stickied.findings.filter((f) => f.ruleId !== "bpmn/workshop-residue"),
    clean.findings,
    "identical findings apart from the residue warning",
  );
  assert.deepEqual(stickied.called, clean.called, "callActivity links unaffected");
  assert.deepEqual(stickied.decides, clean.decides, "decision links unaffected");
});

test("a foreign tool re-binding the bpmiq URI to another prefix still counts (prefix resolved from xmlns)", () => {
  const aliased = fixture("order-to-cash/order-to-cash.bpmn")
    .replace(/<bpmn:definitions /, `<bpmn:definitions xmlns:wk="https://bpmiq.io/schema/1.0/bpmiq" `)
    .replace(
      /(<bpmn:process[^>]*>)/,
      `$1<bpmn:extensionElements><wk:sticky id="S1" text="x" x="1" y="2" kind="question" /></bpmn:extensionElements>`,
    );
  const residue = checkBpmnXml(aliased, { file: "x" }).findings.find((f) => f.ruleId === "bpmn/workshop-residue");
  assert.ok(residue, "aliased prefix still detected");
  assert.match(residue.message, /1 sticky remains \(1 open question\)/);
});

test("no stickies → no residue warning; a single sticky reads singular", () => {
  const { findings } = checkBpmnXml(fixture("order-to-cash/order-to-cash.bpmn"), { file: "x" });
  assert.ok(!findings.some((f) => f.ruleId === "bpmn/workshop-residue"));

  const one = withStickies(
    fixture("order-to-cash/order-to-cash.bpmn"),
    `<bpmiq:sticky id="Sticky_a1" text="hm" x="1" y="2" kind="note" />`,
  );
  const residue = checkBpmnXml(one, { file: "x" }).findings.find((f) => f.ruleId === "bpmn/workshop-residue");
  assert.ok(residue);
  assert.match(residue.message, /1 sticky remains/);
  assert.ok(!residue.message.includes("question"));
});
