/**
 * The GET /changes move semantics (#182): a moved model is a deleted + added
 * pair of the same file name, and both the release and the release dialog
 * treat the pair — plus a decision's tests sidecar — as ONE unit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { moveUnits } from "../src/live-host.ts";

test("moveUnits: a deleted + added pair of the same file name is one unit", () => {
  const units = moveUnits([
    { path: "processes/order.bpmn", status: "deleted" },
    { path: "processes/sales/order.bpmn", status: "added" },
    { path: "processes/invoice.bpmn", status: "modified" },
  ]);
  const unit = ["processes/order.bpmn", "processes/sales/order.bpmn"];
  assert.deepEqual(units.get("processes/order.bpmn"), unit);
  assert.deepEqual(units.get("processes/sales/order.bpmn"), unit);
  assert.equal(units.has("processes/invoice.bpmn"), false, "a plain edit is no move");
});

test("moveUnits: a decision's tests sidecar joins its decision's unit", () => {
  const units = moveUnits([
    { path: "processes/credit.dmn", status: "deleted" },
    { path: "processes/credit.tests.yaml", status: "deleted" },
    { path: "processes/finance/credit.dmn", status: "added" },
    { path: "processes/finance/credit.tests.yaml", status: "added" },
  ]);
  assert.deepEqual(units.get("processes/finance/credit.dmn")?.slice().sort(), [
    "processes/credit.dmn",
    "processes/credit.tests.yaml",
    "processes/finance/credit.dmn",
    "processes/finance/credit.tests.yaml",
  ]);
});

test("moveUnits: a lone add or delete is no move, and notations never pair across extensions", () => {
  const units = moveUnits([
    { path: "processes/new.bpmn", status: "added" },
    { path: "processes/gone.bpmn", status: "deleted" },
    // same stem, different notation — separate models, not a move
    { path: "processes/order.bpmn", status: "deleted" },
    { path: "processes/sales/order.storm", status: "added" },
    // a tests sidecar added next to a decision that only changed
    { path: "processes/credit.dmn", status: "modified" },
    { path: "processes/credit.tests.yaml", status: "added" },
  ]);
  assert.equal(units.size, 0);
});
