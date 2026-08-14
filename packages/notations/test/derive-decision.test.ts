/**
 * deriveDecision (derive.ts) — the DMN ModelGraph → decision view. Driven
 * through the real extractor, like derive.test.ts: parse DMN, derive, assert
 * the decision shape. The FEEL entries are the interesting part — they must
 * survive parsing as SOURCE TEXT (a `1` stays "1", never the number 1).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveDecision } from "../derive.ts";
import { extractModelGraph } from "../extract.ts";

const DMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_rabatt" name="Rabattermittlung" namespace="http://bpmiq.dev/dmn/rabatt">
  <inputData id="InputData_kundentyp" name="Kundentyp">
    <variable id="Var_kundentyp" name="kundentyp" typeRef="string" />
  </inputData>
  <inputData id="InputData_bestellwert" name="Bestellwert">
    <variable id="Var_bestellwert" name="bestellwert" typeRef="number" />
  </inputData>
  <decision id="rabattstufe" name="Rabattstufe">
    <variable id="Var_rabattstufe" name="rabattstufe" typeRef="number" />
    <informationRequirement id="ir1"><requiredInput href="#InputData_kundentyp" /></informationRequirement>
    <informationRequirement id="ir2"><requiredInput href="#InputData_bestellwert" /></informationRequirement>
    <decisionTable id="DT_rabattstufe" hitPolicy="FIRST">
      <input id="Input_kundentyp" label="Kundentyp">
        <inputExpression id="IE_kundentyp" typeRef="string"><text>kundentyp</text></inputExpression>
        <inputValues id="IV_kundentyp"><text>"neu","stamm"</text></inputValues>
      </input>
      <input id="Input_bestellwert" label="Bestellwert">
        <inputExpression id="IE_bestellwert" typeRef="number"><text>bestellwert</text></inputExpression>
      </input>
      <output id="Output_rabatt" name="rabatt" label="Rabatt in %" typeRef="number" />
      <rule id="Rule_stamm_gross">
        <description>Stammkunde ab 500 EUR</description>
        <inputEntry id="e1"><text>"stamm"</text></inputEntry>
        <inputEntry id="e2"><text>&gt;= 500</text></inputEntry>
        <outputEntry id="e3"><text>10</text></outputEntry>
      </rule>
      <rule id="Rule_stamm_klein">
        <inputEntry id="e4"><text>"stamm"</text></inputEntry>
        <inputEntry id="e5"><text>-</text></inputEntry>
        <outputEntry id="e6"><text>5</text></outputEntry>
      </rule>
      <rule id="Rule_neu">
        <inputEntry id="e7"><text>"neu"</text></inputEntry>
        <inputEntry id="e8"><text></text></inputEntry>
        <outputEntry id="e9"><text>0</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
  <decision id="versandart" name="Versandart">
    <variable id="Var_versandart" name="versandart" typeRef="string" />
    <informationRequirement id="ir3"><requiredDecision href="#rabattstufe" /></informationRequirement>
    <decisionTable id="DT_versandart" hitPolicy="COLLECT" aggregation="COUNT">
      <input id="Input_stufe">
        <inputExpression id="IE_stufe" typeRef="number"><text>rabattstufe</text></inputExpression>
      </input>
      <output id="Output_versand" name="versand" typeRef="string">
        <outputValues id="OV_versand"><text>"express","standard"</text></outputValues>
      </output>
      <rule id="Rule_express">
        <inputEntry id="e10"><text>&gt;= 10</text></inputEntry>
        <outputEntry id="e11"><text>"express"</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
  <decision id="hinweis" name="Hinweis">
    <literalExpression id="LE_hinweis"><text>"Rabatt: " + string(rabattstufe)</text></literalExpression>
  </decision>
</definitions>`;

test("deriveDecision: table columns, hit policy and the DRD wiring", () => {
  const graph = extractModelGraph(".dmn", DMN);
  assert.ok(graph);
  const d = deriveDecision(graph);

  assert.equal(d.name, "Rabattermittlung");
  assert.deepEqual(
    d.inputData.map((i) => [i.id, i.variable, i.typeRef]),
    [
      ["InputData_kundentyp", "kundentyp", "string"],
      ["InputData_bestellwert", "bestellwert", "number"],
    ],
    "input data binds by its <variable name>, not the display name",
  );

  const stufe = d.decisions.find((x) => x.id === "rabattstufe");
  assert.ok(stufe);
  assert.equal(stufe.kind, "decisionTable");
  assert.equal(stufe.hitPolicy, "FIRST");
  assert.equal(stufe.variable, "rabattstufe");
  assert.deepEqual(
    stufe.inputs.map((i) => [i.label, i.expression, i.typeRef]),
    [
      ["Kundentyp", "kundentyp", "string"],
      ["Bestellwert", "bestellwert", "number"],
    ],
  );
  assert.deepEqual(stufe.inputs[0]?.inputValues, ['"neu"', '"stamm"'], "inputValues split into raw FEEL items");
  assert.deepEqual(
    stufe.outputs.map((o) => [o.name, o.label, o.typeRef]),
    [["rabatt", "Rabatt in %", "number"]],
  );
  assert.deepEqual(stufe.requires, { inputData: ["InputData_kundentyp", "InputData_bestellwert"], decisions: [] });

  const versand = d.decisions.find((x) => x.id === "versandart");
  assert.ok(versand);
  assert.equal(versand.hitPolicy, "COLLECT");
  assert.equal(versand.aggregation, "COUNT");
  assert.deepEqual(versand.requires, { inputData: [], decisions: ["rabattstufe"] });
  assert.deepEqual(versand.outputs[0]?.outputValues, ['"express"', '"standard"']);

  assert.equal(d.stats.decisions, 3);
  assert.equal(d.stats.rules, 4);
});

test("deriveDecision: FEEL entries stay source text, aligned to the columns", () => {
  const graph = extractModelGraph(".dmn", DMN);
  assert.ok(graph);
  const stufe = deriveDecision(graph).decisions.find((x) => x.id === "rabattstufe");
  assert.ok(stufe);

  assert.deepEqual(
    stufe.rules.map((r) => [r.id, r.when, r.then]),
    [
      ["Rule_stamm_gross", ['"stamm"', ">= 500"], ["10"]],
      ["Rule_stamm_klein", ['"stamm"', "-"], ["5"]],
      ["Rule_neu", ['"neu"', ""], ["0"]],
    ],
    "numeric-looking entries stay strings; an empty entry is '' (means any)",
  );
  assert.equal(stufe.rules[0]?.description, "Stammkunde ab 500 EUR");
});

test("deriveDecision: literal-expression decisions carry their FEEL source", () => {
  const graph = extractModelGraph(".dmn", DMN);
  assert.ok(graph);
  const hinweis = deriveDecision(graph).decisions.find((x) => x.id === "hinweis");
  assert.ok(hinweis);
  assert.equal(hinweis.kind, "literalExpression");
  assert.equal(hinweis.expression, '"Rabatt: " + string(rabattstufe)');
  assert.deepEqual(hinweis.rules, []);
});

test("deriveDecision: a non-DMN graph yields an empty decision", () => {
  const graph = extractModelGraph(".bpmn", `<definitions><process id="p" /></definitions>`);
  assert.ok(graph);
  const d = deriveDecision(graph);
  assert.deepEqual(d.decisions, []);
  assert.deepEqual(d.inputData, []);
});
