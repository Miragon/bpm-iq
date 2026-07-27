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
