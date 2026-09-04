/**
 * The derive capability: ModelGraph → human/agent-readable views.
 *
 * deriveView(graph) is the GENERIC dispatch — one common core (name, summary,
 * stats, rich payload in `detail`) for every notation with a registered
 * deriver; consumers that want "a view of whatever this model is" (listings,
 * get_view) call it and never gate on the notation.
 *
 * deriveProcess(graph) => DerivedProcess is the rich BPMN view — the
 * "process.yaml on-the-fly": the slim content contract has NO hand-written
 * process metadata, so this turns the generic ModelGraph (extract.ts) into
 * name, roles (BPMN lanes), steps/events/gateways, flow and sub-process calls.
 * deriveDecision(graph) is its DMN sibling (decision table + DRD wiring).
 * Consumers that need those FIELDS keep calling them directly.
 *
 * Pure + browser-safe: operates on the already-parsed ModelGraph, no fs, no
 * XML — this module is imported eagerly by the web SPA
 * (CI: notations-index-and-derive-stay-browser-safe).
 */
import { kindOf } from "./bpmn-kinds.ts";
import type { ModelGraph, ModelNode } from "./extract.ts";

/** a BPMN lane — the closest thing the model has to an owning team/role */
export interface ProcessRole {
  id: string;
  name: string | null;
  /** flow-node ids this lane contains */
  stepIds: string[];
}

/** one flow node of the process (step, event or gateway) */
export interface ProcessElement {
  id: string;
  name: string | null;
  /** BPMN local type, e.g. "userTask", "startEvent", "exclusiveGateway" */
  type: string;
  /** owning lane name, when the model has lanes */
  role?: string | null;
  /** for callActivity: the id of the process it calls */
  calls?: string;
  /** for businessRuleTask: the id of the decision it delegates to */
  decides?: string;
}

export interface DerivedProcess {
  /** process name, else the single pool's name, else null */
  name: string | null;
  /** BPMN pools (participants) */
  pools: { id: string; name: string | null }[];
  /** BPMN lanes = roles/teams */
  roles: ProcessRole[];
  /** activities: tasks, sub-processes, call activities */
  steps: ProcessElement[];
  /** start/end/intermediate/boundary events */
  events: ProcessElement[];
  /** gateways (branch points) */
  gateways: ProcessElement[];
  /** sequence + message flows */
  flows: { id: string; from: string; to: string; name: string | null; kind: string }[];
  /** callActivity → calledElement: the processes this one delegates to */
  calls: { id: string; name: string | null; calledElement: string }[];
  /** businessRuleTask → the DMN decisions this process delegates to */
  decisions: { id: string; name: string | null; decisionRef: string }[];
  stats: { steps: number; events: number; gateways: number; flows: number; roles: number };
}

/** the ModelGraph shape deriveProcess reads from BPMN extract meta */
interface BpmnMeta {
  lanes?: { id: string; name?: string; nodeIds: string[] }[];
  pools?: { id: string; name?: string; processRef?: string }[];
}

/**
 * Derive the process view from a BPMN ModelGraph. Non-BPMN graphs yield an empty
 * process (only BPMN carries process semantics); callers gate on graph.notation.
 */
export function deriveProcess(graph: ModelGraph): DerivedProcess {
  const meta = (graph.meta ?? {}) as BpmnMeta;
  const lanes = meta.lanes ?? [];
  // extract sets a missing participant name to "" — normalize to null so the
  // "?? id" fallback in consumers (MCP list_processes/get_process) works
  const pools = (meta.pools ?? []).map((p) => ({ id: p.id, name: p.name || null }));

  // node id → owning lane name (a node belongs to at most one lane)
  const roleOf = new Map<string, string | null>();
  for (const lane of lanes) {
    for (const nodeId of lane.nodeIds) roleOf.set(nodeId, lane.name ?? null);
  }

  const element = (n: ModelNode): ProcessElement => {
    const calls = (n.extra?.calledElement as string | undefined) ?? undefined;
    const decides = (n.extra?.decisionRef as string | undefined) ?? undefined;
    return {
      id: n.id,
      name: n.name ?? null,
      type: n.type,
      ...(roleOf.has(n.id) ? { role: roleOf.get(n.id) ?? null } : {}),
      ...(calls ? { calls } : {}),
      ...(decides ? { decides } : {}),
    };
  };

  const steps = graph.nodes.filter((n) => kindOf(n.type) === "activity").map(element);
  const events = graph.nodes.filter((n) => kindOf(n.type) === "event").map(element);
  const gateways = graph.nodes.filter((n) => kindOf(n.type) === "gateway").map(element);

  const flows = graph.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    name: e.name ?? null,
    kind: e.kind,
  }));

  const calls = graph.nodes
    .filter((n) => n.type === "callActivity" && n.extra?.calledElement)
    .map((n) => ({ id: n.id, name: n.name ?? null, calledElement: String(n.extra?.calledElement) }));

  const decisions = graph.nodes
    .filter((n) => n.extra?.decisionRef)
    .map((n) => ({ id: n.id, name: n.name ?? null, decisionRef: String(n.extra?.decisionRef) }));

  const roles: ProcessRole[] = lanes.map((l) => ({ id: l.id, name: l.name ?? null, stepIds: l.nodeIds }));

  // name: single pool name is the most process-like label; else null (the file
  // stem is the id the caller already has). Multiple pools → leave null.
  const name = pools.length === 1 ? pools[0]?.name || null : null;

  return {
    name,
    pools,
    roles,
    steps,
    events,
    gateways,
    flows,
    calls,
    decisions,
    stats: {
      steps: steps.length,
      events: events.length,
      gateways: gateways.length,
      flows: flows.length,
      roles: roles.length,
    },
  };
}

// ── DMN ──────────────────────────────────────────────────────────────────────

export type HitPolicy = "UNIQUE" | "FIRST" | "ANY" | "PRIORITY" | "COLLECT" | "RULE ORDER" | "OUTPUT ORDER";
export type Aggregation = "SUM" | "MIN" | "MAX" | "COUNT";

/** one input column of a decision table */
export interface DecisionInput {
  id: string;
  /** column header; falls back to the input expression */
  label: string;
  /** the FEEL input expression = the variable the column reads (e.g. "amount") */
  expression: string;
  typeRef: string;
  /** allowed input values from <inputValues>, raw FEEL items ("" = unconstrained) */
  inputValues: string[];
}

/** one output column of a decision table */
export interface DecisionOutput {
  id: string;
  /** the key results are reported under */
  name: string;
  label: string;
  typeRef: string;
  /** <outputValues> in priority order — drives PRIORITY / OUTPUT ORDER */
  outputValues: string[];
}

/** one rule row; `when`/`then` are aligned to the table's inputs/outputs */
export interface DecisionRule {
  id: string;
  /** raw FEEL unary tests, one per input column ("" and "-" both mean "any") */
  when: string[];
  /** raw FEEL expressions, one per output column */
  then: string[];
  description?: string;
}

/** one decision of the DRD — a table, a literal expression, or logic-less */
export interface DecisionView {
  id: string;
  name: string | null;
  /** the name downstream decisions reference the result by (<variable name>) */
  variable: string;
  typeRef: string;
  kind: "decisionTable" | "literalExpression" | "none";
  hitPolicy?: HitPolicy;
  aggregation?: Aggregation;
  inputs: DecisionInput[];
  outputs: DecisionOutput[];
  rules: DecisionRule[];
  /** FEEL source when kind === "literalExpression" */
  expression?: string;
  /** information requirements: what this decision reads */
  requires: { inputData: string[]; decisions: string[] };
}

/** an InputData node — a value the caller supplies when the DRD is evaluated */
export interface DecisionInputData {
  id: string;
  name: string | null;
  /** the variable name expressions bind to */
  variable: string;
  typeRef: string;
}

export interface DerivedDecision {
  /** the DMN definitions name, else null */
  name: string | null;
  decisions: DecisionView[];
  inputData: DecisionInputData[];
  stats: { decisions: number; inputData: number; rules: number };
}

const HIT_POLICIES = new Set<string>(["UNIQUE", "FIRST", "ANY", "PRIORITY", "COLLECT", "RULE ORDER", "OUTPUT ORDER"]);
const AGGREGATIONS = new Set<string>(["SUM", "MIN", "MAX", "COUNT"]);

/**
 * Derive the decision view from a DMN ModelGraph. Non-DMN graphs yield an
 * empty decision (only DMN carries decision semantics); callers gate on
 * graph.notation, exactly like deriveProcess.
 */
export function deriveDecision(graph: ModelGraph): DerivedDecision {
  const meta = (graph.meta ?? {}) as { name?: string | null };

  const inputData: DecisionInputData[] = graph.nodes
    .filter((n) => n.type === "inputData")
    .map((n) => ({
      id: n.id,
      name: n.name || null,
      variable: String(n.extra?.variable ?? n.name ?? n.id),
      typeRef: String(n.extra?.typeRef ?? "string"),
    }));

  const inputDataIds = new Set(inputData.map((i) => i.id));

  const decisions: DecisionView[] = graph.nodes
    .filter((n) => n.type === "decision")
    .map((n) => {
      const extra = (n.extra ?? {}) as Record<string, unknown>;
      const sources = graph.edges.filter((e) => e.kind === "informationRequirement" && e.to === n.id);
      const hitPolicy = String(extra.hitPolicy ?? "");
      const aggregation = String(extra.aggregation ?? "");
      const rules = (extra.rules as Array<Record<string, unknown>> | undefined) ?? [];
      return {
        id: n.id,
        name: n.name || null,
        variable: String(extra.variable ?? n.name ?? n.id),
        typeRef: String(extra.typeRef ?? "string"),
        kind: (extra.kind as DecisionView["kind"]) ?? "none",
        ...(HIT_POLICIES.has(hitPolicy) ? { hitPolicy: hitPolicy as HitPolicy } : {}),
        ...(AGGREGATIONS.has(aggregation) ? { aggregation: aggregation as Aggregation } : {}),
        inputs: ((extra.inputs as DecisionInput[] | undefined) ?? []).map((i) => ({ ...i })),
        outputs: ((extra.outputs as DecisionOutput[] | undefined) ?? []).map((o) => ({ ...o })),
        rules: rules.map((r) => ({
          id: String(r.id ?? ""),
          when: (r.inputEntries as string[] | undefined) ?? [],
          then: (r.outputEntries as string[] | undefined) ?? [],
          ...(r.description ? { description: String(r.description) } : {}),
        })),
        ...(extra.expression ? { expression: String(extra.expression) } : {}),
        requires: {
          inputData: sources.filter((e) => inputDataIds.has(e.from)).map((e) => e.from),
          decisions: sources.filter((e) => !inputDataIds.has(e.from)).map((e) => e.from),
        },
      };
    });

  return {
    name: meta.name || null,
    decisions,
    inputData,
    stats: {
      decisions: decisions.length,
      inputData: inputData.length,
      rules: decisions.reduce((sum, d) => sum + d.rules.length, 0),
    },
  };
}

// ── the generic view (deriveView) ────────────────────────────────────────────

/**
 * The common core every notation's derived view shares — what listings and
 * generic tools consume. The rich, notation-typed payload (DerivedProcess,
 * DerivedDecision, …) rides in `detail` for consumers that know the notation.
 */
export interface DerivedView {
  notation: string;
  /** the model's own title (pool name, definitions name, …) — null when the
   *  file carries none (the file stem is the id the caller already has) */
  name: string | null;
  /** one deterministic sentence for humans and agents */
  summary: string;
  /** listing badges and counts, e.g. { steps: 7, gateways: 2 } */
  stats: Record<string, number>;
  detail?: unknown;
}

/** "3 steps, 1 gateway" — deterministic stats prose for the summary line */
const counted = (stats: Record<string, number>): string =>
  Object.entries(stats)
    .map(([k, v]) => `${v} ${v === 1 ? k.replace(/ies$/, "y").replace(/s$/, "") : k}`)
    .join(", ");

/** the sticky kinds of an event storming board — the nodes with a place on
 *  the timeline (notes and drawings are annotations). The .storm vocabulary,
 *  mirrored here so this eager module stays free of extract.ts values */
const STORM_STICKY_KINDS = new Set([
  "event",
  "command",
  "actor",
  "aggregate",
  "policy",
  "readmodel",
  "external",
  "hotspot",
]);

/** the board read the way a facilitator reads it — stickies left to right
 *  (x, then y, then id: the schema-model's own sortByTimeline rule) */
function stormTimeline(graph: ModelGraph): Array<{ id: string; type: string; name: string | null }> {
  const pos = (n: ModelNode): [number, number] => [Number(n.extra?.x ?? 0), Number(n.extra?.y ?? 0)];
  return graph.nodes
    .filter((n) => STORM_STICKY_KINDS.has(n.type))
    .sort((a, b) => {
      const [ax, ay] = pos(a);
      const [bx, by] = pos(b);
      return ax - bx || ay - by || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    })
    .map((n) => ({ id: n.id, type: n.type, name: n.name ?? null }));
}

/** the context-map vocabulary (@miragon/context-maps-schema-model
 *  SUBDOMAIN_TYPES / RELATIONSHIP_PATTERNS), in the notation's own order —
 *  mirrored here like the storm kinds so this eager module stays zero-dep */
const CM_SUBDOMAIN_TYPES: readonly string[] = ["core", "supporting", "generic"];
const CM_RELATIONSHIP_PATTERNS: readonly string[] = [
  "partnership",
  "shared-kernel",
  "customer-supplier",
  "upstream-downstream",
  "separate-ways",
];

const DERIVERS: Record<string, (graph: ModelGraph) => DerivedView> = {
  bpmn: (graph) => {
    const d = deriveProcess(graph);
    return {
      notation: "bpmn",
      name: d.name,
      summary: `Process with ${counted(d.stats)}`,
      stats: { ...d.stats },
      detail: d,
    };
  },
  dmn: (graph) => {
    const d = deriveDecision(graph);
    return {
      notation: "dmn",
      name: d.name,
      summary: `Decision model with ${counted(d.stats)}`,
      stats: { ...d.stats },
      detail: d,
    };
  },
  wardley: (graph) => {
    const stats = { components: graph.nodes.length, dependencies: graph.edges.length };
    return { notation: "wardley", name: null, summary: `Wardley map with ${counted(stats)}`, stats };
  },
  "team-topology": (graph) => {
    const stats = { teams: graph.nodes.length, interactions: graph.edges.length };
    return { notation: "team-topology", name: null, summary: `Team topology with ${counted(stats)}`, stats };
  },
  "event-storming": (graph) => {
    const count = (type: string): number => graph.nodes.filter((n) => n.type === type).length;
    const stats: Record<string, number> = {
      events: count("event"),
      commands: count("command"),
      actors: count("actor"),
      aggregates: count("aggregate"),
      policies: count("policy"),
      readmodels: count("readmodel"),
      externals: count("external"),
      hotspots: count("hotspot"),
      notes: count("note"),
      drawings: count("drawing"),
      arrows: graph.edges.length,
    };
    // only what is on the board — an empty one would read "0 events, 0 commands, …"
    const present = Object.fromEntries(Object.entries(stats).filter(([, v]) => v > 0));
    const title = graph.meta?.title;
    return {
      notation: "event-storming",
      name: typeof title === "string" ? title : null,
      summary: `Event storming board with ${Object.keys(present).length > 0 ? counted(present) : "no elements"}`,
      stats,
      detail: { level: graph.meta?.level ?? null, timeline: stormTimeline(graph) },
    };
  },
  "context-map": (graph) => {
    const stats: Record<string, number> = { contexts: graph.nodes.length, relationships: graph.edges.length };
    for (const t of CM_SUBDOMAIN_TYPES) stats[t] = graph.nodes.filter((n) => n.type === t).length;
    for (const p of CM_RELATIONSHIP_PATTERNS) stats[p] = graph.edges.filter((e) => e.kind === p).length;
    // "6 contexts (2 core, 2 supporting, 2 generic), 6 relationships (4
    // upstream-downstream, …)" — the breakdown lists only what is on the map,
    // in the notation's own order; the ids stay as they are (no pluralizing)
    const breakdown = (keys: readonly string[]): string => {
      const present = keys.filter((k) => (stats[k] ?? 0) > 0).map((k) => `${stats[k]} ${k}`);
      return present.length > 0 ? ` (${present.join(", ")})` : "";
    };
    const title = graph.meta?.title;
    return {
      notation: "context-map",
      name: typeof title === "string" ? title : null,
      summary:
        `Context map with ${counted({ contexts: stats.contexts! })}${breakdown(CM_SUBDOMAIN_TYPES)}, ` +
        `${counted({ relationships: stats.relationships! })}${breakdown(CM_RELATIONSHIP_PATTERNS)}`,
      stats,
      detail: {
        contexts: graph.nodes.map((n) => ({
          id: n.id,
          name: n.name ?? null,
          subdomainType: CM_SUBDOMAIN_TYPES.includes(n.type) ? n.type : null,
          team: (n.extra?.team as string | undefined) ?? null,
          description: (n.extra?.description as string | undefined) ?? null,
        })),
        relationships: graph.edges.map((e) => ({
          id: e.id,
          from: e.from,
          to: e.to,
          pattern: e.kind,
          upstreamRoles: (e.extra?.upstreamRoles as string[] | undefined) ?? [],
          downstreamRoles: (e.extra?.downstreamRoles as string[] | undefined) ?? [],
          label: e.name ?? null,
          implementationTechnology: (e.extra?.implementationTechnology as string | undefined) ?? null,
        })),
      },
    };
  },
  "value-chain": (graph) => {
    const stats = { elements: graph.nodes.length, connections: graph.edges.length };
    return { notation: "value-chain", name: null, summary: `Value chain with ${counted(stats)}`, stats };
  },
};

/**
 * THE generic derive dispatch: the view of whatever notation `graph` carries;
 * `undefined` when no deriver is registered (the caller falls back to the
 * bare listing row). Registering a notation's deriver here is the whole
 * integration — no consumer changes.
 */
export function deriveView(graph: ModelGraph): DerivedView | undefined {
  return DERIVERS[graph.notation]?.(graph);
}

/** whether a notation has a registered deriver — lets tool copy and
 *  capability listings stay registry-driven instead of hand-enumerated */
export function hasDeriver(notation: string): boolean {
  return notation in DERIVERS;
}
