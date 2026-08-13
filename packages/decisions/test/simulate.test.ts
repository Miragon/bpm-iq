/**
 * simulateDecision — the server-side evaluation. Covers the two shapes that
 * matter in practice: a bare decision table whose variables are free (no
 * InputData modelled) and a chained DRD where one decision feeds the next.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { decisionVariables, freeVariablesOf } from "../model.ts";
import { simulateDecision } from "../simulate.ts";
import { RABATT, VERSAND, view } from "./fixtures.ts";

test("free variables: a table without InputData still declares what it needs", () => {
  const variables = decisionVariables(view(RABATT));
  assert.deepEqual(
    variables.map((v) => [v.name, v.source, v.typeRef, v.usedBy]),
    [
      ["kundentyp", "free", "string", ["rabatt"]],
      ["bestellwert", "free", "number", ["rabatt"]],
    ],
  );
});

test("free variables: modelled InputData wins, a decision's own result is never an input", () => {
  const variables = decisionVariables(view(VERSAND));
  assert.deepEqual(
    variables.map((v) => [v.name, v.source, v.usedBy]),
    [
      ["land", "inputData", ["zone"]],
      ["gewicht", "inputData", ["porto"]],
    ],
    "`zone` is produced by a decision, so it is not an input",
  );
});

test("freeVariablesOf reads compound expressions through the FEEL engine", () => {
  assert.deepEqual(freeVariablesOf("kundentyp"), ["kundentyp"]);
  assert.deepEqual(freeVariablesOf("bestellwert > 500"), ["bestellwert"]);
  assert.deepEqual(freeVariablesOf('"literal"'), []);
  assert.deepEqual(freeVariablesOf("sum([1,2])"), []);
  assert.deepEqual(freeVariablesOf("1 +"), [], "a syntax error yields no variables (analyze reports it)");
});

test("simulate: FIRST picks the first match; rules are reported by id", () => {
  const decision = view(RABATT);

  const big = simulateDecision(decision, { kundentyp: "stamm", bestellwert: 500 });
  assert.deepEqual(big.order, ["rabatt"]);
  assert.deepEqual(big.decisions[0]?.matchedRules, ["Rule_stamm_gross", "Rule_stamm"], "both rules match …");
  assert.deepEqual(big.decisions[0]?.reportedRules, ["Rule_stamm_gross"], "… FIRST reports only the first");
  assert.equal(big.decisions[0]?.value, 10);
  assert.deepEqual(big.decisions[0]?.outputs, [{ rabatt: 10 }]);
  assert.deepEqual(big.decisions[0]?.inputs, { Kundentyp: "stamm", Bestellwert: 500 });

  const small = simulateDecision(decision, { kundentyp: "stamm", bestellwert: 20 });
  assert.deepEqual(small.decisions[0]?.matchedRules, ["Rule_stamm"]);
  assert.equal(small.decisions[0]?.value, 5);

  // no rule matches → an empty result, not an error
  const none = simulateDecision(decision, { kundentyp: "partner", bestellwert: 20 });
  assert.deepEqual(none.decisions[0]?.matchedRules, []);
  assert.equal(none.decisions[0]?.value, null);
});

test("simulate: a typo in the scenario is reported, never silently unmatched", () => {
  const result = simulateDecision(view(RABATT), { Kundentyp: "stamm", bestellwert: 500 });
  assert.deepEqual(result.unknownInputs, ["Kundentyp"], "casing matters — say so");
  assert.deepEqual(result.missingInputs, ["kundentyp"]);
  assert.deepEqual(result.decisions[0]?.matchedRules, [], "and the run itself matched nothing");
});

test("simulate: a DRD evaluates in dependency order and threads results downstream", () => {
  const decision = view(VERSAND);

  const inland = simulateDecision(decision, { land: "DE", gewicht: 1.2 });
  assert.deepEqual(inland.order, ["zone", "porto"]);
  assert.equal(inland.decisions[0]?.value, "inland");
  assert.deepEqual(inland.decisions[1]?.reportedRules, ["Rule_inland_leicht"]);
  assert.equal(inland.decisions[1]?.value, 4.9);

  const eu = simulateDecision(decision, { land: "AT", gewicht: 10 });
  assert.equal(eu.decisions[0]?.value, "eu", 'the "AT","CH" entry is a FEEL list of literals');
  assert.equal(eu.decisions[1]?.value, 14.9);

  // an unknown country: the upstream decision has no result, so the downstream
  // one matches nothing either — visible per decision, not one opaque null
  const unknown = simulateDecision(decision, { land: "US", gewicht: 1 });
  assert.equal(unknown.decisions[0]?.value, null);
  assert.deepEqual(unknown.decisions[1]?.matchedRules, []);
});

test("simulate: a UNIQUE violation is reported with the offending rules", () => {
  const overlapping = VERSAND.replace('<text>"AT","CH"</text>', "<text>-</text>");
  const result = simulateDecision(view(overlapping), { land: "DE", gewicht: 1 });
  const zone = result.decisions[0];
  assert.deepEqual(zone?.matchedRules, ["Rule_inland", "Rule_eu"]);
  assert.match(zone?.violation ?? "", /UNIQUE/);
});
