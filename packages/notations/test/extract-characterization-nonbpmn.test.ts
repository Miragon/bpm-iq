/**
 * CHARACTERIZATION of the wardley / team-topology / event-storming /
 * context-map / value-chain extractors —
 * pinned BEFORE registry-driven discovery makes them reachable (they are dead
 * code until then: no discovery path hands them a file, and nothing else
 * exercised them). The fixtures are the de-facto format spec: tea.owm,
 * sample.tt, order-checkout.storm and conference.cm.json are the shipped
 * examples of the Miragon modeler repos (wardley-maps-modeler,
 * team-topologies-modeler, event-storming-modeler, context-maps-modeler),
 * whose deterministic serializers define what real files look like.
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

test("extractEventStorming: the shipped order-checkout.storm example is pinned — ids equal the renderer's", () => {
  // every id below is what @miragon/event-storming-dsl parseDSL allocates for
  // the same file (`<prefix>_<slug>`, explicit `(id …)` kept) — the graph's
  // ids ARE the canvas element ids; `#agg_order` arrows resolve by id, the
  // rest by name; the note is a node but never an arrow endpoint
  const graph = extractModelGraph("boards/order-checkout.storm", fixture("order-checkout.storm"));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "event-storming",
    nodes: [
      { id: "actor_customer", type: "actor", name: "Customer", extra: { x: 80, y: 300 } },
      { id: "cmd_place_order", type: "command", name: "Place Order", extra: { x: 240, y: 300 } },
      { id: "agg_order", type: "aggregate", name: "Order", extra: { x: 420, y: 290 } },
      { id: "event_order_placed", type: "event", name: "Order Placed", extra: { x: 620, y: 300 } },
      {
        id: "policy_when_order_placed_ship_it",
        type: "policy",
        name: "When order placed, ship it",
        extra: { x: 800, y: 300 },
      },
      { id: "cmd_ship_order", type: "command", name: "Ship Order", extra: { x: 980, y: 300 } },
      { id: "agg_order_2", type: "aggregate", name: "Order", extra: { x: 1160, y: 290 } },
      { id: "event_order_shipped", type: "event", name: "Order Shipped", extra: { x: 1340, y: 300 } },
      { id: "read_order_status", type: "readmodel", name: "Order Status", extra: { x: 620, y: 120 } },
      { id: "ext_payment_provider", type: "external", name: "Payment Provider", extra: { x: 420, y: 520 } },
      {
        id: "hot_double_payment_on_retry",
        type: "hotspot",
        name: "Double payment on retry?",
        extra: { x: 620, y: 520 },
      },
      {
        id: "note_design_level_session_checkout_flow",
        type: "note",
        name: "Design-level session: checkout flow",
        extra: { x: 80, y: 80 },
      },
    ],
    edges: [
      { id: "arrow_1", from: "actor_customer", to: "cmd_place_order", kind: "arrow" },
      { id: "arrow_2", from: "cmd_place_order", to: "agg_order", kind: "arrow" },
      { id: "arrow_3", from: "cmd_place_order", to: "ext_payment_provider", kind: "arrow" },
      { id: "arrow_4", from: "agg_order", to: "event_order_placed", kind: "arrow" },
      { id: "arrow_5", from: "event_order_placed", to: "read_order_status", kind: "arrow" },
      { id: "arrow_6", from: "event_order_placed", to: "policy_when_order_placed_ship_it", kind: "arrow" },
      { id: "arrow_7", from: "policy_when_order_placed_ship_it", to: "cmd_ship_order", kind: "arrow" },
      { id: "arrow_8", from: "cmd_ship_order", to: "agg_order_2", kind: "arrow" },
      { id: "arrow_9", from: "agg_order_2", to: "event_order_shipped", kind: "arrow" },
    ],
    meta: { title: "Order Checkout", level: null },
  });
});

test("extractEventStorming: suffixes, pinning, drawings, comments and arrow labels follow the DSL", () => {
  // expected values cross-checked against parseDSL of the same text
  const storm = [
    "title As-Is -> To-Be", // an arrow-looking title is a title (no sticky named "As-Is" yet)
    "level process",
    "style dark", // config the graph does not carry",
    "/* block",
    "comment */ event Order Placed [620, 300]",
    "external Payment Provider [420, 520] (color #ff00aa) // trailing comment",
    "hotspot Double payment? [620, 520] (on Order Placed)",
    "actor Customer (on Nobody)", // no coordinates → [0, 0]; unresolved host → no pin
    "note Session [80, 80] (size 200x120) (align center middle) (on Order Placed)",
    "line [[100, 100], [200, 150], [180, 240]] (dashed)",
    "line [[1, 1]]", // a single point is no drawing
    "event Broken [x, y]", // malformed coordinates are skipped
    "Order Placed -> Payment Provider; async",
    "Customer -> #ext_payment_provider",
    "Session -> Order Placed", // a note is never an arrow endpoint
    "Ghost -> Order Placed", // unresolved → dropped, like the canvas
  ].join("\n");
  const graph = extractModelGraph("boards/x.storm", storm);
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "event-storming",
    nodes: [
      { id: "event_order_placed", type: "event", name: "Order Placed", extra: { x: 620, y: 300 } },
      {
        id: "ext_payment_provider",
        type: "external",
        name: "Payment Provider",
        extra: { x: 420, y: 520, color: "#ff00aa" },
      },
      {
        id: "hot_double_payment",
        type: "hotspot",
        name: "Double payment?",
        extra: { x: 620, y: 520, attachedTo: "event_order_placed" },
      },
      { id: "actor_customer", type: "actor", name: "Customer", extra: { x: 0, y: 0 } },
      { id: "note_session", type: "note", name: "Session", extra: { x: 80, y: 80, attachedTo: "event_order_placed" } },
      { id: "draw_line", type: "drawing", extra: { x: 100, y: 100, points: 3 } },
    ],
    edges: [
      { id: "arrow_1", from: "event_order_placed", to: "ext_payment_provider", kind: "arrow", name: "async" },
      { id: "arrow_2", from: "actor_customer", to: "ext_payment_provider", kind: "arrow" },
    ],
    meta: { title: "As-Is -> To-Be", level: "process" },
  });
});

test("extractContextMap: the schema-model's SAMPLE_DOCUMENT is pinned — ids equal the renderer's", () => {
  // conference.cm.json is serializeDocument(SAMPLE_DOCUMENT) of
  // @miragon/context-maps-schema-model 0.1.0 (canonical: sorted by id) —
  // every id below is what the renderer's importer registers as element id;
  // the subdomain type is the node type, the pattern the edge kind, the
  // integration roles ride in edge.extra
  const graph = extractModelGraph("maps/conference.cm.json", fixture("conference.cm.json"));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "context-map",
    nodes: [
      {
        id: "ctx_auth",
        type: "generic",
        name: "User Access",
        extra: {
          team: "Platform Team",
          description: "Registration and authentication for speakers and attendees.",
          x: 40,
          y: 300,
          width: 200,
          height: 110,
        },
      },
      {
        id: "ctx_cfp",
        type: "supporting",
        name: "CfP Management",
        extra: {
          team: "Program Team",
          description: "Runs the call for papers and exposes the public submission API.",
          x: 340,
          y: 120,
          width: 200,
          height: 110,
        },
      },
      {
        id: "ctx_evaluation",
        type: "core",
        name: "Session Evaluation",
        extra: {
          team: "Review Team",
          description: "Scoring and selection of submitted sessions.",
          x: 960,
          y: 140,
          width: 200,
          height: 110,
        },
      },
      {
        id: "ctx_notification",
        type: "generic",
        name: "Notification Handling",
        extra: {
          team: "Platform Team",
          description: "Sends emails to speakers and attendees, conforming to the schedule events.",
          x: 1280,
          y: 580,
          width: 200,
          height: 110,
        },
      },
      {
        id: "ctx_schedule",
        type: "core",
        name: "Schedule Management",
        extra: {
          team: "Program Team",
          description: "Builds and publishes the conference schedule.",
          x: 960,
          y: 440,
          width: 200,
          height: 110,
        },
      },
      {
        id: "ctx_submission",
        type: "supporting",
        name: "Submission Handling",
        extra: {
          team: "Program Team",
          description: "Owns proposals once submitted; the hub other contexts integrate with.",
          x: 640,
          y: 300,
          width: 200,
          height: 110,
        },
      },
    ],
    edges: [
      {
        id: "rel_auth_cfp",
        from: "ctx_auth",
        to: "ctx_cfp",
        kind: "upstream-downstream",
        name: "identity",
        extra: { upstreamRoles: ["OHS"], downstreamRoles: ["ACL"] },
      },
      {
        id: "rel_cfp_submission",
        from: "ctx_cfp",
        to: "ctx_submission",
        kind: "shared-kernel",
        name: "proposal model",
      },
      {
        id: "rel_evaluation_schedule",
        from: "ctx_evaluation",
        to: "ctx_schedule",
        kind: "customer-supplier",
        name: "accepted sessions",
        extra: { upstreamRoles: ["PL"] },
      },
      {
        id: "rel_schedule_notification",
        from: "ctx_schedule",
        to: "ctx_notification",
        kind: "upstream-downstream",
        name: "schedule events",
        extra: { upstreamRoles: ["OHS", "PL"], downstreamRoles: ["CF"] },
      },
      {
        id: "rel_submission_evaluation",
        from: "ctx_submission",
        to: "ctx_evaluation",
        kind: "upstream-downstream",
        name: "submissions API",
        extra: { upstreamRoles: ["OHS"], downstreamRoles: ["ACL"], implementationTechnology: "RESTful HTTP" },
      },
      {
        id: "rel_submission_schedule",
        from: "ctx_submission",
        to: "ctx_schedule",
        kind: "upstream-downstream",
        extra: { upstreamRoles: ["OHS"], downstreamRoles: ["ACL"] },
      },
    ],
    meta: { title: "Conference event planner — context map" },
  });
});

test("extractContextMap: lenient like the schema-model's migrate — missing containers, id-less contexts, rel-<i> ids", () => {
  const raw = JSON.stringify({
    title: 7, // not a string → no title
    contexts: [
      { id: "a", label: "A" }, // no geometry, no classification → plain "context" at 0/0
      { label: "no id" }, // skipped: a context IS its id
      null,
      { id: "b", label: "B", subdomainType: "weird", team: "", position: { x: "1" } },
    ],
    relationships: [
      { from: "a", to: "b", pattern: "partnership", upstreamRoles: ["OHS", 3] }, // id-less → rel-0; non-string roles dropped
      { id: "r2", from: "a", to: "ghost", pattern: "separate-ways", implementationTechnology: "gRPC" }, // dangling endpoint kept — the canvas has it too
      "junk",
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(extractModelGraph("maps/x.cm.json", raw))), {
    notation: "context-map",
    nodes: [
      { id: "a", type: "context", name: "A", extra: { x: 0, y: 0, width: 0, height: 0 } },
      { id: "b", type: "context", name: "B", extra: { x: 0, y: 0, width: 0, height: 0 } },
    ],
    edges: [
      { id: "rel-0", from: "a", to: "b", kind: "partnership", extra: { upstreamRoles: ["OHS"] } },
      { id: "r2", from: "a", to: "ghost", kind: "separate-ways", extra: { implementationTechnology: "gRPC" } },
    ],
    meta: { title: null },
  });
  // a non-object document (parseable JSON, wrong shape) is an empty map, not a crash
  for (const raw of ["[]", '"text"', "null", "42"]) {
    assert.deepEqual(JSON.parse(JSON.stringify(extractModelGraph("maps/x.cm.json", raw))), {
      notation: "context-map",
      nodes: [],
      edges: [],
      meta: { title: null },
    });
  }
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

test("extractWardley: DIRECTIVE lines containing '->' are never dependency edges (#139 review)", () => {
  // `evolution` is OWM syntax; a title with an arrow is platform-authorable
  // via the create dialog ("As-Is -> To-Be") — neither is a dependency
  const owm = [
    "title As-Is -> To-Be",
    "evolution Genesis->Custom->Product->Commodity",
    "component A [0.5, 0.5]",
    "component B [0.4, 0.6]",
    "A -> B",
  ].join("\n");
  const graph = extractModelGraph("maps/x.owm", owm);
  assert.ok(graph, "wardley extractor resolved");
  assert.deepEqual(
    JSON.parse(JSON.stringify(graph.edges)),
    [{ id: "dep-0", from: "A", to: "B", kind: "dependency" }],
    "only the real dependency line survives",
  );
});
