/**
 * deriveProcess(graph) => DerivedProcess — the "process.yaml on-the-fly".
 *
 * The slim content contract has NO hand-written process metadata: a process IS
 * a .bpmn file. This turns the generic ModelGraph (extract.ts) into the process
 * view everything used to read from process.yaml — name, the roles (BPMN lanes),
 * the steps/events/gateways, the flow, and the sub-process calls (callActivity →
 * calledElement). Consumers (MCP, validator, skills) read THIS instead of a file.
 *
 * deriveDecision(graph) is its DMN sibling: a decision IS a .dmn file, and its
 * view is the decision table itself (inputs, outputs, hit policy, rules) plus
 * the DRD wiring between decisions.
 *
 * Pure + browser-safe: operates on the already-parsed ModelGraph, no fs, no XML.
 */
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

const ACTIVITY_TYPES = new Set([
  "task",
  "userTask",
  "serviceTask",
  "scriptTask",
  "businessRuleTask",
  "manualTask",
  "sendTask",
  "receiveTask",
  "callActivity",
  "subProcess",
  "adHocSubProcess",
  "transaction",
]);
const EVENT_TYPES = new Set([
  "startEvent",
  "endEvent",
  "intermediateThrowEvent",
  "intermediateCatchEvent",
  "boundaryEvent",
]);

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

  const steps = graph.nodes.filter((n) => ACTIVITY_TYPES.has(n.type)).map(element);
  const events = graph.nodes.filter((n) => EVENT_TYPES.has(n.type)).map(element);
  const gateways = graph.nodes.filter((n) => n.type.endsWith("Gateway")).map(element);

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
