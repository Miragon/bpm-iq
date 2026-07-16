#!/usr/bin/env node
/**
 * Deterministic validation of a BPM content repository (the slim contract).
 *
 * A content repo is a root `bpmiq.yml` naming the folder its BPMN processes
 * live in (@bpmiq/notations/content); a process IS a `.bpmn` file there. This
 * checks the mechanical invariants that make each model trustworthy and
 * editable: well-formed XML, sound BPMN flow structure, and a COMPLETE BPMNDI
 * section (every flow node has a shape — Hard Rule 2, or the visual editor
 * breaks). It also cross-checks callActivity → calledElement against the other
 * processes in the repo. Nothing else about the layout is assumed.
 *
 * Usage:  node src/validate.ts                     # validate this repo
 *         node src/validate.ts <process>           # one process id (file stem)
 *         node src/validate.ts --root <dir> [<id>] # validate ANOTHER checkout
 *
 * --root makes this the PLATFORM validator: the target checkout is pure data —
 * no code from the target is ever executed.
 *
 * Exit code 0 = no errors (warnings allowed), 1 = errors found.
 * Requires Node >= 23.6 (built-in TypeScript type stripping).
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { discoverProcesses, loadContentConfig } from "@bpmiq/notations/content";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const rootArg = rootFlag >= 0 ? argv[rootFlag + 1] : undefined;
if (rootFlag >= 0 && !rootArg) {
  console.error("--root requires a directory argument");
  process.exit(2);
}
/** content root: the checkout being validated (defaults to the cwd) */
const ROOT = rootArg ? resolve(rootArg) : resolve(".");
if (rootFlag >= 0) argv.splice(rootFlag, 2);
/** optional single-process filter (a .bpmn file stem) */
const only = argv[0];

type Severity = "ERROR" | "WARN";
interface Finding {
  severity: Severity;
  file: string;
  message: string;
}
const findings: Finding[] = [];

const rel = (p: string): string => (p.startsWith("/") ? relative(ROOT, p) : p);
const err = (file: string, message: string): void => {
  findings.push({ severity: "ERROR", file: rel(file), message });
};
const warn = (file: string, message: string): void => {
  findings.push({ severity: "WARN", file: rel(file), message });
};

const read = (p: string): string => readFileSync(p, "utf8");
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });

// Explicit BPMN flow-node whitelist (with namespace prefixes stripped). Everything
// else — textAnnotation, association, dataObject(Reference), group, … — is a legal
// artifact but NOT a flow node; treating it as one produces false "unreachable"/
// "dead end" errors on perfectly valid models.
const FLOW_NODE_TAGS = new Set([
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
/** container tags whose children form their own flow graph */
const SUB_CONTAINER_TAGS = new Set(["subProcess", "adHocSubProcess", "transaction"]);
/** non-flow-node artifacts that still need a BPMNDI shape/edge to render */
const DI_ARTIFACT_TAGS = new Set([
  "textAnnotation",
  "association",
  "dataObjectReference",
  "dataStoreReference",
  "group",
]);

interface FlowContainer {
  /** container id for messages ("process Process_1", "subProcess Sub_1") */
  label: string;
  /** flow nodes directly in this container */
  nodes: Map<string, string>;
  /** sequence flows directly in this container: id -> [source, target] */
  flows: Map<string, [string, string]>;
  isSubProcess: boolean;
  triggeredByEvent: boolean;
}

/**
 * Recursively collect flow containers (process + embedded sub-processes),
 * artifacts needing DI, boundary attachments and callActivity targets.
 */
function collectContainers(
  el: Record<string, unknown>,
  label: string,
  isSubProcess: boolean,
  out: {
    containers: FlowContainer[];
    diRequired: Set<string>;
    boundaries: Map<string, string>;
    called: string[];
  },
): FlowContainer {
  const container: FlowContainer = {
    label,
    nodes: new Map(),
    flows: new Map(),
    isSubProcess,
    triggeredByEvent: String((el as Record<string, string>)["@_triggeredByEvent"]) === "true",
  };
  out.containers.push(container);

  for (const [tag, value] of Object.entries(el)) {
    if (tag.startsWith("@_")) continue;
    if (tag === "sequenceFlow") {
      for (const f of asArray(value as Record<string, string>[])) {
        container.flows.set(f["@_id"] ?? "", [f["@_sourceRef"] ?? "", f["@_targetRef"] ?? ""]);
        if (f["@_id"]) out.diRequired.add(f["@_id"]);
      }
      continue;
    }
    if (FLOW_NODE_TAGS.has(tag)) {
      for (const node of asArray(value as Record<string, unknown>[])) {
        const rec = node as Record<string, string>;
        const id = rec["@_id"];
        if (!id) continue;
        container.nodes.set(id, tag);
        out.diRequired.add(id);
        if (tag === "boundaryEvent") out.boundaries.set(id, rec["@_attachedToRef"] ?? "");
        if (tag === "callActivity" && rec["@_calledElement"]) out.called.push(rec["@_calledElement"]);
        if (SUB_CONTAINER_TAGS.has(tag)) {
          collectContainers(node as Record<string, unknown>, `${tag} ${id}`, true, out);
        }
      }
      continue;
    }
    if (DI_ARTIFACT_TAGS.has(tag)) {
      for (const node of asArray(value as Record<string, string>[])) {
        if (node["@_id"]) out.diRequired.add(node["@_id"]);
      }
    }
  }
  return container;
}

/** fast-xml-parser is not namespace-aware — check that every used prefix is declared. */
function checkXmlNamespaces(path: string, raw: string): void {
  const declared = new Set([...raw.matchAll(/xmlns:([\w.-]+)=/g)].map((m) => m[1]));
  const used = new Set<string>();
  for (const m of raw.matchAll(/<([\w.-]+):[\w.-]+[\s/>]/g)) if (m[1]) used.add(m[1]);
  for (const m of raw.matchAll(/\s([\w.-]+):[\w.-]+="/g)) if (m[1]) used.add(m[1]);
  for (const prefix of used) {
    if (prefix !== "xml" && prefix !== "xmlns" && !declared.has(prefix)) {
      err(
        path,
        `namespace prefix '${prefix}:' is used but never declared (missing xmlns:${prefix}=...) — strict XML parsers reject this`,
      );
    }
  }
}

/** Validate one .bpmn file's structure + DI; returns the calledElement ids it references. */
function checkBpmn(path: string): string[] {
  const raw = read(path);
  const wf = XMLValidator.validate(raw);
  if (wf !== true) {
    err(path, `not well-formed XML: ${wf.err.msg}`);
    return [];
  }
  checkXmlNamespaces(path, raw);

  const defs = xml.parse(raw).definitions;
  // collaborations have one <bpmn:process> per pool — always treat as a list
  const processes = asArray(defs?.process as Record<string, unknown>[]);
  if (processes.length === 0) {
    err(path, "no <bpmn:process> element");
    return [];
  }

  const collected = {
    containers: [] as FlowContainer[],
    diRequired: new Set<string>(),
    boundaries: new Map<string, string>(),
    called: [] as string[],
  };
  const topContainers: FlowContainer[] = [];
  for (const proc of processes) {
    const id = (proc as Record<string, string>)["@_id"] ?? "(anonymous)";
    topContainers.push(collectContainers(proc, `process ${id}`, false, collected));
  }

  /** every flow node of every container (incl. embedded sub-processes) */
  const nodes = new Map<string, string>();
  for (const c of collected.containers) for (const [id, tag] of c.nodes) nodes.set(id, tag);

  // structural checks — per container: each pool / embedded sub-process is its own graph
  for (const c of collected.containers) {
    const inc = new Map<string, number>();
    const out = new Map<string, number>();
    for (const [fid, [s, t]] of c.flows) {
      for (const ref of [s, t]) {
        if (!c.nodes.has(ref)) err(path, `sequenceFlow ${fid} references missing node '${ref}' (${c.label})`);
      }
      out.set(s, (out.get(s) ?? 0) + 1);
      inc.set(t, (inc.get(t) ?? 0) + 1);
    }
    if (c.nodes.size === 0) continue; // empty pool / collapsed reference — nothing to check
    const starts = [...c.nodes.values()].filter((tag) => tag === "startEvent").length;
    if (!c.isSubProcess && starts !== 1) err(path, `expected exactly one start event in ${c.label}, found ${starts}`);
    if (c.isSubProcess && !c.triggeredByEvent && starts > 1) err(path, `${c.label} has ${starts} start events`);
    for (const [id, tag] of c.nodes) {
      if (tag === "startEvent" && (inc.get(id) ?? 0) > 0) err(path, `start event ${id} has incoming flows`);
      if (tag === "endEvent" && (out.get(id) ?? 0) > 0) err(path, `end event ${id} has outgoing flows`);
      if (tag !== "startEvent" && tag !== "boundaryEvent" && (inc.get(id) ?? 0) === 0)
        err(path, `${id} is unreachable (no incoming flow, ${c.label})`);
      if (tag !== "endEvent" && (out.get(id) ?? 0) === 0)
        err(path, `${id} is a dead end (no outgoing flow, ${c.label})`);
    }
  }
  for (const [b, attached] of collected.boundaries) {
    if (!nodes.has(attached)) err(path, `boundary event ${b} attached to missing '${attached}'`);
  }

  // collaboration: participants need DI, message flows must connect real elements
  const participantIds = new Set<string>();
  for (const collab of asArray(defs?.collaboration as Record<string, unknown>[])) {
    for (const p of asArray(collab.participant as Record<string, string>[])) {
      if (p["@_id"]) {
        participantIds.add(p["@_id"]);
        collected.diRequired.add(p["@_id"]);
      }
    }
    for (const mf of asArray(collab.messageFlow as Record<string, string>[])) {
      if (mf["@_id"]) collected.diRequired.add(mf["@_id"]);
      for (const ref of [mf["@_sourceRef"], mf["@_targetRef"]]) {
        if (ref && !nodes.has(ref) && !participantIds.has(ref)) {
          err(path, `messageFlow ${mf["@_id"]} references missing element '${ref}'`);
        }
      }
    }
  }

  // DI coverage — collect bpmnElement refs from all BPMNShape/BPMNEdge anywhere
  // (drilldown planes of collapsed sub-processes included: the walk is recursive)
  const di = new Set<string>();
  (function collect(v: unknown): void {
    if (Array.isArray(v)) {
      v.forEach(collect);
      return;
    }
    if (v === null || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (k === "BPMNShape" || k === "BPMNEdge") {
        for (const s of asArray(child as Record<string, string> | Record<string, string>[]))
          if (s["@_bpmnElement"]) di.add(s["@_bpmnElement"]);
      }
      collect(child);
    }
  })(defs);
  for (const id of collected.diRequired) {
    if (!di.has(id)) err(path, `${id} has no BPMNDI shape/edge (breaks the visual editor)`);
  }

  // lanes: if present, every top-level node must be assigned, and lanes render → need DI
  for (let i = 0; i < processes.length; i++) {
    const proc = processes[i] as Record<string, any>;
    const lanes = asArray(proc.laneSet?.lane);
    if (lanes.length === 0) continue;
    const laned = new Set<string>();
    for (const lane of lanes) {
      if (lane["@_id"] && !di.has(lane["@_id"]))
        err(path, `lane ${lane["@_id"]} has no BPMNDI shape (breaks the visual editor)`);
      for (const ref of asArray(lane.flowNodeRef as string[])) laned.add(String(ref));
    }
    const topContainer = topContainers[i];
    if (topContainer)
      for (const id of topContainer.nodes.keys()) {
        if (!laned.has(id)) err(path, `${id} is not assigned to any lane`);
      }
  }

  const activities = [...nodes.values()].filter(
    (tag) => tag.toLowerCase().endsWith("task") || tag === "callActivity" || tag === "subProcess",
  ).length;
  if (activities > 9) warn(path, `${activities} activities — consider extracting a sub-process (7±2 rule)`);

  return collected.called;
}

// ── run ───────────────────────────────────────────────────────────────────────

const cfg = loadContentConfig(ROOT);
if (!cfg) {
  console.error(`[ERROR] ${ROOT}: no bpmiq.yml at the root — not a BPM content repo (or wrong --root)`);
  console.error("\n1 error(s), 0 warning(s) — FAIL (0 process(es) checked)");
  process.exit(1);
}

const all = await discoverProcesses(ROOT, cfg);
const processes = only ? all.filter((p) => p.id === only) : all;
if (only && processes.length === 0) {
  console.error(`[ERROR] unknown process '${only}'. Available: ${all.map((p) => p.id).join(", ") || "(none)"}`);
  process.exit(1);
}

const processIds = new Set(all.map((p) => p.id));
for (const proc of processes) {
  const called = checkBpmn(resolve(ROOT, proc.path));
  // link integrity: a callActivity should reference a process that exists in the repo
  for (const ref of called) {
    if (!processIds.has(ref)) {
      warn(proc.path, `callActivity calls '${ref}', which is not a process in this repo (external or dangling?)`);
    }
  }
}

for (const f of findings.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(`[${f.severity}] ${f.file}: ${f.message}`);
}
const errorCount = findings.filter((f) => f.severity === "ERROR").length;
const warnCount = findings.length - errorCount;
const verdict = errorCount === 0 ? "OK" : "FAIL";
console.log(`\n${errorCount} error(s), ${warnCount} warning(s) — ${verdict} (${processes.length} process(es) checked)`);
process.exit(errorCount === 0 ? 0 : 1);
