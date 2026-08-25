/**
 * templateFor — the generic template dispatch (epic #118 step 3). The
 * builders themselves are pinned by the live-host scaffold suite (which
 * consumes them through the domain shims); here only the dispatch contract.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { newBpmnXml, newDmnXml, templateFor } from "../templates.ts";

test("templateFor: dispatches to the notation's builder, undefined without one", () => {
  assert.equal(templateFor("bpmn", "order", "Order"), newBpmnXml("order", "Order"));
  assert.equal(templateFor("dmn", "rabatt", "Rabatt"), newDmnXml("rabatt", "Rabatt"));
  assert.equal(templateFor("wardley", "map", "Map"), undefined);
  assert.equal(templateFor("markdown", "notes", "Notes"), undefined);
  assert.equal(templateFor("no-such", "x", "X"), undefined);
});
