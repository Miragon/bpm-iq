/**
 * The sidecar test suite: parsing, running, rule coverage, and the
 * golden-master path (a case without `expect` records what the model does).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mainDecisionOf,
  parseTestSuite,
  recordExpectations,
  runDecisionTests,
  serializeTestSuite,
  testsPathFor,
} from "../tests.ts";
import { RABATT, VERSAND, view } from "./fixtures.ts";

const SUITE = `decision: rabatt
cases:
  - name: Stammkunde ab 500 EUR
    given: { kundentyp: stamm, bestellwert: 500 }
    expect:
      value: 10
      rules: [Rule_stamm_gross]
  - name: Stammkunde darunter
    given: { kundentyp: stamm, bestellwert: 100 }
    expect: { value: 5 }
  - name: Unbekannter Kundentyp trifft nichts
    given: { kundentyp: partner, bestellwert: 10 }
    expect: { value: null, rules: [] }
`;

test("the sidecar path is the model path with .tests.yaml", () => {
  assert.equal(testsPathFor("processes/rabatt.dmn"), "processes/rabatt.tests.yaml");
  assert.equal(testsPathFor("a/b/Preis.DMN"), "a/b/Preis.tests.yaml");
});

test("a green suite: every case passes and every rule is covered", () => {
  const outcome = runDecisionTests(view(RABATT), parseTestSuite(SUITE));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.passed, 3);
  assert.equal(outcome.failed, 0);
  assert.deepEqual(
    outcome.coverage.map((c) => [c.rule, c.matchedBy.length, c.decidedBy.length]),
    [
      ["Rule_stamm_gross", 1, 1],
      ["Rule_stamm", 2, 1],
      ["Rule_neu", 0, 0],
    ],
    "Rule_stamm matches twice under FIRST but only decides once",
  );
  assert.deepEqual(outcome.uncoveredRules, ["rabatt/Rule_neu"], "no case exercises the new-customer rule");
});

test("a wrong expectation fails with both sides in the message", () => {
  const outcome = runDecisionTests(view(RABATT), parseTestSuite(SUITE.replace("value: 10", "value: 15")));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failed, 1);
  const failed = outcome.cases.find((c) => c.status === "fail");
  assert.deepEqual(failed?.failures, ["decision 'rabatt': expected 15, got 10"]);
  assert.equal(failed?.actual.value, 10, "the actual value rides along for the fix");
});

test("a rule expectation catches a right answer for the wrong reason", () => {
  // same result (10), but produced by a different rule → the test must fail
  const suite = parseTestSuite(`
cases:
  - name: Rabatt kommt aus der Stammkundenregel
    given: { kundentyp: stamm, bestellwert: 500 }
    expect: { rules: [Rule_stamm] }
`);
  const outcome = runDecisionTests(view(RABATT), suite);
  assert.equal(outcome.failed, 1);
  assert.match(outcome.cases[0]?.failures[0] ?? "", /expected rule\(s\) Rule_stamm, got Rule_stamm_gross/);
});

test("a typo in `given` fails the case instead of silently matching nothing", () => {
  const outcome = runDecisionTests(
    view(RABATT),
    parseTestSuite(`cases:\n  - name: Tippfehler\n    given: { Kundentyp: stamm }\n    expect: { value: 5 }\n`),
  );
  assert.equal(outcome.failed, 1);
  assert.match(outcome.cases[0]?.failures[0] ?? "", /'Kundentyp' is not an input/);
  assert.deepEqual(outcome.cases[0]?.missingInputs, ["kundentyp", "bestellwert"]);
});

test("golden master: a case without `expect` is pending, and can be frozen", () => {
  const suite = parseTestSuite(`cases:\n  - name: Neukunde\n    given: { kundentyp: neu, bestellwert: 20 }\n`);
  const outcome = runDecisionTests(view(RABATT), suite);
  assert.equal(outcome.pending, 1);
  assert.equal(outcome.ok, true, "a pending case does not fail the suite");
  assert.equal(outcome.cases[0]?.actual.value, 0);

  const recorded = recordExpectations(suite, outcome);
  assert.deepEqual(recorded.cases[0]?.expect, { value: 0, rules: ["Rule_neu"] });
  // …and the frozen suite passes for real
  const second = runDecisionTests(view(RABATT), recorded);
  assert.equal(second.passed, 1);
  assert.equal(second.pending, 0);
  assert.match(serializeTestSuite(recorded), /name: Neukunde/);
});

test("golden master: two cases named the same are frozen to THEIR OWN result", () => {
  // the widget's capture form takes a free-text name — nothing stops a repeat,
  // and matching by name would give both cases the last one's expectation
  const suite = parseTestSuite(
    `cases:\n` +
      `  - name: Fall\n    given: { kundentyp: neu, bestellwert: 20 }\n` +
      `  - name: Fall\n    given: { kundentyp: stamm, bestellwert: 900 }\n`,
  );
  const recorded = recordExpectations(suite, runDecisionTests(view(RABATT), suite));
  assert.deepEqual(recorded.cases[0]?.expect, { value: 0, rules: ["Rule_neu"] });
  assert.deepEqual(recorded.cases[1]?.expect, { value: 10, rules: ["Rule_stamm_gross"] });
  assert.equal(runDecisionTests(view(RABATT), recorded).failed, 0);
  // …and no case borrows another's array, which YAML would emit as an anchor
  assert.doesNotMatch(serializeTestSuite(recorded), /[&*]a\d/);
});

test("DRD: expectations per decision, and the main decision is the leaf", () => {
  const decision = view(VERSAND);
  assert.equal(mainDecisionOf(decision), "porto");

  const outcome = runDecisionTests(
    decision,
    parseTestSuite(`
cases:
  - name: Inlandspaket unter 2 kg
    given: { land: DE, gewicht: 1.2 }
    expect:
      value: 4.90
      decisions:
        zone: { value: inland, rules: [Rule_inland] }
  - name: EU-Paket
    given: { land: AT, gewicht: 5 }
    expect: { value: 14.90 }
`),
  );
  assert.equal(outcome.decision, "porto");
  assert.equal(outcome.ok, true, JSON.stringify(outcome.cases.flatMap((c) => c.failures)));
  // the heavy-parcel rule MATCHES in case 1 (its weight column is "-") but
  // FIRST never reports it — a gap a matched-based metric would have hidden
  assert.deepEqual(outcome.uncoveredRules, ["porto/Rule_inland_schwer"]);
  const schwer = outcome.coverage.find((c) => c.rule === "Rule_inland_schwer");
  assert.deepEqual([schwer?.matchedBy.length, schwer?.decidedBy.length], [1, 0]);
});

test("a malformed sidecar throws instead of reporting an empty green suite", () => {
  assert.throws(() => parseTestSuite("cases: not-a-list", "rabatt.tests.yaml"), /'cases' must be a list/);
  assert.throws(() => parseTestSuite("- a\n- b", "x.yaml"), /expected a mapping with a 'cases' list/);
  assert.throws(() => parseTestSuite("cases:\n  - name: x\n    given: [1,2]\n"), /'given' must be a mapping/);
  assert.throws(() => parseTestSuite("cases:\n  - name: x\n    given: { a: [1] }\n"), /given\.a must be a string/);
  assert.throws(() => parseTestSuite("cases:\n  - name: x\n    expect: 5\n"), /'expect' must be a mapping/);
  assert.throws(() => parseTestSuite("a: [unclosed", "x.yaml"), /not valid YAML/);
  assert.deepEqual(parseTestSuite("").cases, [], "an empty file is an empty suite, not an error");
});
