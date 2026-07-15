/**
 * extract(raw) => ModelGraph — the analysis seam of the notation registry.
 *
 * Every notation knows how to turn its raw file content into ONE generic
 * graph shape. Analyses (MCP tools, future dashboards) are written against
 * ModelGraph and automatically cover every notation that implements extract —
 * instead of one parser per tool per notation.
 *
 * Node-safe: fast-xml-parser + JSON + regex only, no DOM, no editor libraries.
 */
import { XMLParser } from "fast-xml-parser";

import { byExtension, byId, type NotationDescriptor } from "./index.ts";

export interface ModelNode {
  id: string;
  /** notation-level element type, namespace prefix stripped (e.g. "userTask", "decision", "component") */
  type: string;
  name?: string;
  extra?: Record<string, unknown>;
}

export interface ModelEdge {
  id: string;
  from: string;
  to: string;
  /** e.g. "sequenceFlow", "messageFlow", "informationRequirement", "dependency", "connection" */
  kind: string;
  name?: string;
}

export interface ModelGraph {
  notation: string;
  nodes: ModelNode[];
  edges: ModelEdge[];
  /** notation-specific context that is not graph-shaped (lanes, pools, hit policies …) */
  meta?: Record<string, unknown>;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const BPMN_FLOW_NODE_TAGS = new Set([
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
  "startEvent",
  "endEvent",
  "intermediateThrowEvent",
  "intermediateCatchEvent",
  "boundaryEvent",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "eventBasedGateway",
  "complexGateway",
]);

function extractBpmn(raw: string): ModelGraph {
  const defs = xml.parse(raw).definitions ?? {};
  const nodes: ModelNode[] = [];
  const edges: ModelEdge[] = [];
  const lanes: Array<{ id: string; name?: string; nodeIds: string[] }> = [];
  const pools: Array<{ id: string; name?: string; processRef?: string }> = [];

  const collect = (container: Record<string, unknown>, parent?: string): void => {
    for (const [tag, value] of Object.entries(container)) {
      if (tag === "sequenceFlow") {
        for (const f of asArray(value as Record<string, string>[])) {
          edges.push({
            id: f["@_id"] ?? "",
            from: f["@_sourceRef"] ?? "",
            to: f["@_targetRef"] ?? "",
            kind: "sequenceFlow",
            name: f["@_name"],
          });
        }
        continue;
      }
      if (!BPMN_FLOW_NODE_TAGS.has(tag)) continue;
      for (const el of asArray(value as Record<string, unknown>[])) {
        const rec = el as Record<string, string>;
        if (!rec["@_id"]) continue;
        nodes.push({
          id: rec["@_id"],
          type: tag,
          name: rec["@_name"],
          extra: {
            ...(parent ? { parent } : {}),
            ...(rec["@_calledElement"] ? { calledElement: rec["@_calledElement"] } : {}),
            ...(rec["@_attachedToRef"] ? { attachedTo: rec["@_attachedToRef"] } : {}),
          },
        });
        if (tag === "subProcess" || tag === "adHocSubProcess" || tag === "transaction") {
          collect(el as Record<string, unknown>, rec["@_id"]);
        }
      }
    }
  };

  for (const proc of asArray(defs.process as Record<string, unknown>[])) {
    collect(proc);
    const rec = proc as Record<string, any>;
    for (const lane of asArray(rec.laneSet?.lane)) {
      lanes.push({
        id: lane["@_id"],
        name: lane["@_name"],
        nodeIds: asArray(lane.flowNodeRef as string[]).map(String),
      });
    }
  }
  for (const collab of asArray(defs.collaboration as Record<string, unknown>[])) {
    const rec = collab as Record<string, any>;
    for (const p of asArray(rec.participant as Record<string, string>[])) {
      pools.push({ id: p["@_id"] ?? "", name: p["@_name"] ?? "", processRef: p["@_processRef"] ?? "" });
    }
    for (const mf of asArray(rec.messageFlow as Record<string, string>[])) {
      edges.push({
        id: mf["@_id"] ?? "",
        from: mf["@_sourceRef"] ?? "",
        to: mf["@_targetRef"] ?? "",
        kind: "messageFlow",
        name: mf["@_name"],
      });
    }
  }
  return { notation: "bpmn", nodes, edges, meta: { lanes, pools } };
}

function extractDmn(raw: string): ModelGraph {
  const defs = xml.parse(raw).definitions ?? {};
  const nodes: ModelNode[] = [];
  const edges: ModelEdge[] = [];
  for (const input of asArray(defs.inputData as Record<string, string>[])) {
    nodes.push({ id: input["@_id"] ?? "", type: "inputData", name: input["@_name"] ?? "" });
  }
  for (const decision of asArray(defs.decision as Record<string, any>[])) {
    const table = decision.decisionTable;
    nodes.push({
      id: decision["@_id"],
      type: "decision",
      name: decision["@_name"],
      extra: table
        ? {
            hitPolicy: table["@_hitPolicy"] ?? "UNIQUE",
            rules: asArray(table.rule).length,
            inputs: asArray(table.input)
              .map((i: any) => i.inputExpression?.text ?? i["@_label"])
              .filter(Boolean),
            outputs: asArray(table.output)
              .map((o: any) => o["@_name"] ?? o["@_label"])
              .filter(Boolean),
          }
        : undefined,
    });
    for (const req of asArray(decision.informationRequirement as Record<string, any>[])) {
      const href: string | undefined = req.requiredInput?.["@_href"] ?? req.requiredDecision?.["@_href"];
      if (href) {
        edges.push({
          id: req["@_id"] ?? `req-${edges.length}`,
          from: href.replace(/^#/, ""),
          to: decision["@_id"],
          kind: "informationRequirement",
        });
      }
    }
  }
  return { notation: "dmn", nodes, edges };
}

/** OWM DSL: `component Name [y, x]`, `Name -> Other`, `evolve Name x` */
function extractWardley(raw: string): ModelGraph {
  const nodes: ModelNode[] = [];
  const edges: ModelEdge[] = [];
  for (const m of raw.matchAll(/^component\s+([^[\n]+?)\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/gm)) {
    const evolution = Number(m[3]);
    nodes.push({
      id: m[1] ?? "",
      type: "component",
      name: m[1],
      extra: {
        visibility: Number(m[2]),
        evolution,
        stage:
          evolution < 0.25 ? "genesis" : evolution < 0.5 ? "custom-built" : evolution < 0.75 ? "product" : "commodity",
      },
    });
  }
  let i = 0;
  for (const m of raw.matchAll(/^([^\s>[\n][^>[\n]*?)\s*->\s*([^\n;]+)$/gm)) {
    edges.push({ id: `dep-${i++}`, from: m[1]?.trim() ?? "", to: m[2]?.trim() ?? "", kind: "dependency" });
  }
  return { notation: "wardley", nodes, edges };
}

function extractTeamTopology(raw: string): ModelGraph {
  const data = JSON.parse(raw) as { nodes?: any[]; edges?: any[] };
  return {
    notation: "team-topology",
    nodes: (data.nodes ?? []).map((n) => ({
      id: n.id,
      type: n.type ?? "team",
      name: n.label ?? n.name,
      extra: n.description ? { description: n.description } : undefined,
    })),
    edges: (data.edges ?? []).map((e, i) => ({
      id: e.id ?? `edge-${i}`,
      from: e.source ?? e.from,
      to: e.target ?? e.to,
      kind: e.interaction ?? e.type ?? "interaction",
    })),
  };
}

function extractValueChain(raw: string): ModelGraph {
  const data = JSON.parse(raw) as { elements?: any[]; connections?: any[] };
  return {
    notation: "value-chain",
    nodes: (data.elements ?? []).map((el) => ({
      id: el.id,
      type: el.elementType ?? "element",
      name: el.label ?? el.name,
    })),
    edges: (data.connections ?? []).map((c, i) => ({
      id: c.id ?? `conn-${i}`,
      from: c.source,
      to: c.target,
      kind: c.connectionType ?? "connection",
    })),
  };
}

const EXTRACTORS: Record<string, (raw: string) => ModelGraph> = {
  bpmn: extractBpmn,
  dmn: extractDmn,
  wardley: extractWardley,
  "team-topology": extractTeamTopology,
  "value-chain": extractValueChain,
};

/** notation id or file path in, ModelGraph out; undefined = no extractor registered */
export function extractModelGraph(notationOrPath: string, raw: string): ModelGraph | undefined {
  const notation: NotationDescriptor | undefined = byId(notationOrPath) ?? byExtension(notationOrPath);
  const extractor = notation && EXTRACTORS[notation.id];
  return extractor ? extractor(raw) : undefined;
}
