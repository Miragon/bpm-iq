/**
 * The GET /changes move semantics (#182): a moved model is a deleted + added
 * pair of the same file name, and both the release and the release dialog
 * treat the pair — plus a decision's tests sidecar — as ONE unit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { moveSources, moveUnits } from "../src/live-host.ts";

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

test("moveSources: every added half points at its old path — a tests sidecar at its own", () => {
  const sources = moveSources([
    { path: "processes/credit.dmn", status: "deleted" },
    { path: "processes/credit.tests.yaml", status: "deleted" },
    { path: "processes/finance/credit.dmn", status: "added" },
    { path: "processes/finance/credit.tests.yaml", status: "added" },
    { path: "processes/new.bpmn", status: "added" },
    { path: "processes/invoice.bpmn", status: "modified" },
  ]);
  assert.deepEqual(
    [...sources],
    [
      ["processes/finance/credit.dmn", "processes/credit.dmn"],
      ["processes/finance/credit.tests.yaml", "processes/credit.tests.yaml"],
    ],
  );
});

test("moveUnits: a RENAME pairs by renamedFrom, its tests sidecar pair joins the same unit (#208)", () => {
  const units = moveUnits([
    { path: "p/credit.dmn", status: "deleted" },
    { path: "p/credit.tests.yaml", status: "deleted" },
    { path: "p/credit-limit.dmn", status: "added", renamedFrom: "p/credit.dmn" },
    { path: "p/credit-limit.tests.yaml", status: "added", renamedFrom: "p/credit.tests.yaml" },
    { path: "p/other.bpmn", status: "modified" },
  ]);
  const unit = ["p/credit.dmn", "p/credit.tests.yaml", "p/credit-limit.dmn", "p/credit-limit.tests.yaml"];
  for (const path of unit) assert.deepEqual(new Set(units.get(path)), new Set(unit), path);
  assert.equal(units.has("p/other.bpmn"), false);
});

test("moveUnits: a renamedFrom whose old half is no deletion (re-created, released) pairs nothing", () => {
  const units = moveUnits([
    { path: "p/order.bpmn", status: "modified" },
    { path: "p/o2c.bpmn", status: "added", renamedFrom: "p/order.bpmn" },
    { path: "p/new.dmn", status: "added" },
    { path: "p/new.tests.yaml", status: "added" },
  ]);
  assert.equal(units.size, 0, "a created decision with its created sidecar is no move either");
});

test("moveSources: a renamed file points at its old path by renamedFrom, a moved one by file name", () => {
  const sources = moveSources([
    { path: "p/credit.dmn", status: "deleted" },
    { path: "p/credit-limit.dmn", status: "added", renamedFrom: "p/credit.dmn" },
    { path: "p/old/order.bpmn", status: "deleted" },
    { path: "p/new/order.bpmn", status: "added" },
  ]);
  assert.deepEqual(
    Object.fromEntries(sources),
    Object.fromEntries([
      ["p/credit-limit.dmn", "p/credit.dmn"],
      ["p/new/order.bpmn", "p/old/order.bpmn"],
    ]),
  );
});
