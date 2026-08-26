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

// re-exported so the validator's raw well-formedness check needs no direct
// fast-xml-parser import (arch rule one-bpmn-reader: the parser dependency
// lives HERE, once)
export { XMLValidator } from "fast-xml-parser";

import { BPMN_DI_ARTIFACT_TAGS, BPMN_FLOW_NODE_TAGS, BPMN_SUB_CONTAINER_TAGS } from "./bpmn-kinds.ts";
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

/** the ONE fast-xml-parser configuration (the validator used to carry a
 *  byte-identical copy — that is how the two BPMN walks drifted) */
export const parseXml = (raw: string): Record<string, any> => xml.parse(raw) as Record<string, any>;

export const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

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
 *
 * Exported as THE spelling list: the validator's link-integrity check must
 * read exactly what the platform follows, or a spelling becomes a link that
 * get_process reports and no check ever verifies (that drift shipped once).
 */
export function decisionRefOf(task: Record<string, any>): string | undefined {
  const called = task.extensionElements?.calledDecision;
  const fromExtension = asArray(called as Record<string, string>[])[0]?.["@_decisionId"];
  const ref =
    task["@_decisionRef"] ?? fromExtension ?? task["@_calledDecision"] ?? task["@_calledElement"] ?? undefined;
  const text = ref === undefined || ref === null ? "" : String(ref).trim();
  return text === "" ? undefined : text;
}

// ── the ONE BPMN walk ────────────────────────────────────────────────────────
// readBpmn serves BOTH consumers of the tree: extractBpmn (the flat
// ModelGraph) and the validator's checkBpmnXml (per-container structure,
// DI-required ids). One set of node RECORDS, two views: the flat arrays keep
// the exact extraction order (tag-grouped first-occurrence order with
// recursion inline at the sub-container key — fast-xml-parser groups repeated
// tags, so this is NOT document order), the per-container Maps keep the
// validator's last-wins semantics. diRequired is filled INLINE during the
// walk — the DI-error ORDER is wire-visible and interleaves node, flow and
// artifact ids at their tag-key positions.

export interface BpmnModelNode {
  id: string;
  /** element tag, namespace prefix stripped (e.g. "userTask") */
  tag: string;
  name?: string;
  /** boundaryEvent → its host activity */
  attachedTo?: string;
  /** callActivity → the called process (raw attribute — any tag may carry it) */
  calledElement?: string;
  /** businessRuleTask → the decision it delegates to (decisionRefOf) */
  decisionRef?: string;
  container: BpmnContainer;
}

export interface BpmnContainer {
  /** for messages: "process P" / "subProcess S" */
  label: string;
  /** the container element's id (parent of its children in ModelGraph.extra) */
  id?: string;
  isSubProcess: boolean;
  triggeredByEvent: boolean;
  /** the SAME record objects as in BpmnModel.nodes — last-wins on duplicate ids */
  nodes: Map<string, BpmnModelNode>;
  flows: Array<{ id: string; from: string; to: string; name?: string }>;
}

export interface BpmnModel {
  /** walk push order: a container first, its children mid-iteration */
  containers: BpmnContainer[];
  /** flat, in extraction order */
  nodes: BpmnModelNode[];
  /** flat sequence flows, in extraction order (a child's flows can precede the parent's) */
  flows: Array<{ id: string; from: string; to: string; name?: string }>;
  /** flow-node + sequenceFlow + DI-artifact ids, inserted inline during the
   *  walk; the validator appends participants and messageFlow ids per
   *  collaboration (their DI requirement is a check-side concern) */
  diRequired: Set<string>;
  /** raw optionals — extractBpmn projects identity, the validator filters truthy */
  lanes: Array<{ id?: string; name?: string; nodeIds: string[]; processIndex: number }>;
  /** grouped per <collaboration> — the validator's per-collab pass order is wire-visible */
  collaborations: Array<{
    pools: Array<{ id?: string; name?: string; processRef?: string }>;
    messageFlows: Array<{ id?: string; from?: string; to?: string; name?: string }>;
  }>;
}

/** parse-tree in (parseXml(raw).definitions), the shared model out */
export function readBpmn(defs: Record<string, any>): BpmnModel {
  const model: BpmnModel = {
    containers: [],
    nodes: [],
    flows: [],
    diRequired: new Set(),
    lanes: [],
    collaborations: [],
  };

  const walk = (el: Record<string, unknown>, label: string, id: string | undefined, isSubProcess: boolean): void => {
    const container: BpmnContainer = {
      label,
      id,
      isSubProcess,
      triggeredByEvent: String((el as Record<string, string>)["@_triggeredByEvent"]) === "true",
      nodes: new Map(),
      flows: [],
    };
    model.containers.push(container);
    for (const [tag, value] of Object.entries(el)) {
      if (tag.startsWith("@_")) continue;
      if (tag === "sequenceFlow") {
        for (const f of asArray(value as Record<string, string>[])) {
          const flow = {
            id: f["@_id"] ?? "",
            from: f["@_sourceRef"] ?? "",
            to: f["@_targetRef"] ?? "",
            name: f["@_name"],
          };
          container.flows.push(flow);
          model.flows.push(flow);
          if (f["@_id"]) model.diRequired.add(f["@_id"]);
        }
        continue;
      }
      if (BPMN_FLOW_NODE_TAGS.has(tag)) {
        for (const node of asArray(value as Record<string, unknown>[])) {
          const rec = node as Record<string, string>;
          const nodeId = rec["@_id"];
          if (!nodeId) continue;
          const decisionRef = tag === "businessRuleTask" ? decisionRefOf(node as Record<string, any>) : undefined;
          const entry: BpmnModelNode = {
            id: nodeId,
            tag,
            name: rec["@_name"],
            ...(rec["@_attachedToRef"] !== undefined ? { attachedTo: rec["@_attachedToRef"] } : {}),
            ...(rec["@_calledElement"] !== undefined ? { calledElement: rec["@_calledElement"] } : {}),
            ...(decisionRef ? { decisionRef } : {}),
            container,
          };
          model.nodes.push(entry);
          container.nodes.set(nodeId, entry);
          model.diRequired.add(nodeId);
          if (BPMN_SUB_CONTAINER_TAGS.has(tag)) {
            walk(node as Record<string, unknown>, `${tag} ${nodeId}`, nodeId, true);
          }
        }
        continue;
      }
      if (BPMN_DI_ARTIFACT_TAGS.has(tag)) {
        for (const node of asArray(value as Record<string, string>[])) {
          if (node["@_id"]) model.diRequired.add(node["@_id"]);
        }
      }
    }
  };

  let processIndex = 0;
  for (const proc of asArray(defs.process as Record<string, unknown>[])) {
    const rec = proc as Record<string, any>;
    const pid = rec["@_id"] as string | undefined;
    walk(proc as Record<string, unknown>, `process ${pid ?? "(anonymous)"}`, pid, false);
    for (const lane of asArray(rec.laneSet?.lane)) {
      model.lanes.push({
        id: lane["@_id"],
        name: lane["@_name"],
        nodeIds: asArray(lane.flowNodeRef as string[]).map(String),
        processIndex,
      });
    }
    processIndex++;
  }
  for (const collab of asArray(defs.collaboration as Record<string, unknown>[])) {
    const rec = collab as Record<string, any>;
    model.collaborations.push({
      pools: asArray(rec.participant as Record<string, string>[]).map((pl) => ({
        id: pl["@_id"],
        name: pl["@_name"],
        processRef: pl["@_processRef"],
      })),
      messageFlows: asArray(rec.messageFlow as Record<string, string>[]).map((mf) => ({
        id: mf["@_id"],
        from: mf["@_sourceRef"],
        to: mf["@_targetRef"],
        name: mf["@_name"],
      })),
    });
  }
  return model;
}

function extractBpmn(raw: string): ModelGraph {
  const model = readBpmn(parseXml(raw).definitions ?? {});
  const nodes: ModelNode[] = model.nodes.map((n) => ({
    id: n.id,
    type: n.tag,
    name: n.name,
    extra: {
      ...(n.container.isSubProcess && n.container.id ? { parent: n.container.id } : {}),
      ...(n.calledElement ? { calledElement: n.calledElement } : {}),
      ...(n.attachedTo ? { attachedTo: n.attachedTo } : {}),
      ...(n.decisionRef ? { decisionRef: n.decisionRef } : {}),
    },
  }));
  const edges: ModelEdge[] = model.flows.map((f) => ({
    id: f.id,
    from: f.from,
    to: f.to,
    kind: "sequenceFlow",
    name: f.name,
  }));
  for (const collab of model.collaborations) {
    for (const mf of collab.messageFlows) {
      edges.push({ id: mf.id ?? "", from: mf.from ?? "", to: mf.to ?? "", kind: "messageFlow", name: mf.name });
    }
  }
  const lanes = model.lanes.map((l) => ({ id: l.id, name: l.name, nodeIds: l.nodeIds }));
  const pools = model.collaborations.flatMap((c) =>
    c.pools.map((pl) => ({ id: pl.id ?? "", name: pl.name ?? "", processRef: pl.processRef ?? "" })),
  );
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
 * The target of an informationRequirement — requiredInput/requiredDecision,
 * in that lookup order. THE spelling pair (it was byte-identical in the
 * validator, the decisionRefOf duplication class): `local` means same-file
 * ("#id"); a namespace-qualified href ("other.dmn#id") is NOT local — the
 * validator's dangling check skips it, and extractDmn currently passes it
 * through verbatim (known inconsistency vs analyze_decision, tracked in #86).
 */
export function requirementHref(req: Record<string, any>): { href: string; local: boolean } | undefined {
  const href: string | undefined = req.requiredInput?.["@_href"] ?? req.requiredDecision?.["@_href"];
  if (href === undefined) return undefined;
  return { href, local: href.startsWith("#") };
}

/**
 * DMN: decisions (with their full decision-table logic), input data and the
 * information requirements between them. The table detail rides in
 * node.extra — deriveDecision (derive.ts) turns it into the decision view,
 * and the simulator (@bpmiq/decisions) into its evaluation model, so this is
 * the ONE DMN parser on the server side.
 */
function extractDmn(raw: string): ModelGraph {
  const defs = parseXml(raw).definitions ?? {};
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
      const target = requirementHref(req);
      if (target && target.href) {
        edges.push({
          id: req["@_id"] ?? `req-${edges.length}`,
          from: target.href.replace(/^#/, ""),
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
  // an OWM DIRECTIVE line is never a dependency, even when it contains "->":
  // `evolution Genesis->Custom->Product` is syntax, and a map TITLE with an
  // arrow (platform-authorable via the create dialog, #139) is plain text
  const directive =
    /^(title|component|anchor|market|note|annotation|annotations|style|evolution|submap|url|pipeline)\b/;
  let i = 0;
  for (const m of raw.matchAll(/^([^\s>[\n][^>[\n]*?)\s*->\s*([^\n;]+)$/gm)) {
    if (directive.test(m[0] ?? "")) continue;
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
