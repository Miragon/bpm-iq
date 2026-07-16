/**
 * deriveProcess(graph) => DerivedProcess — the "process.yaml on-the-fly".
 *
 * The slim content contract has NO hand-written process metadata: a process IS
 * a .bpmn file. This turns the generic ModelGraph (extract.ts) into the process
 * view everything used to read from process.yaml — name, the roles (BPMN lanes),
 * the steps/events/gateways, the flow, and the sub-process calls (callActivity →
 * calledElement). Consumers (MCP, validator, skills) read THIS instead of a file.
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
    return {
      id: n.id,
      name: n.name ?? null,
      type: n.type,
      ...(roleOf.has(n.id) ? { role: roleOf.get(n.id) ?? null } : {}),
      ...(calls ? { calls } : {}),
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
    stats: {
      steps: steps.length,
      events: events.length,
      gateways: gateways.length,
      flows: flows.length,
      roles: roles.length,
    },
  };
}
