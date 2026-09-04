/**
 * deriveView — the generic derive dispatch (epic #118 step 3). The common
 * core (name/summary/stats) is pinned per notation; the rich views ride in
 * `detail` UNCHANGED (deriveProcess/deriveDecision equality), so consumers of
 * the typed fields lose nothing by going through the dispatch.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { deriveDecision, deriveProcess, deriveView } from "../derive.ts";
import { extractModelGraph, type ModelGraph } from "../extract.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <collaboration id="C"><participant id="Pool" name="Sales" processRef="P"/></collaboration>
  <process id="P">
    <startEvent id="S"/><task id="A" name="Check"/><endEvent id="E"/>
    <sequenceFlow id="f1" sourceRef="S" targetRef="A"/>
    <sequenceFlow id="f2" sourceRef="A" targetRef="E"/>
  </process>
</definitions>`;

test("deriveView(bpmn): common core + the untouched DerivedProcess in detail", () => {
  const graph = extractModelGraph("bpmn", BPMN) as ModelGraph;
  const view = deriveView(graph);
  assert.equal(view?.notation, "bpmn");
  assert.equal(view?.name, "Sales");
  assert.equal(view?.summary, "Process with 1 step, 2 events, 0 gateways, 2 flows, 0 roles");
  assert.deepEqual(view?.stats, { steps: 1, events: 2, gateways: 0, flows: 2, roles: 0 });
  assert.deepEqual(view?.detail, deriveProcess(graph));
});

test("deriveView(dmn): name from definitions, rules counted, detail = deriveDecision", () => {
  const DMN = `<?xml version="1.0"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" name="Rabatt">
  <decision id="rabatt" name="Rabatt">
    <decisionTable id="T" hitPolicy="FIRST">
      <input id="I1"><inputExpression id="IE" typeRef="string"><text>kundentyp</text></inputExpression></input>
      <output id="O1" name="rabatt" typeRef="number"/>
      <rule id="R1"><inputEntry id="e1"><text>"stamm"</text></inputEntry><outputEntry id="e2"><text>10</text></outputEntry></rule>
    </decisionTable>
  </decision>
</definitions>`;
  const graph = extractModelGraph("dmn", DMN) as ModelGraph;
  const view = deriveView(graph);
  assert.equal(view?.name, "Rabatt");
  assert.equal(view?.summary, "Decision model with 1 decision, 0 inputData, 1 rule");
  assert.deepEqual(view?.detail, deriveDecision(graph));
});

test("deriveView(wardley/tt/vc): node/edge stats from the shipped fixtures", () => {
  const wardley = deriveView(extractModelGraph("maps/tea.owm", fixture("tea.owm")) as ModelGraph);
  assert.deepEqual(wardley?.stats, { components: 7, dependencies: 8 });
  assert.equal(wardley?.summary, "Wardley map with 7 components, 8 dependencies");

  const tt = deriveView(extractModelGraph("teams/sample.tt", fixture("sample.tt")) as ModelGraph);
  assert.deepEqual(tt?.stats, { teams: 5, interactions: 0 });

  const es = deriveView(
    extractModelGraph("boards/order-checkout.storm", fixture("order-checkout.storm")) as ModelGraph,
  );
  assert.equal(es?.name, "Order Checkout", "the board title is the model's own name");
  assert.deepEqual(es?.stats, {
    events: 2,
    commands: 2,
    actors: 1,
    aggregates: 2,
    policies: 1,
    readmodels: 1,
    externals: 1,
    hotspots: 1,
    notes: 1,
    drawings: 0,
    arrows: 9,
  });
  assert.equal(
    es?.summary,
    "Event storming board with 2 events, 2 commands, 1 actor, 2 aggregates, 1 policy, 1 readmodel, 1 external, 1 hotspot, 1 note, 9 arrows",
  );
  // the timeline reads the board left to right — the facilitator's story
  assert.deepEqual(
    (es?.detail as { level: string | null; timeline: Array<{ name: string | null }> }).timeline.map((n) => n.name),
    [
      "Customer",
      "Place Order",
      "Order",
      "Payment Provider",
      "Order Status",
      "Order Placed",
      "Double payment on retry?",
      "When order placed, ship it",
      "Ship Order",
      "Order",
      "Order Shipped",
    ],
  );
  assert.equal((es?.detail as { level: string | null }).level, null);
  assert.equal(
    deriveView({ notation: "event-storming", nodes: [], edges: [], meta: { title: "Blank", level: "process" } })
      ?.summary,
    "Event storming board with no elements",
  );

  const vc = deriveView(extractModelGraph("chains/supply.vc.json", fixture("supply.vc.json")) as ModelGraph);
  assert.deepEqual(vc?.stats, { elements: 3, connections: 2 });
  assert.equal(vc?.summary, "Value chain with 3 elements, 2 connections");
});

test("deriveView: a notation without a deriver yields undefined (the caller keeps the bare row)", () => {
  assert.equal(deriveView({ notation: "markdown", nodes: [], edges: [] }), undefined);
  assert.equal(deriveView({ notation: "no-such", nodes: [], edges: [] }), undefined);
});
