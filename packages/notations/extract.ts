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

/**
 * The decision a businessRuleTask delegates to. BPMN 2.0 has no standard
 * attribute for it, so every engine invented its own — all of them are read
 * here (namespace prefixes are already stripped by the parser):
 *
 *   decisionRef="x"                              Camunda 7
 *   <extensionElements><calledDecision decisionId="x"/>   Camunda 8 / Zeebe
 *   calledDecision="x" / calledElement="x"       hand-written models
 *
 * The platform contract is the same as for callActivity: the value names the
 * DECISION FILE STEM, so the link resolves against the repo's .dmn files.
 */
function decisionRefOf(task: Record<string, any>): string | undefined {
  const called = task.extensionElements?.calledDecision;
  const fromExtension = asArray(called as Record<string, string>[])[0]?.["@_decisionId"];
  const ref =
    task["@_decisionRef"] ?? fromExtension ?? task["@_calledDecision"] ?? task["@_calledElement"] ?? undefined;
  const text = ref === undefined || ref === null ? "" : String(ref).trim();
  return text === "" ? undefined : text;
}

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
        const decisionRef = tag === "businessRuleTask" ? decisionRefOf(el as Record<string, any>) : undefined;
        nodes.push({
          id: rec["@_id"],
          type: tag,
          name: rec["@_name"],
          extra: {
            ...(parent ? { parent } : {}),
            ...(rec["@_calledElement"] ? { calledElement: rec["@_calledElement"] } : {}),
            ...(rec["@_attachedToRef"] ? { attachedTo: rec["@_attachedToRef"] } : {}),
            ...(decisionRef ? { decisionRef } : {}),
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

/**
 * A tag's text content as a STRING. fast-xml-parser coerces tag values
 * ("42" → 42, "true" → true), but every DMN entry is FEEL SOURCE TEXT — a
 * rule entry `1` must stay the literal "1", never the number. Empty and
 * self-closing tags collapse to "" (an empty entry means "any" in DMN).
 */
function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return textOf((value as Record<string, unknown>)["#text"]);
  return String(value);
}

/**
 * DMN: decisions (with their full decision-table logic), input data and the
 * information requirements between them. The table detail rides in
 * node.extra — deriveDecision (derive.ts) turns it into the decision view,
 * and the simulator (@bpmiq/decisions) into its evaluation model, so this is
 * the ONE DMN parser on the server side.
 */
function extractDmn(raw: string): ModelGraph {
  const defs = xml.parse(raw).definitions ?? {};
  const nodes: ModelNode[] = [];
  const edges: ModelEdge[] = [];
  for (const input of asArray(defs.inputData as Record<string, any>[])) {
    nodes.push({
      id: input["@_id"] ?? "",
      type: "inputData",
      name: input["@_name"] ?? "",
      extra: {
        // the DRD binds an input's value to its variable name; the InputData
        // name is only the label when a <variable> declares its own
        variable: input.variable?.["@_name"] ?? input["@_name"] ?? "",
        typeRef: input.variable?.["@_typeRef"] ?? "string",
      },
    });
  }
  for (const decision of asArray(defs.decision as Record<string, any>[])) {
    const table = decision.decisionTable;
    const literal = decision.literalExpression;
    nodes.push({
      id: decision["@_id"],
      type: "decision",
      name: decision["@_name"],
      extra: {
        // downstream decisions reference THIS name, not the decision id
        variable: decision.variable?.["@_name"] ?? decision["@_name"] ?? decision["@_id"],
        typeRef: decision.variable?.["@_typeRef"] ?? "string",
        ...(table
          ? {
              kind: "decisionTable",
              hitPolicy: table["@_hitPolicy"] ?? "UNIQUE",
              ...(table["@_aggregation"] ? { aggregation: table["@_aggregation"] } : {}),
              inputs: asArray(table.input as Record<string, any>[]).map((i, n) => ({
                id: i["@_id"] ?? `Input_${n + 1}`,
                label: i["@_label"] ?? textOf(i.inputExpression?.text),
                expression: textOf(i.inputExpression?.text),
                typeRef: i.inputExpression?.["@_typeRef"] ?? "string",
                inputValues: splitFeelList(textOf(i.inputValues?.text)),
              })),
              outputs: asArray(table.output as Record<string, any>[]).map((o, n) => ({
                id: o["@_id"] ?? `Output_${n + 1}`,
                name: o["@_name"] ?? o["@_label"] ?? "",
                label: o["@_label"] ?? o["@_name"] ?? "",
                typeRef: o["@_typeRef"] ?? "string",
                outputValues: splitFeelList(textOf(o.outputValues?.text)),
              })),
              rules: asArray(table.rule as Record<string, any>[]).map((r, n) => ({
                id: r["@_id"] ?? `Rule_${n + 1}`,
                description: textOf(r.description) || undefined,
                inputEntries: asArray(r.inputEntry as Record<string, any>[]).map((e) => textOf(e.text)),
                outputEntries: asArray(r.outputEntry as Record<string, any>[]).map((e) => textOf(e.text)),
              })),
            }
          : literal
            ? { kind: "literalExpression", expression: textOf(literal.text) }
            : { kind: "none" }),
      },
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
  return {
    notation: "dmn",
    nodes,
    edges,
    meta: { name: defs["@_name"] ?? null, namespace: defs["@_namespace"] ?? null },
  };
}

/** `"a","b"` (a DMN inputValues/outputValues list) → the raw FEEL items */
function splitFeelList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
