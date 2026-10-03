/**
 * Tool benchmark of ADR 0008 — what the tool itself does, deterministic and offline (the agent-level A/B lives in
 * bench/agent/). Per model: context size (XML vs outline vs neighbourhood window), roundtrip fidelity, runtime, the
 * layout metrics before/after `tidy` and `layout`, and a probe edit (insert a task) checked by the platform validator.
 *
 * Corpus: the example content repo, this package's fixtures, a seeded S/M/L set from bench/generate.ts, and every
 * directory in BPMN_BENCH_CORPUS (':'-separated) for local material that is not committed (customer models, the
 * bpmn-auto-layout examples).
 *
 *   node packages/bpmn-edit/bench/tool-bench.ts [--seeds 5] [--json <file>]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { checkBpmnXml } from "@bpmiq/validator";

import { layout } from "../src/layout/layout.ts";
import type { PlaneMetrics } from "../src/metrics/metrics.ts";
import { roundtrip } from "../src/model/document.ts";
import { applyOperations } from "../src/operations/apply.ts";
import { outline } from "../src/outline/outline.ts";
import { formatYaml } from "../src/outline/yaml.ts";
import { generateModel, type Size } from "./generate.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const AROUND_SAMPLE = 25;

interface Model {
  readonly group: string;
  readonly name: string;
  readonly xml: string;
}

/** the numbers that decide the hard limits and the score of a layout, summed over the planes */
const KEYS = [
  "shapeOverlaps",
  "edgeThroughShape",
  "outsideFrames",
  "edgeCrossings",
  "edgeOverlaps",
  "labelOverlaps",
  "shapeGapViolations",
  "backwardEdges",
  "wrongSideFlows",
  "endEventsOffColumn",
  "bends",
  "edgeLength",
] as const;
type Key = (typeof KEYS)[number];
type Sums = Record<Key, number>;

const sum = (planes: readonly PlaneMetrics[]): Sums =>
  Object.fromEntries(KEYS.map((key) => [key, planes.reduce((total, plane) => total + (plane[key] ?? 0), 0)])) as Sums;

const HARD: readonly Key[] = ["shapeOverlaps", "edgeThroughShape", "outsideFrames"];

interface Row {
  group: string;
  name: string;
  xmlBytes: number;
  outlineBytes: number;
  aroundMedian: number;
  aroundP90: number;
  roundtripIdentical: boolean;
  roundtripChangedLines: number;
  outlineMs: number;
  tidy: { ms: number; before: Sums; after: Sums };
  layout: { ms: number; before: Sums; after: Sums };
  edit?: { ms: number; errorsBefore: number; newErrors: string[]; changedLines: number; laneKept: boolean };
}

function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".bpmn"))
    .map((file) => join(directory, file));
}

async function corpus(seeds: number): Promise<Model[]> {
  const read = (group: string, directory: string): Model[] =>
    files(directory).map((file) => ({ group, name: relative(directory, file), xml: readFileSync(file, "utf8") }));
  const models = [
    ...read("example", join(ROOT, "process-documentation", "processes")),
    ...read("fixtures", join(import.meta.dirname, "..", "test", "fixtures")),
  ];
  for (const size of ["S", "M", "L"] as Size[]) {
    for (let seed = 1; seed <= seeds; seed++) {
      const { id, xml } = await generateModel(size, seed);
      models.push({ group: `generated-${size}`, name: id, xml });
    }
  }
  for (const directory of (process.env["BPMN_BENCH_CORPUS"] ?? "").split(":").filter(Boolean)) {
    models.push(...read(`local:${basename(directory)}`, directory));
  }
  return models;
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

function changedLines(before: string, after: string): number {
  const old = new Set(before.split("\n"));
  const now = new Set(after.split("\n"));
  return [...now].filter((line) => !old.has(line)).length + [...old].filter((line) => !now.has(line)).length;
}

const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0);
};

/** the probe edit: a user task after the first activity with one outgoing flow */
async function probeEdit(model: Model): Promise<Row["edit"]> {
  const { processes } = await outline(model.xml, { depth: 2, bounds: false, full: false }, model.name);
  for (const process of processes) {
    const anchor = process.elements.find(
      (element) =>
        /Task$|^task$|callActivity/.test(element.type) &&
        !element.parent &&
        process.flows.filter((flow) => flow.from === element.id).length === 1,
    );
    if (!anchor) continue;
    const id = "Task_bench_probe";
    const { value, ms } = await timed(() =>
      applyOperations(
        model.xml,
        [{ op: "insertAfter", after: anchor.id, element: { type: "task", id, name: "Probe step" } }],
        model.name,
      ),
    );
    const errors = (xml: string): string[] =>
      checkBpmnXml(xml, { file: model.name })
        .findings.filter((finding) => finding.severity === "ERROR")
        .map((finding) => finding.message);
    const before = new Set(errors(model.xml));
    const after = await outline(value.xml, { depth: 2, bounds: false, full: false }, model.name);
    const probe = after.processes.flatMap((p) => p.elements).find((element) => element.id === id);
    return {
      ms,
      errorsBefore: before.size,
      newErrors: errors(value.xml).filter((message) => !before.has(message)),
      changedLines: changedLines(model.xml, value.xml),
      laneKept: probe?.lane === anchor.lane,
    };
  }
  return undefined;
}

async function measureModel(model: Model): Promise<Row> {
  const { value: full, ms: outlineMs } = await timed(() =>
    outline(model.xml, { depth: 2, bounds: false, full: false }, model.name),
  );
  const ids = full.processes.flatMap((process) => process.elements.map((element) => element.id));
  const step = Math.max(1, Math.floor(ids.length / AROUND_SAMPLE));
  const around: number[] = [];
  for (const id of ids.filter((_, index) => index % step === 0).slice(0, AROUND_SAMPLE)) {
    const window = await outline(model.xml, { around: id, depth: 2, bounds: false, full: false }, model.name);
    around.push(formatYaml(window).join("\n").length);
  }
  const written = await roundtrip(model.xml, model.name);
  const tidy = await timed(() => layout(model.xml, { mode: "tidy", scope: { kind: "all" } }, model.name));
  const full2 = await timed(() => layout(model.xml, { mode: "layout", scope: { kind: "all" } }, model.name));
  return {
    group: model.group,
    name: model.name,
    xmlBytes: Buffer.byteLength(model.xml),
    outlineBytes: Buffer.byteLength(formatYaml(full).join("\n")),
    aroundMedian: quantile(around, 0.5),
    aroundP90: quantile(around, 0.9),
    roundtripIdentical: written === model.xml,
    roundtripChangedLines: changedLines(model.xml, written),
    outlineMs,
    tidy: { ms: tidy.ms, before: sum(tidy.value.before), after: sum(tidy.value.after) },
    layout: { ms: full2.ms, before: sum(full2.value.before), after: sum(full2.value.after) },
    edit: await probeEdit(model),
  };
}

function report(rows: readonly Row[]): string[] {
  const lines = ["# bpmn-edit tool benchmark", ""];
  const groups = [...new Set(rows.map((row) => row.group))];
  lines.push(
    "| group | files | XML KB | outline % of XML | around p50 / p90 bytes | roundtrip identical | tidy p50 / max ms | layout p50 / max ms | edit p50 ms | edit: new validator errors | edit: lane kept |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const group of groups) {
    const g = rows.filter((row) => row.group === group);
    const xml = g.reduce((t, r) => t + r.xmlBytes, 0);
    const out = g.reduce((t, r) => t + r.outlineBytes, 0);
    const edits = g.flatMap((row) => (row.edit ? [row.edit] : []));
    lines.push(
      `| ${group} | ${g.length} | ${(xml / 1024).toFixed(0)} | ${((out / xml) * 100).toFixed(0)} % | ${quantile(
        g.map((r) => r.aroundMedian),
        0.5,
      ).toFixed(0)} / ${quantile(
        g.map((r) => r.aroundP90),
        0.9,
      ).toFixed(0)} | ${g.filter((r) => r.roundtripIdentical).length}/${g.length} | ${quantile(
        g.map((r) => r.tidy.ms),
        0.5,
      ).toFixed(0)} / ${Math.max(...g.map((r) => r.tidy.ms)).toFixed(0)} | ${quantile(
        g.map((r) => r.layout.ms),
        0.5,
      ).toFixed(0)} / ${Math.max(...g.map((r) => r.layout.ms)).toFixed(0)} | ${quantile(
        edits.map((e) => e.ms),
        0.5,
      ).toFixed(0)} | ${edits.reduce((t, e) => t + e.newErrors.length, 0)} in ${edits.length} | ${
        edits.filter((e) => e.laneKept).length
      }/${edits.length} |`,
    );
  }
  lines.push("", "## Layout metrics (sums per group: before → tidy → layout)", "");
  lines.push(`| group | ${KEYS.join(" | ")} |`, `|---|${KEYS.map(() => "---").join("|")}|`);
  for (const group of groups) {
    const g = rows.filter((row) => row.group === group);
    const total = (pick: (row: Row) => Sums, key: Key) => g.reduce((t, r) => t + pick(r)[key], 0);
    lines.push(
      `| ${group} | ${KEYS.map(
        (key) =>
          `${total((r) => r.tidy.before, key)} → ${total((r) => r.tidy.after, key)} → ${total((r) => r.layout.after, key)}`,
      ).join(" | ")} |`,
    );
  }
  const hard = rows.filter((row) =>
    HARD.some((key) => row.layout.after[key] > 0 || row.tidy.after[key] > row.tidy.before[key]),
  );
  lines.push(
    "",
    `Hard defects introduced or left after layout: ${hard.length === 0 ? "none" : hard.map((r) => r.name).join(", ")}`,
  );
  return lines;
}

const args = process.argv.slice(2);
const seeds = Number(args[args.indexOf("--seeds") + 1] ?? 5) || 5;
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const rows: Row[] = [];
const failures: string[] = [];
for (const model of await corpus(seeds)) {
  try {
    rows.push(await measureModel(model));
  } catch (error) {
    failures.push(`${model.group}/${model.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(report(rows).join("\n"));
const broken = rows.filter((row) => (row.edit?.newErrors.length ?? 0) > 0);
console.log(
  `\nEdits with new validator errors (${broken.length}): ${
    broken.length === 0
      ? "none"
      : "\n- " + broken.map((r) => `${r.group}/${r.name}: ${r.edit?.newErrors.join("; ")}`).join("\n- ")
  }`,
);
console.log(
  `\nNot measurable (${failures.length}): ${failures.length === 0 ? "none" : "\n- " + failures.join("\n- ")}`,
);
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(rows, undefined, 2));
}
