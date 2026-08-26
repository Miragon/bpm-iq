/**
 * Every blank template ships validator-clean (#139): a model created from the
 * platform must never open with baseline findings — the create path and the
 * quality gate would contradict each other on a file the PLATFORM authored.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { NOTATIONS } from "@bpmiq/notations";
import { hasTemplate, templateFor } from "@bpmiq/notations/templates";

import { checkModelBaseline } from "../src/validate.ts";

test("the blank template of every template-capable notation passes the baseline", () => {
  const creatable = NOTATIONS.filter((n) => hasTemplate(n.id));
  assert.ok(creatable.length >= 5, "bpmn, dmn, wardley, team-topology, markdown at minimum");
  for (const notation of creatable) {
    const content = templateFor(notation.id, "sample-model", "Sample Model");
    assert.ok(content !== undefined, notation.id);
    const findings = checkModelBaseline(content, { file: `sample${notation.extensions[0]}`, notation: notation.id });
    assert.deepEqual(findings, [], `${notation.id} template must be baseline-clean`);
  }
});
