/**
 * analyzeDecision — the checks that need no test cases. The point of each one
 * is that the engine itself would stay SILENT: broken FEEL, a rule that can
 * never be reported, a requirement nothing reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeDecision } from "../analyze.ts";
import { RABATT, VERSAND, view } from "./fixtures.ts";

const codes = (xml: string) => analyzeDecision(view(xml)).findings.map((f) => `${f.severity}:${f.code}`);

test("a sound decision produces no findings", () => {
  assert.deepEqual(analyzeDecision(view(RABATT)).findings, []);
  assert.deepEqual(analyzeDecision(view(VERSAND)).findings, []);
  assert.equal(analyzeDecision(view(RABATT)).ok, true);
});

test("broken FEEL in a rule entry is an ERROR (the engine would just not match)", () => {
  const broken = RABATT.replace("<text>&gt;= 500</text>", "<text>&gt;= </text>");
  const analysis = analyzeDecision(view(broken));
  const finding = analysis.findings.find((f) => f.code === "feel-syntax");
  assert.ok(finding, `expected a feel-syntax finding, got ${JSON.stringify(analysis.findings)}`);
  assert.equal(finding.severity, "ERROR");
  assert.equal(finding.rule, "Rule_stamm_gross");
  assert.equal(finding.column, "Bestellwert");
  assert.match(finding.message, /silently matches nothing/);
  assert.equal(analysis.ok, false);
});

test("a broken output expression and an empty one are told apart", () => {
  assert.ok(codes(RABATT.replace("<text>10</text>", "<text>10 +</text>")).includes("ERROR:feel-syntax"));
  assert.ok(codes(RABATT.replace("<text>10</text>", "<text></text>")).includes("WARN:output-empty"));
});

test("an unreachable rule under FIRST, and the same overlap as a UNIQUE violation", () => {
  // move the catch-all "stamm" row ABOVE the specific one → the specific one dies
  const shadowed = RABATT.replace(
    /<rule id="Rule_stamm_gross">[\s\S]*?<\/rule>\s*<rule id="Rule_stamm">[\s\S]*?<\/rule>/,
    `<rule id="Rule_stamm"><inputEntry id="e4"><text>"stamm"</text></inputEntry><inputEntry id="e5"><text>-</text></inputEntry><outputEntry id="e6"><text>5</text></outputEntry></rule>
     <rule id="Rule_stamm_gross"><inputEntry id="e1"><text>"stamm"</text></inputEntry><inputEntry id="e2"><text>&gt;= 500</text></inputEntry><outputEntry id="e3"><text>10</text></outputEntry></rule>`,
  );
  const first = analyzeDecision(view(shadowed)).findings.find((f) => f.code === "rule-shadowed");
  assert.ok(first);
  assert.equal(first.rule, "Rule_stamm_gross");
  assert.match(first.message, /unreachable/);

  // the SAME table under UNIQUE is a guaranteed hit-policy violation instead
  const unique = analyzeDecision(view(shadowed.replace('hitPolicy="FIRST"', 'hitPolicy="UNIQUE"')));
  assert.match(unique.findings.find((f) => f.code === "rule-shadowed")?.message ?? "", /UNIQUE violation/);

  // two literally identical rows are a duplicate, whatever the policy
  const duplicate = RABATT.replace(
    '<rule id="Rule_neu">',
    `<rule id="Rule_neu_kopie"><inputEntry id="d1"><text>"neu"</text></inputEntry><inputEntry id="d2"><text>-</text></inputEntry><outputEntry id="d3"><text>0</text></outputEntry></rule>
     <rule id="Rule_neu">`,
  );
  assert.ok(codes(duplicate).includes("WARN:duplicate-rule"));
});

test("a requirement whose variable nobody reads is reported (the classic silent chain break)", () => {
  // the porto table reads `zone`; renaming the upstream variable to `Zone`
  // leaves the chain wired but dead — exactly the bug FEEL never complains about
  const broken = VERSAND.replace(
    '<variable id="v3" name="zone" typeRef="string" />',
    '<variable id="v3" name="Zone" typeRef="string" />',
  );
  const analysis = analyzeDecision(view(broken));
  const finding = analysis.findings.find((f) => f.code === "requirement-unused");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.decision, "porto");
  assert.match(finding.message, /never reads its result variable 'Zone'/);
});

test("a cycle between decisions is an ERROR", () => {
  const cyclic = VERSAND.replace(
    '<decision id="zone" name="Versandzone">',
    '<decision id="zone" name="Versandzone"><informationRequirement id="ir9"><requiredDecision href="#porto" /></informationRequirement>',
  );
  const cycle = analyzeDecision(view(cyclic)).findings.find((f) => f.code === "requirement-cycle");
  assert.ok(cycle);
  assert.equal(cycle.severity, "ERROR");
  assert.match(cycle.message, /zone → porto → zone|porto → zone → porto/);
});

test("hit-policy hygiene: unknown policy, aggregation without COLLECT, no rules", () => {
  assert.ok(codes(RABATT.replace('hitPolicy="FIRST"', 'hitPolicy="WHATEVER"')).includes("WARN:hit-policy-unknown"));
  assert.ok(
    codes(RABATT.replace('hitPolicy="FIRST"', 'hitPolicy="FIRST" aggregation="SUM"')).includes(
      "WARN:aggregation-without-collect",
    ),
  );
  const empty = RABATT.replace(/<rule id="Rule_[\s\S]*?<\/rule>/g, "");
  assert.ok(codes(empty).includes("WARN:no-rules"));
});

test("the variable profile is the raw material for test cases", () => {
  const analysis = analyzeDecision(view(RABATT));
  assert.deepEqual(analysis.variables, [
    { name: "kundentyp", typeRef: "string", source: "free", literals: ["stamm", "neu"], boundaries: [] },
    { name: "bestellwert", typeRef: "number", source: "free", literals: [], boundaries: [500] },
  ]);
  assert.deepEqual(analysis.rules, [{ decision: "rabatt", ruleIds: ["Rule_stamm_gross", "Rule_stamm", "Rule_neu"] }]);
});
