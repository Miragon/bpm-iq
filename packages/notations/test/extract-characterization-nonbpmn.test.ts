/**
 * CHARACTERIZATION of the wardley / team-topology / value-chain extractors —
 * pinned BEFORE registry-driven discovery makes them reachable (they are dead
 * code until then: no discovery path hands them a file, and nothing else
 * exercised them). The fixtures are the de-facto format spec: tea.owm and
 * sample.tt are the shipped examples of the Miragon modeler repos
 * (wardley-maps-modeler, team-topologies-modeler), whose deterministic
 * serializers define what real files look like.
 *
 * Deliberately pinned quirks (documenting gaps, not endorsing them):
 *
 *  - wardley: only `component` lines become nodes — `anchor`/`pipeline`/
 *    `evolve`/`title` are ignored, so edges may reference ids with NO node
 *    (Business/Public below), and the `(outsource)` suffix is dropped;
 *  - team-topology: the extractor expects `{nodes, edges}` — the modeler's
 *    real version-2 TtDocument carries `interactions`/`flows` instead of
 *    `edges` (relations are spatial), so a real .tt yields ZERO edges and
 *    position/size/title are dropped;
 *  - value-chain: elementType/connectionType default to "element"/
 *    "connection", `label` wins over `name`, missing connection ids become
 *    `conn-<index>`.
 *
 * Compared through a JSON round-trip: the WIRE representation is what is
 * pinned (in memory, absent fields ride as `undefined` properties).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { extractModelGraph } from "../extract.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("extractWardley: the shipped tea.owm example is pinned", () => {
  const graph = extractModelGraph("maps/tea.owm", fixture("tea.owm"));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "wardley",
    nodes: [
      {
        id: "Cup of Tea",
        type: "component",
        name: "Cup of Tea",
        extra: { visibility: 0.79, evolution: 0.61, stage: "product" },
      },
      { id: "Cup", type: "component", name: "Cup", extra: { visibility: 0.73, evolution: 0.78, stage: "commodity" } },
      { id: "Tea", type: "component", name: "Tea", extra: { visibility: 0.63, evolution: 0.81, stage: "commodity" } },
      {
        id: "Hot Water",
        type: "component",
        name: "Hot Water",
        extra: { visibility: 0.52, evolution: 0.8, stage: "commodity" },
      },
      {
        id: "Water",
        type: "component",
        name: "Water",
        extra: { visibility: 0.38, evolution: 0.82, stage: "commodity" },
      },
      {
        id: "Kettle",
        type: "component",
        name: "Kettle",
        extra: { visibility: 0.43, evolution: 0.35, stage: "custom-built" },
      },
      { id: "Power", type: "component", name: "Power", extra: { visibility: 0.1, evolution: 0.71, stage: "product" } },
    ],
    edges: [
      { id: "dep-0", from: "Business", to: "Cup of Tea", kind: "dependency" },
      { id: "dep-1", from: "Public", to: "Cup of Tea", kind: "dependency" },
      { id: "dep-2", from: "Cup of Tea", to: "Cup", kind: "dependency" },
      { id: "dep-3", from: "Cup of Tea", to: "Tea", kind: "dependency" },
      { id: "dep-4", from: "Cup of Tea", to: "Hot Water", kind: "dependency" },
      { id: "dep-5", from: "Hot Water", to: "Water", kind: "dependency" },
      { id: "dep-6", from: "Hot Water", to: "Kettle", kind: "dependency" },
      { id: "dep-7", from: "Kettle", to: "Power", kind: "dependency" },
    ],
  });
});

test("extractTeamTopology: the shipped sample.tt example is pinned — real .tt files yield NO edges", () => {
  const graph = extractModelGraph("teams/sample.tt", fixture("sample.tt"));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "team-topology",
    nodes: [
      {
        id: "team_checkout",
        type: "stream-aligned",
        name: "Checkout Stream",
        extra: { description: "Owns the end-to-end checkout & payments journey." },
      },
      {
        id: "team_enabling",
        type: "enabling",
        name: "Agile Enablement",
        extra: { description: "Coaches teams on testing and continuous delivery practices." },
      },
      {
        id: "team_fraud",
        type: "complicated-subsystem",
        name: "Risk & Fraud Engine",
        extra: { description: "Specialist ML team owning real-time fraud scoring." },
      },
      {
        id: "team_mobile",
        type: "stream-aligned",
        name: "Mobile Experience",
        extra: { description: "Owns the native mobile shopping experience." },
      },
      {
        id: "team_platform",
        type: "platform",
        name: "Internal Developer Platform",
        extra: { description: "Self-service CI/CD, observability and runtime for all streams." },
      },
    ],
    edges: [],
  });
});

test("extractValueChain: defaults, label-over-name and conn-<i> ids are pinned", () => {
  const graph = extractModelGraph("chains/supply.vc.json", fixture("supply.vc.json"));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "value-chain",
    nodes: [
      { id: "sourcing", type: "primary", name: "Sourcing" },
      { id: "assembly", type: "element", name: "Assembly" },
      { id: "qa", type: "support", name: "Quality Assurance" },
    ],
    edges: [
      { id: "c1", from: "sourcing", to: "assembly", kind: "feeds" },
      { id: "conn-1", from: "assembly", to: "qa", kind: "connection" },
    ],
  });
});
