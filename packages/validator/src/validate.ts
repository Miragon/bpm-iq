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

import { byExtension, byId } from "@bpmiq/notations";
import { kindOf } from "@bpmiq/notations/bpmn-kinds";
import { cliRoot, notContentRepoError } from "@bpmiq/notations/cli";
import {
  asArray,
  extractModelGraph,
  parseXml,
  readBpmn,
  requirementHref,
  XMLValidator,
} from "@bpmiq/notations/extract";
import { hasRefs, type ModelRef, refsOf } from "@bpmiq/notations/refs";

export type Severity = "ERROR" | "WARN";
export interface Finding {
  severity: Severity;
  /** stable rule family id, e.g. "bpmn/flow", "dmn/di", "refs/dangling" —
   *  the hook for per-repo severity config (epic #118) */
  ruleId: string;
  /** the file/label the finding is about (checkBpmnXml uses opts.file, else "<bpmn>") */
  file: string;
  message: string;
}

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
  const err = (ruleId: string, message: string): void => {
    findings.push({ severity: "ERROR", ruleId, file, message });
  };
  const warn = (ruleId: string, message: string): void => {
    findings.push({ severity: "WARN", ruleId, file, message });
  };

  const wf = XMLValidator.validate(raw);
  if (wf !== true) {
    err("bpmn/xml", `not well-formed XML: ${wf.err.msg}`);
    return { findings, called: [], decides: [] };
  }
  checkXmlNamespaces(raw, (m) => err("bpmn/xml", m));

  // #117: bpmiq:sticky extension elements are DISCUSSION artifacts — never
  // process content (every checker below ignores extensionElements), but
  // residue worth SURFACING before a release: warn-only, never blocks.
  // The prefix is resolved from the namespace DECLARATION — a foreign tool
  // may have re-bound the bpmiq URI to another alias.
  const prefix = /xmlns:([A-Za-z_][\w.-]*)="https:\/\/bpmiq\.io\/schema\/1\.0\/bpmiq"/.exec(raw)?.[1] ?? "bpmiq";
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stickyCount = raw.match(new RegExp(`<${escaped}:sticky[\\s/>]`, "g"))?.length ?? 0;
  if (stickyCount > 0) {
    const questions = raw.match(new RegExp(`<${escaped}:sticky[^>]*\\bkind="question"`, "g"))?.length ?? 0;
    warn(
      "bpmn/workshop-residue",
      `open discussion: ${stickyCount} ${stickyCount === 1 ? "sticky remains" : "stickies remain"}` +
        (questions > 0 ? ` (${questions} open ${questions === 1 ? "question" : "questions"})` : ""),
    );
  }

  const defs = parseXml(raw).definitions;
  // collaborations have one <bpmn:process> per pool — always treat as a list
  const processes = asArray(defs?.process as Record<string, unknown>[]);
  if (processes.length === 0) {
    err("bpmn/structure", "no <bpmn:process> element");
    return { findings, called: [], decides: [] };
  }

  // the ONE walk (@bpmiq/notations/extract) — everything below is a pure
  // consumer of the shared model; the validator's byte-identical copy of the
  // traversal is gone
  const model = readBpmn(defs ?? {});
  const diRequired = model.diRequired;
  const topContainers = model.containers.filter((c) => !c.isSubProcess);
  const boundaries = new Map<string, string>();
  for (const n of model.nodes) if (n.tag === "boundaryEvent") boundaries.set(n.id, n.attachedTo ?? "");
  const called = model.nodes.filter((n) => n.tag === "callActivity" && n.calledElement).map((n) => n.calledElement!);
  const decides = model.nodes
    .filter((n) => n.tag === "businessRuleTask" && n.decisionRef)
    .map((n) => ({ id: n.id, ref: n.decisionRef! }));
  const eventSubProcesses = new Set(
    model.containers.filter((c) => c.isSubProcess && c.triggeredByEvent && c.id).map((c) => c.id!),
  );

  /** every flow node of every container (incl. embedded sub-processes) */
  const nodes = new Map<string, string>();
  for (const c of model.containers) for (const [id, n] of c.nodes) nodes.set(id, n.tag);

  // structural checks — per container: each pool / embedded sub-process is its own graph
  for (const c of model.containers) {
    // the model keeps flows as a walk-ordered array; the Map preserves the
    // historical last-wins on a duplicate (or missing) flow id
    const flowMap = new Map(c.flows.map((f) => [f.id, [f.from, f.to] as [string, string]]));
    const inc = new Map<string, number>();
    const out = new Map<string, number>();
    for (const [fid, [s, t]] of flowMap) {
      for (const ref of [s, t]) {
        if (!c.nodes.has(ref)) err("bpmn/flow", `sequenceFlow ${fid} references missing node '${ref}' (${c.label})`);
      }
      out.set(s, (out.get(s) ?? 0) + 1);
      inc.set(t, (inc.get(t) ?? 0) + 1);
    }
    if (c.nodes.size === 0) continue; // empty pool / collapsed reference — nothing to check
    const starts = [...c.nodes.values()].filter((n) => n.tag === "startEvent").length;
    if (!c.isSubProcess && starts !== 1)
      err("bpmn/flow", `expected exactly one start event in ${c.label}, found ${starts}`);
    if (c.isSubProcess && !c.triggeredByEvent && starts > 1) err("bpmn/flow", `${c.label} has ${starts} start events`);
    for (const [id, { tag }] of c.nodes) {
      // an event sub-process attaches to its own trigger, not the parent flow —
      // it is legitimately unconnected to the parent's sequence flow
      if (eventSubProcesses.has(id)) continue;
      if (tag === "startEvent" && (inc.get(id) ?? 0) > 0) err("bpmn/flow", `start event ${id} has incoming flows`);
      if (tag === "endEvent" && (out.get(id) ?? 0) > 0) err("bpmn/flow", `end event ${id} has outgoing flows`);
      if (tag !== "startEvent" && tag !== "boundaryEvent" && (inc.get(id) ?? 0) === 0)
        err("bpmn/flow", `${id} is unreachable (no incoming flow, ${c.label})`);
      if (tag !== "endEvent" && (out.get(id) ?? 0) === 0)
        err("bpmn/flow", `${id} is a dead end (no outgoing flow, ${c.label})`);
    }
  }
  for (const [b, attached] of boundaries) {
    if (!nodes.has(attached)) err("bpmn/flow", `boundary event ${b} attached to missing '${attached}'`);
  }

  // collaboration: participants need DI, message flows must connect real
  // elements. Participants and messageFlow ids join diRequired HERE, per
  // collaboration, in this order — the DI-error order is wire-visible
  const participantIds = new Set<string>();
  for (const collab of model.collaborations) {
    for (const pl of collab.pools) {
      if (pl.id) {
        participantIds.add(pl.id);
        diRequired.add(pl.id);
      }
    }
    for (const mf of collab.messageFlows) {
      if (mf.id) diRequired.add(mf.id);
      for (const ref of [mf.from, mf.to]) {
        if (ref && !nodes.has(ref) && !participantIds.has(ref)) {
          err("bpmn/flow", `messageFlow ${mf.id} references missing element '${ref}'`);
        }
      }
    }
  }

  // DI coverage — collect bpmnElement refs from all BPMNShape/BPMNEdge anywhere
  // (drilldown planes of collapsed sub-processes included: the walk is recursive)
  const di = collectDiRefs(defs, ["BPMNShape", "BPMNEdge"], "@_bpmnElement");
  for (const id of diRequired) {
    if (!di.has(id)) err("bpmn/di", `${id} has no BPMNDI shape/edge (breaks the visual editor)`);
  }

  // lanes: if present, every top-level node must be assigned, and lanes render → need DI
  for (let i = 0; i < processes.length; i++) {
    const lanes = model.lanes.filter((l) => l.processIndex === i);
    if (lanes.length === 0) continue;
    const laned = new Set<string>();
    for (const lane of lanes) {
      if (lane.id && !di.has(lane.id)) err("bpmn/di", `lane ${lane.id} has no BPMNDI shape (breaks the visual editor)`);
      for (const ref of lane.nodeIds) laned.add(ref);
    }
    const topContainer = topContainers[i];
    if (topContainer)
      for (const [id, { tag }] of topContainer.nodes) {
        // boundary events belong to their host activity's lane implicitly and
        // are routinely omitted from flowNodeRef by editors — don't flag them
        if (tag === "boundaryEvent") continue;
        if (!laned.has(id)) err("bpmn/lanes", `${id} is not assigned to any lane`);
      }
  }

  // the count runs over the id-deduped union of all containers' nodes — the
  // shared taxonomy makes adHocSubProcess/transaction count like deriveProcess
  // always did (the two classifiers had drifted; stats.steps said 10 while
  // this warning stayed silent)
  const activities = [...nodes.values()].filter((tag) => kindOf(tag) === "activity").length;
  if (activities > 9)
    warn("bpmn/complexity", `${activities} activities — consider extracting a sub-process (7±2 rule)`);

  // link integrity: a callActivity should reference a process that exists in the repo
  if (opts.processIds) {
    for (const ref of called) {
      if (!opts.processIds.has(ref)) {
        warn(
          "refs/dangling",
          `callActivity calls '${ref}', which is not a process in this repo (external or dangling?)`,
        );
      }
    }
  }
  // …and the same for a business rule task and the repo's decisions
  if (opts.decisionIds) {
    for (const { id, ref } of decides) {
      if (!opts.decisionIds.has(ref)) {
        warn(
          "refs/dangling",
          `businessRuleTask ${id} decides '${ref}', which is not a decision in this repo (external or dangling?)`,
        );
      }
    }
  }

  return { findings, called, decides: decides.map((d) => d.ref) };
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
  const err = (ruleId: string, message: string): void => {
    findings.push({ severity: "ERROR", ruleId, file, message });
  };
  const warn = (ruleId: string, message: string): void => {
    findings.push({ severity: "WARN", ruleId, file, message });
  };

  const wf = XMLValidator.validate(raw);
  if (wf !== true) {
    err("dmn/xml", `not well-formed XML: ${wf.err.msg}`);
    return { findings };
  }
  checkXmlNamespaces(raw, (m) => err("dmn/xml", m));

  const defs = parseXml(raw).definitions;
  const decisions = asArray(defs?.decision as Record<string, any>[]);
  const inputData = asArray(defs?.inputData as Record<string, any>[]);
  if (decisions.length === 0) {
    err("dmn/structure", "no <decision> element");
    return { findings };
  }

  // every id an information requirement may point at
  const known = new Set<string>();
  for (const el of [...decisions, ...inputData]) if (el["@_id"]) known.add(String(el["@_id"]));

  const diRequired = new Set<string>();
  for (const decision of decisions) {
    const id = decision["@_id"] ? String(decision["@_id"]) : "(anonymous)";
    if (!decision["@_id"]) err("dmn/structure", "a <decision> has no id");
    else diRequired.add(id);

    const table = decision.decisionTable;
    if (!table && !decision.literalExpression) {
      warn(
        "dmn/structure",
        `decision ${id} has neither a decisionTable nor a literalExpression — it cannot produce a result`,
      );
    }
    if (table) {
      const inputs = asArray(table.input as Record<string, unknown>[]).length;
      const outputs = asArray(table.output as Record<string, unknown>[]).length;
      if (outputs === 0) err("dmn/structure", `decision ${id} has no output column`);
      for (const rule of asArray(table.rule as Record<string, any>[])) {
        const ruleId = rule["@_id"] ? String(rule["@_id"]) : "(anonymous rule)";
        const given = asArray(rule.inputEntry as unknown[]).length;
        const produced = asArray(rule.outputEntry as unknown[]).length;
        if (given !== inputs)
          err("dmn/rules", `rule ${ruleId} of decision ${id} has ${given} input entries, expected ${inputs}`);
        if (produced !== outputs) {
          err("dmn/rules", `rule ${ruleId} of decision ${id} has ${produced} output entries, expected ${outputs}`);
        }
      }
    }

    for (const req of asArray(decision.informationRequirement as Record<string, any>[])) {
      const r = requirementHref(req);
      if (r === undefined) continue;
      const target = r.href.replace(/^#/, "");
      // an href into another file (namespace-qualified) is out of scope here
      if (r.local && !known.has(target)) {
        err("dmn/requirements", `decision ${id} requires '${target}', which does not exist in this file`);
      }
    }
  }
  for (const input of inputData) if (input["@_id"]) diRequired.add(String(input["@_id"]));

  // DMNDI coverage — collect dmnElementRef from every DMNShape/DMNEdge
  const di = collectDiRefs(defs, ["DMNShape", "DMNEdge"], "@_dmnElementRef");
  // a DMN with no DMNDI at all is a decision table authored outside a modeler —
  // legal and common, so report it ONCE instead of per element
  if (di.size === 0) {
    warn("dmn/di", "no DMNDI section — the DRD opens empty in the visual editor");
  } else {
    for (const id of diRequired) {
      if (!di.has(id)) err("dmn/di", `${id} has no DMNDI shape (breaks the visual editor)`);
    }
  }

  return { findings };
}

/**
 * Baseline parse gate for models WITHOUT a dedicated checker (any registered
 * notation that is not .bpmn/.dmn): a discovered model must at minimum parse
 * per its notation's mediaKind — a broken .tt/.vc.json used to pass
 * validation untouched. Pure: no filesystem, no process.exit. Deliberately
 * mechanical: notation-specific structure checks arrive with the per-notation
 * checkers (epic #118, step 3).
 */
export function checkModelBaseline(raw: string, opts: { file?: string; notation: string }): Finding[] {
  const file = opts.file ?? `<${opts.notation}>`;
  const findings: Finding[] = [];
  // a STRUCTURED notation's at-rest text is its codec's canonical format
  // (e.g. JSON lines), NOT a plain mediaKind document — the mediaKind parse
  // gate would false-positive on every valid file. Its codec's decode is
  // TOTAL by contract; real structure checks are the notation's own checker.
  // DARK today (no registered notation is structured, byId has no injection
  // point) — shipped now so #116's first board file does not trip the JSON
  // gate the moment its descriptor flips; recorded on the ticket.
  if (byId(opts.notation)?.docShape === "structured") return findings;
  const err = (message: string): void => {
    findings.push({ severity: "ERROR", ruleId: "baseline/parse", file, message });
  };
  switch (byId(opts.notation)?.mediaKind) {
    case "json":
      try {
        JSON.parse(raw);
      } catch (e) {
        err(`not parseable as JSON: ${(e as Error).message}`);
      }
      break;
    case "xml": {
      const wf = XMLValidator.validate(raw);
      if (wf !== true) err(`not well-formed XML: ${wf.err.msg}`);
      break;
    }
    case "dsl":
      // DSL extractors are lenient by design (unknown lines are ignored) —
      // the gate only catches a parser that throws outright
      try {
        extractModelGraph(opts.notation, raw);
      } catch (e) {
        err(`not parseable: ${(e as Error).message}`);
      }
      break;
  }
  return findings;
}

/** what checkModel knows about the surrounding repo */
export interface CheckContext {
  /** repo-relative path — selects the notation AND labels the findings */
  path: string;
  /** explicit notation id — for callers whose `path` is a free-form label
   *  rather than a real file path (e.g. the validate_bpmn tool) */
  notation?: string;
  /** repo-wide model ids per notation id (discoverModels) — enables the
   *  cross-model link warnings (callActivity → process, decisionRef →
   *  decision); absent = link checks are skipped */
  modelIds?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * THE one check dispatch: the platform check for whatever notation `ctx.path`
 * is — full checkers for BPMN/DMN, the mediaKind baseline for everything
 * else, plus the generic dangling-reference rule for ANY notation with a
 * refs emitter; `undefined` when the path matches no registered notation
 * (the file is not a model; nothing to check). Consumed by the CLI (runCli)
 * AND the Live Host's save gate (application/content.ts) so both always agree.
 */
export function checkModel(raw: string, ctx: CheckContext): Finding[] | undefined {
  const notation = ctx.notation ?? byExtension(ctx.path)?.id;
  if (!notation) return undefined;
  const base =
    notation === "bpmn"
      ? checkBpmnXml(raw, { file: ctx.path }).findings
      : notation === "dmn"
        ? checkDmnXml(raw, { file: ctx.path }).findings
        : checkModelBaseline(raw, { file: ctx.path, notation });
  return [...base, ...checkRefs(notation, raw, ctx)];
}

/**
 * The generic dangling-reference rule: every REQUIRED reference the model
 * emits (@bpmiq/notations/refs) must resolve against the repo-wide ids —
 * ONE rule for every notation, replacing the bespoke processIds/decisionIds
 * plumbing. Skipped without ctx.modelIds (single-file use has no repo view).
 */
function checkRefs(notation: string, raw: string, ctx: CheckContext): Finding[] {
  if (!ctx.modelIds || !hasRefs(notation)) return []; // no emitter → skip the extract entirely
  // mirror the xml checkers' early return: no refs verdict on a file whose
  // well-formedness already failed (the lenient parser would still see nodes)
  if (byId(notation)?.mediaKind === "xml" && XMLValidator.validate(raw) !== true) return [];
  let graph;
  try {
    graph = extractModelGraph(notation, raw);
  } catch {
    return []; // unparseable — the notation's own checker already errored
  }
  if (!graph) return [];
  const findings: Finding[] = [];
  for (const ref of refsOf(graph)) {
    if (ref.strength !== "required") continue;
    const resolved = ref.to.notation
      ? (ctx.modelIds.get(ref.to.notation)?.has(ref.to.id) ?? false)
      : [...ctx.modelIds.values()].some((ids) => ids.has(ref.to.id));
    if (resolved) continue;
    findings.push({ severity: "WARN", ruleId: "refs/dangling", file: ctx.path, message: danglingMessage(ref) });
  }
  return findings;
}

/** rel-specific wording, pinned to the historical link warnings — the texts
 *  are wire-visible (save results, CLI output) and must not drift */
function danglingMessage(ref: ModelRef): string {
  if (ref.rel === "calls") {
    return `callActivity calls '${ref.to.id}', which is not a process in this repo (external or dangling?)`;
  }
  if (ref.rel === "decides" && ref.fromElement) {
    return `businessRuleTask ${ref.fromElement} decides '${ref.to.id}', which is not a decision in this repo (external or dangling?)`;
  }
  const target = ref.to.notation ? `${ref.to.notation} '${ref.to.id}'` : `'${ref.to.id}'`;
  return `${ref.fromElement ?? "the model"} references ${target}, which does not resolve in this repo (${ref.rel})`;
}

// ── CLI (invoked by src/cli.ts — the dedicated bin entry) ───────────────────────

export async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  /** content root: the checkout being validated (defaults to the cwd) */
  const ROOT = cliRoot(argv);
  /** optional single-model filter (a model file stem) */
  const only = argv[0];

  const rel = (p: string): string => (p.startsWith("/") ? relative(ROOT, p) : p);

  const { discoverModels, loadContentConfig } = await import("@bpmiq/notations/content");
  const cfg = loadContentConfig(ROOT);
  if (!cfg) {
    console.error(notContentRepoError(ROOT));
    console.error("\n1 error(s), 0 warning(s) — FAIL (0 model(s) checked)");
    process.exit(1);
  }

  const models = await discoverModels(ROOT, cfg);
  const all = models.filter((m) => m.notation === "bpmn");
  const allDecisions = models.filter((m) => m.notation === "dmn");
  const allOthers = models.filter((m) => m.notation !== "bpmn" && m.notation !== "dmn");
  const processes = only ? all.filter((p) => p.id === only) : all;
  const decisions = only ? allDecisions.filter((d) => d.id === only) : allDecisions;
  const others = only ? allOthers.filter((m) => m.id === only) : allOthers;
  if (only && processes.length === 0 && decisions.length === 0 && others.length === 0) {
    const available = models.map((m) => m.id).join(", ") || "(none)";
    console.error(`[ERROR] unknown model '${only}'. Available: ${available}`);
    process.exit(1);
  }

  const modelIds = new Map<string, Set<string>>();
  for (const m of models) (modelIds.get(m.notation) ?? modelIds.set(m.notation, new Set()).get(m.notation)!).add(m.id);
  const findings: Finding[] = [];
  for (const model of [...processes, ...decisions, ...others]) {
    const abs = resolve(ROOT, model.path);
    findings.push(...(checkModel(readFileSync(abs, "utf8"), { path: rel(abs), modelIds }) ?? []));
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
    ...(others.length > 0 ? [`${others.length} other model(s)`] : []),
  ].join(", ");
  console.log(`\n${errorCount} error(s), ${warnCount} warning(s) — ${verdict} (${checked} checked)`);
  process.exit(errorCount === 0 ? 0 : 1);
}
