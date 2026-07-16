#!/usr/bin/env node
/**
 * Deterministic validation of the BPM repository.
 *
 * Checks the mechanical invariants that make the repo trustworthy as a system of
 * record: schema conformance, cross-model link integrity, BPMN structure and DI
 * coverage, governance consistency, and export freshness. Judgment-based checks
 * (naming quality, cross-view consistency) live in the `process-review` skill,
 * which runs this script first.
 *
 * Usage:  node scripts/validate.ts                     # validate this repo
 *         node scripts/validate.ts <process>           # one process id
 *         node scripts/validate.ts --root <dir> [<id>] # validate ANOTHER checkout
 *         npm run validate
 *
 * --root makes this the PLATFORM validator (docs/multi-repo-architecture.md):
 * the target checkout is pure data — its layout is the contract, the canonical
 * schema always comes from THIS repo (schemas/), and no code from the target
 * is ever executed.
 *
 * Exit code 0 = no errors (warnings allowed), 1 = errors found.
 * Requires Node >= 23.6 (built-in TypeScript type stripping).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NOTATIONS } from "@bpmiq/notations";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse as parseYaml } from "yaml";

/**
 * platform root: where the validator + canonical schemas live.
 * This file runs from src/validate.ts (workspace, type stripping) AND from the
 * published dist/validate.js (tsdown bundle) — both sit exactly one level below
 * the package root, so `..` lands on the directory that contains schemas/ in
 * both cases (schemas/ ships in the npm package via `files`). Keep it that way.
 */
const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const rootArg = rootFlag >= 0 ? argv[rootFlag + 1] : undefined;
if (rootFlag >= 0 && !rootArg) {
  console.error("--root requires a directory argument");
  process.exit(2);
}
/** content root: the checkout being validated (defaults to the platform repo itself) */
const ROOT = rootArg ? resolve(rootArg) : PLATFORM_ROOT;
if (rootFlag >= 0) argv.splice(rootFlag, 2);
if (!existsSync(join(ROOT, "processes"))) {
  // a broken layout is a finding, not a stacktrace — the platform calls this
  // against arbitrary checkouts
  console.error(`[ERROR] ${ROOT}: no processes/ directory — not a BPM content repo (or wrong --root)`);
  console.error("\n1 error(s), 0 warning(s) — FAIL (0 process(es) checked)");
  process.exit(1);
}

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

// ── Landscape ────────────────────────────────────────────────────────────────

interface Landscape {
  teamIds: Set<string>;
  teamLabels: Set<string>;
  stepIds: Set<string>;
  components: Set<string>;
}

function loadLandscape(): Landscape {
  const teamIds = new Set<string>();
  const teamLabels = new Set<string>();
  const stepIds = new Set<string>();
  const components = new Set<string>();

  const ttPath = join(ROOT, "landscape/team-topology.tt");
  if (!existsSync(ttPath)) {
    err(ttPath, "missing — team links in process.yaml cannot be resolved");
  } else {
    try {
      const tt = JSON.parse(read(ttPath));
      for (const n of tt.nodes ?? []) {
        teamIds.add(n.id);
        teamLabels.add(n.label);
      }
    } catch (e) {
      err(ttPath, `cannot parse: ${e}`);
    }
  }

  const vcPath = join(ROOT, "landscape/value-chain.vc.json");
  if (!existsSync(vcPath)) {
    err(vcPath, "missing — value chain links in process.yaml cannot be resolved");
  } else {
    try {
      const vc = JSON.parse(read(vcPath));
      const allIds = new Set((vc.elements ?? []).map((el: { id: string }) => el.id));
      for (const el of vc.elements ?? []) if (el.elementType === "step") stepIds.add(el.id);
      for (const c of vc.connections ?? []) {
        for (const ref of [c.source, c.target]) {
          if (!allIds.has(ref)) err(vcPath, `connection ${c.id} references missing element '${ref}'`);
        }
      }
    } catch (e) {
      err(vcPath, `cannot parse: ${e}`);
    }
  }

  const owmPath = join(ROOT, "landscape/wardley-map.owm");
  if (!existsSync(owmPath)) {
    err(owmPath, "missing — wardley component links in process.yaml cannot be resolved");
  } else {
    try {
      for (const m of read(owmPath).matchAll(/^component\s+([^[]+?)\s*\[/gm)) if (m[1]) components.add(m[1]);
    } catch (e) {
      err(owmPath, `cannot read: ${e}`);
    }
  }

  const glPath = join(ROOT, "landscape/glossary.yaml");
  if (existsSync(glPath)) {
    try {
      const gl = parseYaml(read(glPath)) ?? {};
      const seen = new Map<string, string>();
      for (const entry of gl.terms ?? []) {
        if (!entry?.term || !entry?.definition) {
          err(glPath, `glossary entry missing term/definition: ${JSON.stringify(entry)}`);
          continue;
        }
        for (const word of [entry.term, ...(entry.synonyms ?? [])]) {
          const w = String(word).toLowerCase();
          const owner = seen.get(w);
          if (owner && owner !== entry.term)
            warn(glPath, `'${word}' appears under both '${owner}' and '${entry.term}'`);
          seen.set(w, entry.term);
        }
      }
    } catch (e) {
      err(glPath, `cannot parse: ${e}`);
    }
  } else {
    warn(glPath, "missing — the glossary is the shared language of models and skills");
  }

  return { teamIds, teamLabels, stepIds, components };
}

// ── BPMN ─────────────────────────────────────────────────────────────────────

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });

// Explicit BPMN flow-node whitelist (with namespace prefixes stripped). Everything
// else — textAnnotation, association, dataObject(Reference), group, … — is a legal
// artifact but NOT a flow node; treating it as one produced false "unreachable"/
// "dead end"/"no lane" errors that blocked releases of perfectly valid models.
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

interface BpmnModel {
  nodes: Map<string, string>;
  called: string[];
}

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

function checkBpmn(path: string, teamLabels: Set<string>): BpmnModel {
  const empty: BpmnModel = { nodes: new Map(), called: [] };
  const raw = read(path);
  const wf = XMLValidator.validate(raw);
  if (wf !== true) {
    err(path, `not well-formed XML: ${wf.err.msg}`);
    return empty;
  }
  checkXmlNamespaces(path, raw);

  const defs = xml.parse(raw).definitions;
  // collaborations have one <bpmn:process> per pool — always treat as a list
  const processes = asArray(defs?.process as Record<string, unknown>[]);
  if (processes.length === 0) {
    err(path, "no <bpmn:process> element");
    return empty;
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

  // lanes: names must be team labels, every top-level node assigned; lanes render, so they need DI
  for (let i = 0; i < processes.length; i++) {
    const proc = processes[i] as Record<string, any>;
    const lanes = asArray(proc.laneSet?.lane);
    if (lanes.length === 0) continue;
    const laned = new Set<string>();
    for (const lane of lanes) {
      if (!teamLabels.has(lane["@_name"]))
        warn(path, `lane '${lane["@_name"]}' is not a team label in landscape/team-topology.tt`);
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

  return { nodes, called: collected.called };
}

// ── Process ──────────────────────────────────────────────────────────────────

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
// CJS/ESM interop: at runtime the default import IS the plugin function; the
// package's types don't model that under NodeNext
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
// canonical schema is PLATFORM-owned — never trust the target checkout's copy
const schemaPath = join(PLATFORM_ROOT, "schemas/process.schema.json");
const schema = JSON.parse(read(schemaPath));
// the `models` block is GENERATED from the notation registry: every registered
// notation is declarable (models.<id>: <file>), bpmn stays the required primary
// model. Adding a notation must not require a schema edit.
schema.properties.models = {
  type: "object",
  required: ["bpmn"],
  additionalProperties: false,
  properties: Object.fromEntries(
    NOTATIONS.filter((n) => n.processModel).map((n) => [
      n.id,
      { type: "string", pattern: `(${n.extensions.map((e) => e.replaceAll(".", "\\.")).join("|")})$` },
    ]),
  ),
};
const validateSchema = ajv.compile(schema);

function validateProcess(pdir: string, land: Landscape, allProcessIds: Set<string>): void {
  const pyaml = join(pdir, "process.yaml");
  const dirName = pdir.split("/").pop() as string;
  if (!existsSync(pyaml)) {
    err(pdir, "missing process.yaml");
    return;
  }

  let meta: Record<string, any>;
  try {
    meta = parseYaml(read(pyaml));
  } catch (e) {
    err(pyaml, `cannot parse: ${e}`);
    return;
  }

  // unreplaced template placeholders (ignore comments)
  for (const line of read(pyaml).split("\n")) {
    const code = line.includes("#") ? line.slice(0, line.indexOf("#")) : line;
    if (/<[A-Za-z][^>]*>/.test(code)) {
      err(pyaml, "unreplaced <placeholder> values remain");
      break;
    }
  }

  if (!validateSchema(meta)) {
    for (const e of validateSchema.errors ?? []) {
      err(pyaml, `schema: ${e.instancePath || "(root)"}: ${e.message}`);
    }
  }
  if (meta === null || typeof meta !== "object") return;

  if (meta.id !== dirName) err(pyaml, `id '${meta.id}' != directory name '${dirName}'`);

  // classification rules
  if (meta.classification === "core" && !meta.value_chain?.steps?.length)
    err(pyaml, "classification: core requires value_chain.steps");
  if (meta.classification === "support" && !meta.supports?.length)
    err(pyaml, "classification: support requires supports[]");

  // landscape links
  const teams = [meta.owner?.team, ...(meta.participants ?? []).map((p: { team: string }) => p.team)];
  for (const t of teams)
    if (t && !land.teamIds.has(t)) err(pyaml, `team '${t}' not found in landscape/team-topology.tt`);
  for (const s of meta.value_chain?.steps ?? [])
    if (!land.stepIds.has(s)) err(pyaml, `value chain step '${s}' not found in landscape/value-chain.vc.json`);
  for (const s of meta.supports ?? []) {
    if (!land.stepIds.has(s) && !allProcessIds.has(s))
      err(pyaml, `supports '${s}' is neither a value chain step nor a process id`);
  }
  for (const c of meta.wardley?.components ?? []) {
    if (!land.components.has(c))
      err(pyaml, `wardley component '${c}' not found in landscape/wardley-map.owm (exact match required)`);
  }

  // file paths — every declared model of every notation must exist
  const paths: string[] = [
    ...Object.values((meta.models ?? {}) as Record<string, string>),
    ...(meta.subprocesses ?? []).map((sp: { file: string }) => sp.file),
    ...(meta.decisions ?? []).map((d: { file: string }) => d.file),
    ...(meta.docs ?? []),
    ...(meta.automation?.model ? [meta.automation.model] : []),
  ].filter(Boolean);
  for (const p of paths) if (!existsSync(join(pdir, p))) err(pyaml, `referenced file '${p}' does not exist`);

  // related processes (soft)
  for (const rp of meta.related_processes ?? []) {
    if (!allProcessIds.has(rp.id)) warn(pyaml, `related process '${rp.id}' is not modeled (allowed, but note it)`);
  }

  // governance
  if (meta.status === "as-is") {
    if (!meta.approval) err(pyaml, "status: as-is requires an approval block (docs/governance.md)");
    else if (meta.approval.version !== meta.version)
      err(pyaml, `approval.version '${meta.approval.version}' != version '${meta.version}' — re-approve after changes`);
  }
  const hist: { version: string }[] = meta.history ?? [];
  if (hist.length > 0 && !hist.some((h) => h.version === meta.version))
    warn(pyaml, `version ${meta.version} has no history entry`);
  else if (hist.length === 0) warn(pyaml, "no history block — change tracking starts with one entry per version");

  // staleness
  const cycleMonths: number = meta.review_cycle_months ?? 12;
  const lastReviewed = Date.parse(String(meta.last_reviewed));
  if (Number.isNaN(lastReviewed)) {
    err(pyaml, `last_reviewed '${meta.last_reviewed}' is not a valid date`);
  } else if (Date.now() - lastReviewed > cycleMonths * 31 * 24 * 60 * 60 * 1000) {
    warn(pyaml, `last_reviewed ${meta.last_reviewed} exceeds the review cycle of ${cycleMonths} months`);
  }

  // BPMN models + element-id references
  const allNodes = new Map<string, string>();
  const called: string[] = [];
  const subIds = new Set<string>((meta.subprocesses ?? []).map((sp: { id: string }) => sp.id));
  const modelFiles = [meta.models?.bpmn, ...(meta.subprocesses ?? []).map((sp: { file: string }) => sp.file)].filter(
    Boolean,
  );
  for (const mf of modelFiles) {
    const mp = join(pdir, mf);
    if (!existsSync(mp)) continue;
    const model = checkBpmn(mp, land.teamLabels);
    for (const [id, tag] of model.nodes) allNodes.set(id, tag);
    called.push(...model.called);
  }
  for (const ce of called) {
    if (!subIds.has(ce) && !allProcessIds.has(ce))
      err(pyaml, `callActivity calledElement '${ce}' resolves to no subprocess or process id`);
  }

  const checkElement = (ref: string | undefined, context: string): void => {
    if (ref && !allNodes.has(ref))
      err(pyaml, `${context} references BPMN element '${ref}' which exists in no model of this process`);
  };
  for (const k of meta.kpis ?? []) {
    checkElement(k.measured_from, `kpi '${k.name}' measured_from`);
    checkElement(k.measured_to, `kpi '${k.name}' measured_to`);
  }
  for (const c of meta.controls ?? []) checkElement(c.element, `control '${c.name}'`);
  for (const d of meta.decisions ?? []) {
    checkElement(d.used_by, `decision '${d.id}' used_by`);
    const dp = join(pdir, d.file ?? "");
    if (existsSync(dp)) {
      const dmnRaw = read(dp);
      const wf = XMLValidator.validate(dmnRaw);
      if (wf !== true) err(dp, `not well-formed XML: ${wf.err.msg}`);
      else {
        checkXmlNamespaces(dp, dmnRaw);
        // the declared decision id must actually exist in the DMN file
        const dmnDefs = xml.parse(dmnRaw).definitions;
        const decisionIds = asArray(dmnDefs?.decision as Record<string, string>[])
          .map((el) => el["@_id"])
          .filter(Boolean);
        if (decisionIds.length === 0) {
          err(dp, "no <dmn:decision> element");
        } else if (d.id && !decisionIds.includes(d.id)) {
          err(pyaml, `decision '${d.id}' not found in ${d.file} (contains: ${decisionIds.join(", ")})`);
        }
      }
    }
  }
  for (const ev of meta.mining?.events ?? []) checkElement(ev.activity, "mining event mapping");
  for (const a of meta.mining?.no_digital_trace ?? []) checkElement(a, "mining no_digital_trace");

  // per-task work instructions must point at real elements
  const tasksDir = join(pdir, "docs/tasks");
  if (existsSync(tasksDir)) {
    for (const f of readdirSync(tasksDir).filter((f) => f.endsWith(".md"))) {
      checkElement(f.replace(/\.md$/, ""), `work instruction '${f}'`);
    }
  }

  // export freshness
  const dist = join(ROOT, "dist/skills", dirName);
  if (existsSync(dist)) {
    const ctx = join(dist, "resources/context.yaml");
    if (!existsSync(ctx)) {
      err(dist, "export exists but has no resources/context.yaml");
      return;
    }
    try {
      const exported = (parseYaml(read(ctx)) ?? {}).exported ?? {};
      if (!exported.source_version) {
        err(ctx, "export has no exported.source_version — freshness cannot be checked; re-run export-process-skill");
      } else if (String(exported.source_version) !== String(meta.version)) {
        err(
          ctx,
          `stale export: source_version ${exported.source_version} != process version ${meta.version} — re-run export-process-skill`,
        );
      }
    } catch (e) {
      err(ctx, `cannot parse: ${e}`);
    }
  }
}

// ── Index & orphaned exports ────────────────────────────────────────────────

function validateIndex(processIds: string[]): void {
  const index = join(ROOT, "processes/INDEX.md");
  if (!existsSync(index)) {
    warn(index, "missing — generate it so humans and agents get a portfolio overview");
    return;
  }
  const text = read(index);
  for (const id of processIds) {
    if (!new RegExp(`\\b${id}\\b`).test(text)) warn(index, `process '${id}' has no row — INDEX.md is out of sync`);
  }
  for (const m of text.matchAll(/^\|\s*\[?([a-z0-9]+(?:-[a-z0-9]+)+)\]?/gm)) {
    const dir = m[1] ?? "";
    if (!existsSync(join(ROOT, "processes", dir))) warn(index, `row '${dir}' has no matching process directory`);
  }
}

function validateOrphanExports(allProcessIds: Set<string>): void {
  const dist = join(ROOT, "dist/skills");
  if (!existsSync(dist)) return;
  for (const d of readdirSync(dist, { withFileTypes: true })) {
    if (d.isDirectory() && !allProcessIds.has(d.name)) {
      err(join(dist, d.name), `exported skill '${d.name}' has no source process — deprecated? remove or restore`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const only = argv[0];
const land = loadLandscape();
const processDirs = readdirSync(join(ROOT, "processes"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, "processes", d.name, "process.yaml")))
  .map((d) => join(ROOT, "processes", d.name))
  .sort();
const allProcessIds = new Set(processDirs.map((p) => p.split("/").pop() as string));

let checked = 0;
for (const pdir of processDirs) {
  if (only && !pdir.endsWith(`/${only}`)) continue;
  validateProcess(pdir, land, allProcessIds);
  checked++;
}
if (only && checked === 0) {
  // an unknown id must fail loudly — "OK (1 process(es) checked)" for a typo
  // silently green-lit releases of nothing
  err(
    join(ROOT, "processes", only),
    `unknown process id '${only}' (known: ${[...allProcessIds].join(", ") || "none"})`,
  );
}
if (!only) {
  validateIndex([...allProcessIds]);
  validateOrphanExports(allProcessIds);
}

const errors = findings.filter((f) => f.severity === "ERROR");
const warnings = findings.filter((f) => f.severity === "WARN");
for (const f of findings) console.log(`[${f.severity}] ${f.file}: ${f.message}`);
console.log(
  `\n${errors.length} error(s), ${warnings.length} warning(s) — ${errors.length ? "FAIL" : "OK"} (${checked} process(es) checked)`,
);
process.exit(errors.length ? 1 : 0);
