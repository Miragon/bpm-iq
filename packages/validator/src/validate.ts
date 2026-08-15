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
 * Library use:  import { checkBpmnXml } from "@bpmiq/validator" — a PURE function
 * over a single BPMN XML string (no filesystem, no process.exit). The CLI lives
 * in src/cli.ts (a dedicated entry, so importing this module never runs it).
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { cliRoot, notContentRepoError } from "@bpmiq/notations/cli";
import { decisionRefOf } from "@bpmiq/notations/extract";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export type Severity = "ERROR" | "WARN";
export interface Finding {
  severity: Severity;
  /** the file/label the finding is about (checkBpmnXml uses opts.file, else "<bpmn>") */
  file: string;
  message: string;
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** collect DI element refs from every <keys> element anywhere under root —
 *  recursive, so drilldown planes of collapsed sub-processes are included; the
 *  descent is deliberately unconditional (it also enters matched shape records).
 *  One walk for BPMNDI and DMNDI (they differ only in key pair and attribute). */
function collectDiRefs(root: unknown, keys: readonly string[], attr: string): Set<string> {
  const di = new Set<string>();
  (function collect(v: unknown): void {
    if (Array.isArray(v)) {
      v.forEach(collect);
      return;
    }
    if (v === null || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (keys.includes(k)) {
        for (const s of asArray(child as Record<string, string> | Record<string, string>[])) {
          if (s[attr]) di.add(s[attr]);
        }
      }
      collect(child);
    }
  })(root);
  return di;
}

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
    /** businessRuleTask → the decision it delegates to, per engine spelling */
    decides: Array<{ id: string; ref: string }>;
    /** event sub-processes: intentionally NOT wired into the parent's flow */
    eventSubProcesses: Set<string>;
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
        if (tag === "businessRuleTask") {
          // no standard BPMN attribute for this — the spelling list is owned by
          // @bpmiq/notations/extract, so this check reads exactly the links the
          // platform follows (a private re-list drifted once: calledElement)
          const ref = decisionRefOf(node as Record<string, unknown>);
          if (ref) out.decides.push({ id, ref });
        }
        // an event sub-process is triggered by its own start event, never by a
        // sequence flow from the parent — exempt it from parent reachability
        if (SUB_CONTAINER_TAGS.has(tag) && String(rec["@_triggeredByEvent"]) === "true") out.eventSubProcesses.add(id);
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
function checkXmlNamespaces(raw: string, err: (message: string) => void): void {
  const declared = new Set([...raw.matchAll(/xmlns:([\w.-]+)=/g)].map((m) => m[1]));
  const used = new Set<string>();
  for (const m of raw.matchAll(/<([\w.-]+):[\w.-]+[\s/>]/g)) if (m[1]) used.add(m[1]);
  for (const m of raw.matchAll(/\s([\w.-]+):[\w.-]+="/g)) if (m[1]) used.add(m[1]);
  for (const prefix of used) {
    if (prefix !== "xml" && prefix !== "xmlns" && !declared.has(prefix)) {
      err(
        `namespace prefix '${prefix}:' is used but never declared (missing xmlns:${prefix}=...) — strict XML parsers reject this`,
      );
    }
  }
}

/**
 * Validate one .bpmn file's XML string (structure + BPMNDI coverage). Pure: no
 * filesystem, no process.exit. When `opts.processIds` is given, also warns on a
 * callActivity whose calledElement is not a process in the repo; `decisionIds`
 * does the same for a businessRuleTask and the repo's .dmn files. Returns the
 * findings and the ids the model references.
 */
export function checkBpmnXml(
  raw: string,
  opts: { file?: string; processIds?: Set<string>; decisionIds?: Set<string> } = {},
): {
  findings: Finding[];
  called: string[];
  decides: string[];
} {
  const file = opts.file ?? "<bpmn>";
  const findings: Finding[] = [];
  const err = (message: string): void => {
    findings.push({ severity: "ERROR", file, message });
  };
  const warn = (message: string): void => {
    findings.push({ severity: "WARN", file, message });
  };

  const wf = XMLValidator.validate(raw);
  if (wf !== true) {
    err(`not well-formed XML: ${wf.err.msg}`);
    return { findings, called: [], decides: [] };
  }
  checkXmlNamespaces(raw, err);

  const defs = xml.parse(raw).definitions;
  // collaborations have one <bpmn:process> per pool — always treat as a list
  const processes = asArray(defs?.process as Record<string, unknown>[]);
  if (processes.length === 0) {
    err("no <bpmn:process> element");
    return { findings, called: [], decides: [] };
  }

  const collected = {
    containers: [] as FlowContainer[],
    diRequired: new Set<string>(),
    boundaries: new Map<string, string>(),
    called: [] as string[],
    decides: [] as Array<{ id: string; ref: string }>,
    eventSubProcesses: new Set<string>(),
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
        if (!c.nodes.has(ref)) err(`sequenceFlow ${fid} references missing node '${ref}' (${c.label})`);
      }
      out.set(s, (out.get(s) ?? 0) + 1);
      inc.set(t, (inc.get(t) ?? 0) + 1);
    }
    if (c.nodes.size === 0) continue; // empty pool / collapsed reference — nothing to check
    const starts = [...c.nodes.values()].filter((tag) => tag === "startEvent").length;
    if (!c.isSubProcess && starts !== 1) err(`expected exactly one start event in ${c.label}, found ${starts}`);
    if (c.isSubProcess && !c.triggeredByEvent && starts > 1) err(`${c.label} has ${starts} start events`);
    for (const [id, tag] of c.nodes) {
      // an event sub-process attaches to its own trigger, not the parent flow —
      // it is legitimately unconnected to the parent's sequence flow
      if (collected.eventSubProcesses.has(id)) continue;
      if (tag === "startEvent" && (inc.get(id) ?? 0) > 0) err(`start event ${id} has incoming flows`);
      if (tag === "endEvent" && (out.get(id) ?? 0) > 0) err(`end event ${id} has outgoing flows`);
      if (tag !== "startEvent" && tag !== "boundaryEvent" && (inc.get(id) ?? 0) === 0)
        err(`${id} is unreachable (no incoming flow, ${c.label})`);
      if (tag !== "endEvent" && (out.get(id) ?? 0) === 0) err(`${id} is a dead end (no outgoing flow, ${c.label})`);
    }
  }
  for (const [b, attached] of collected.boundaries) {
    if (!nodes.has(attached)) err(`boundary event ${b} attached to missing '${attached}'`);
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
          err(`messageFlow ${mf["@_id"]} references missing element '${ref}'`);
        }
      }
    }
  }

  // DI coverage — collect bpmnElement refs from all BPMNShape/BPMNEdge anywhere
  // (drilldown planes of collapsed sub-processes included: the walk is recursive)
  const di = collectDiRefs(defs, ["BPMNShape", "BPMNEdge"], "@_bpmnElement");
  for (const id of collected.diRequired) {
    if (!di.has(id)) err(`${id} has no BPMNDI shape/edge (breaks the visual editor)`);
  }

  // lanes: if present, every top-level node must be assigned, and lanes render → need DI
  for (let i = 0; i < processes.length; i++) {
    const proc = processes[i] as Record<string, any>;
    const lanes = asArray(proc.laneSet?.lane);
    if (lanes.length === 0) continue;
    const laned = new Set<string>();
    for (const lane of lanes) {
      if (lane["@_id"] && !di.has(lane["@_id"]))
        err(`lane ${lane["@_id"]} has no BPMNDI shape (breaks the visual editor)`);
      for (const ref of asArray(lane.flowNodeRef as string[])) laned.add(String(ref));
    }
    const topContainer = topContainers[i];
    if (topContainer)
      for (const [id, tag] of topContainer.nodes) {
        // boundary events belong to their host activity's lane implicitly and
        // are routinely omitted from flowNodeRef by editors — don't flag them
        if (tag === "boundaryEvent") continue;
        if (!laned.has(id)) err(`${id} is not assigned to any lane`);
      }
  }

  const activities = [...nodes.values()].filter(
    (tag) => tag.toLowerCase().endsWith("task") || tag === "callActivity" || tag === "subProcess",
  ).length;
  if (activities > 9) warn(`${activities} activities — consider extracting a sub-process (7±2 rule)`);

  // link integrity: a callActivity should reference a process that exists in the repo
  if (opts.processIds) {
    for (const ref of collected.called) {
      if (!opts.processIds.has(ref)) {
        warn(`callActivity calls '${ref}', which is not a process in this repo (external or dangling?)`);
      }
    }
  }
  // …and the same for a business rule task and the repo's decisions
  if (opts.decisionIds) {
    for (const { id, ref } of collected.decides) {
      if (!opts.decisionIds.has(ref)) {
        warn(`businessRuleTask ${id} decides '${ref}', which is not a decision in this repo (external or dangling?)`);
      }
    }
  }

  return { findings, called: collected.called, decides: collected.decides.map((d) => d.ref) };
}

/**
 * Validate one .dmn file's XML string — the MECHANICAL invariants, the same
 * class this module checks for BPMN: well-formed XML, declared namespaces, a
 * decision to speak of, rule rows that line up with the columns, complete
 * DMNDI (Hard Rule 2: no shape, no visual editor) and information
 * requirements that point at elements which exist.
 *
 * Deliberately NOT here: FEEL semantics, hit-policy reachability, dead wiring.
 * Those need the FEEL engine and live in @bpmiq/decisions (`analyze_decision`),
 * which would drag a browser-side dependency into this zero-dep CLI.
 */
export function checkDmnXml(raw: string, opts: { file?: string } = {}): { findings: Finding[] } {
  const file = opts.file ?? "<dmn>";
  const findings: Finding[] = [];
  const err = (message: string): void => {
    findings.push({ severity: "ERROR", file, message });
  };
  const warn = (message: string): void => {
    findings.push({ severity: "WARN", file, message });
  };

  const wf = XMLValidator.validate(raw);
  if (wf !== true) {
    err(`not well-formed XML: ${wf.err.msg}`);
    return { findings };
  }
  checkXmlNamespaces(raw, err);

  const defs = xml.parse(raw).definitions;
  const decisions = asArray(defs?.decision as Record<string, any>[]);
  const inputData = asArray(defs?.inputData as Record<string, any>[]);
  if (decisions.length === 0) {
    err("no <decision> element");
    return { findings };
  }

  // every id an information requirement may point at
  const known = new Set<string>();
  for (const el of [...decisions, ...inputData]) if (el["@_id"]) known.add(String(el["@_id"]));

  const diRequired = new Set<string>();
  for (const decision of decisions) {
    const id = decision["@_id"] ? String(decision["@_id"]) : "(anonymous)";
    if (!decision["@_id"]) err("a <decision> has no id");
    else diRequired.add(id);

    const table = decision.decisionTable;
    if (!table && !decision.literalExpression) {
      warn(`decision ${id} has neither a decisionTable nor a literalExpression — it cannot produce a result`);
    }
    if (table) {
      const inputs = asArray(table.input as Record<string, unknown>[]).length;
      const outputs = asArray(table.output as Record<string, unknown>[]).length;
      if (outputs === 0) err(`decision ${id} has no output column`);
      for (const rule of asArray(table.rule as Record<string, any>[])) {
        const ruleId = rule["@_id"] ? String(rule["@_id"]) : "(anonymous rule)";
        const given = asArray(rule.inputEntry as unknown[]).length;
        const produced = asArray(rule.outputEntry as unknown[]).length;
        if (given !== inputs) err(`rule ${ruleId} of decision ${id} has ${given} input entries, expected ${inputs}`);
        if (produced !== outputs) {
          err(`rule ${ruleId} of decision ${id} has ${produced} output entries, expected ${outputs}`);
        }
      }
    }

    for (const req of asArray(decision.informationRequirement as Record<string, any>[])) {
      const href: string | undefined = req.requiredInput?.["@_href"] ?? req.requiredDecision?.["@_href"];
      if (href === undefined) continue;
      const target = href.replace(/^#/, "");
      // an href into another file (namespace-qualified) is out of scope here
      if (href.startsWith("#") && !known.has(target)) {
        err(`decision ${id} requires '${target}', which does not exist in this file`);
      }
    }
  }
  for (const input of inputData) if (input["@_id"]) diRequired.add(String(input["@_id"]));

  // DMNDI coverage — collect dmnElementRef from every DMNShape/DMNEdge
  const di = collectDiRefs(defs, ["DMNShape", "DMNEdge"], "@_dmnElementRef");
  // a DMN with no DMNDI at all is a decision table authored outside a modeler —
  // legal and common, so report it ONCE instead of per element
  if (di.size === 0) {
    warn("no DMNDI section — the DRD opens empty in the visual editor");
  } else {
    for (const id of diRequired) {
      if (!di.has(id)) err(`${id} has no DMNDI shape (breaks the visual editor)`);
    }
  }

  return { findings };
}

// ── CLI (invoked by src/cli.ts — the dedicated bin entry) ───────────────────────

export async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  /** content root: the checkout being validated (defaults to the cwd) */
  const ROOT = cliRoot(argv);
  /** optional single-model filter (a .bpmn or .dmn file stem) */
  const only = argv[0];

  const rel = (p: string): string => (p.startsWith("/") ? relative(ROOT, p) : p);

  const { discoverDecisions, discoverProcesses, loadContentConfig } = await import("@bpmiq/notations/content");
  const cfg = loadContentConfig(ROOT);
  if (!cfg) {
    console.error(notContentRepoError(ROOT));
    console.error("\n1 error(s), 0 warning(s) — FAIL (0 model(s) checked)");
    process.exit(1);
  }

  const all = await discoverProcesses(ROOT, cfg);
  const allDecisions = await discoverDecisions(ROOT, cfg);
  const processes = only ? all.filter((p) => p.id === only) : all;
  const decisions = only ? allDecisions.filter((d) => d.id === only) : allDecisions;
  if (only && processes.length === 0 && decisions.length === 0) {
    const available = [...all.map((p) => p.id), ...allDecisions.map((d) => d.id)].join(", ") || "(none)";
    console.error(`[ERROR] unknown process/decision '${only}'. Available: ${available}`);
    process.exit(1);
  }

  const processIds = new Set(all.map((p) => p.id));
  const decisionIds = new Set(allDecisions.map((d) => d.id));
  const findings: Finding[] = [];
  for (const proc of processes) {
    const abs = resolve(ROOT, proc.path);
    const { findings: fs } = checkBpmnXml(readFileSync(abs, "utf8"), { file: rel(abs), processIds, decisionIds });
    findings.push(...fs);
  }
  for (const decision of decisions) {
    const abs = resolve(ROOT, decision.path);
    const { findings: fs } = checkDmnXml(readFileSync(abs, "utf8"), { file: rel(abs) });
    findings.push(...fs);
  }

  for (const f of findings.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`[${f.severity}] ${f.file}: ${f.message}`);
  }
  const errorCount = findings.filter((f) => f.severity === "ERROR").length;
  const warnCount = findings.length - errorCount;
  const verdict = errorCount === 0 ? "OK" : "FAIL";
  const checked = [
    `${processes.length} process(es)`,
    ...(decisions.length > 0 ? [`${decisions.length} decision(s)`] : []),
  ].join(", ");
  console.log(`\n${errorCount} error(s), ${warnCount} warning(s) — ${verdict} (${checked} checked)`);
  process.exit(errorCount === 0 ? 0 : 1);
}
