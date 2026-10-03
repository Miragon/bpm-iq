/**
 * The evaluation of an A/B run (bench/agent/run.ts): success rates with Wilson 95 % intervals, paired per-task
 * differences of tokens, cost and time (median with a bootstrap 95 % interval, Wilcoxon signed-rank p), collateral
 * changes, first-save validity, hard layout defects — per size — and the go/no-go gate of ADR 0008, fixed before the
 * run:
 *
 *   success overall      B >= A (B's interval not below A's point estimate)
 *   success on L models  B - A >= +20 pp
 *   tokens on M/L        median paired change <= -50 %
 *   collateral changes   median of B = 0 and mean(B) <= mean(A)
 *   hard layout defects  0 in B
 *
 *   node packages/bpmn-edit/bench/agent/report.ts <results.jsonl> [--md <out.md>]
 */
import { readFileSync, writeFileSync } from "node:fs";

interface Run {
  task: string;
  kind: "edit" | "scaffold";
  size: string;
  arm: "A" | "B";
  rep: number;
  success: boolean;
  validatorErrors: number;
  collateral: number;
  hardDefects: number;
  usage: { input: number; output: number; cacheWrite: number; cacheRead: number };
  costUsd: number;
  ms: number;
  turns: number;
  failedSaves: number;
  firstSaveValid?: boolean;
  xmlFallback?: boolean;
}

const tokens = (run: Run) => run.usage.input + run.usage.cacheWrite + run.usage.cacheRead + run.usage.output;

/** Wilson score interval, 95 % */
export function wilson(successes: number, n: number): [number, number, number] {
  if (n === 0) return [0, 0, 0];
  const z = 1.96;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [p, Math.max(0, centre - half), Math.min(1, centre + half)];
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** seeded PRNG, so a report is reproducible */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** bootstrap 95 % interval of the median */
export function bootstrap(values: readonly number[], rounds = 5000): [number, number] {
  if (values.length === 0) return [Number.NaN, Number.NaN];
  const next = random(42);
  const medians: number[] = [];
  for (let round = 0; round < rounds; round++) {
    medians.push(median(values.map(() => values[Math.floor(next() * values.length)]!)));
  }
  medians.sort((a, b) => a - b);
  return [medians[Math.floor(rounds * 0.025)]!, medians[Math.floor(rounds * 0.975)]!];
}

/** two-sided Wilcoxon signed-rank test, normal approximation with tie correction */
export function wilcoxon(differences: readonly number[]): number {
  const nonZero = differences.filter((d) => d !== 0);
  const n = nonZero.length;
  if (n < 6) return Number.NaN;
  const ranked = nonZero.map((d) => ({ d, abs: Math.abs(d) })).sort((a, b) => a.abs - b.abs);
  const ranks = new Array<number>(n);
  let ties = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && ranked[j + 1]!.abs === ranked[i]!.abs) j++;
    const rank = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    const t = j - i + 1;
    ties += t * t * t - t;
    i = j + 1;
  }
  const wPlus = ranked.reduce((sum, entry, index) => sum + (entry.d > 0 ? ranks[index]! : 0), 0);
  const mean = (n * (n + 1)) / 4;
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - ties / 48;
  const z = (wPlus - mean) / Math.sqrt(variance);
  // two-sided p from the standard normal (Abramowitz-Stegun 7.1.26)
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 1 - erf;
}

const pct = (value: number) => `${(value * 100).toFixed(0)} %`;
const num = (value: number, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : "–");

/** per task and repetition: B relative to A of the metric (B/A - 1) */
function pairedChanges(runs: readonly Run[], metric: (run: Run) => number): number[] {
  const changes: number[] = [];
  for (const a of runs.filter((run) => run.arm === "A")) {
    const b = runs.find((run) => run.arm === "B" && run.task === a.task && run.rep === a.rep);
    if (b && metric(a) > 0) changes.push(metric(b) / metric(a) - 1);
  }
  return changes;
}

export function report(runs: readonly Run[]): { lines: string[]; gate: boolean } {
  const lines = ["# ADR 0008 — A/B benchmark", ""];
  const arms = ["A", "B"] as const;
  lines.push(
    `${runs.length} runs, ${new Set(runs.map((run) => run.task)).size} tasks, ${Math.max(...runs.map((run) => run.rep))} repetitions.`,
    "",
  );
  const groups = ["all", "S", "M", "L", "-"];
  lines.push(
    "| size | arm | runs | success (95 % CI) | first save valid | validator errors | collateral (mean) | hard defects | tokens p50 | cost p50 $ | time p50 s | turns p50 | XML fallback |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const group of groups) {
    for (const arm of arms) {
      const g = runs.filter((run) => run.arm === arm && (group === "all" || run.size === group));
      if (g.length === 0) continue;
      const [p, low, high] = wilson(g.filter((run) => run.success).length, g.length);
      const saves = g.filter((run) => run.firstSaveValid !== undefined);
      lines.push(
        `| ${group === "-" ? "scaffold" : group} | ${arm} | ${g.length} | ${pct(p)} (${pct(low)}–${pct(high)}) | ${
          saves.length ? pct(saves.filter((run) => run.firstSaveValid).length / saves.length) : "–"
        } | ${g.reduce((t, r) => t + r.validatorErrors, 0)} | ${num(g.reduce((t, r) => t + r.collateral, 0) / g.length, 2)} | ${g.reduce(
          (t, r) => t + r.hardDefects,
          0,
        )} | ${num(median(g.map(tokens)))} | ${num(median(g.map((r) => r.costUsd)), 3)} | ${num(
          median(g.map((r) => r.ms / 1000)),
          1,
        )} | ${num(median(g.map((r) => r.turns)))} | ${arm === "B" ? pct(g.filter((r) => r.xmlFallback).length / g.length) : "–"} |`,
      );
    }
  }

  lines.push("", "## Paired change B vs. A (per task and repetition)", "");
  lines.push("| size | metric | median change | bootstrap 95 % CI | Wilcoxon p | pairs |", "|---|---|---|---|---|---|");
  const metrics: [string, (run: Run) => number][] = [
    ["tokens", tokens],
    ["cost", (run) => run.costUsd],
    ["time", (run) => run.ms],
    ["turns", (run) => run.turns],
  ];
  for (const group of groups) {
    const g = runs.filter((run) => group === "all" || run.size === group);
    for (const [name, metric] of metrics) {
      const changes = pairedChanges(g, metric);
      if (changes.length === 0) continue;
      const [low, high] = bootstrap(changes);
      lines.push(
        `| ${group === "-" ? "scaffold" : group} | ${name} | ${pct(median(changes))} | ${pct(low)} – ${pct(high)} | ${num(
          wilcoxon(changes),
          4,
        )} | ${changes.length} |`,
      );
    }
  }

  // ── gate ──
  const rate = (arm: "A" | "B", size?: string) => {
    const g = runs.filter((run) => run.arm === arm && (size === undefined || run.size === size));
    return wilson(g.filter((run) => run.success).length, g.length);
  };
  const [aAll] = rate("A");
  const [bAll, bAllLow, bAllHigh] = rate("B");
  const [aL] = rate("A", "L");
  const [bL] = rate("B", "L");
  const tokenChanges = pairedChanges(
    runs.filter((run) => run.size === "M" || run.size === "L"),
    tokens,
  );
  const bRuns = runs.filter((run) => run.arm === "B");
  const aRuns = runs.filter((run) => run.arm === "A");
  const mean = (g: readonly Run[], f: (run: Run) => number) => g.reduce((t, r) => t + f(r), 0) / Math.max(1, g.length);
  const checks: [string, boolean, string][] = [
    [
      "success overall: B not worse than A",
      bAllHigh >= aAll,
      `B ${pct(bAll)} (${pct(bAllLow)}–${pct(bAllHigh)}) vs. A ${pct(aAll)}`,
    ],
    ["success on L: B − A ≥ +20 pp", bL - aL >= 0.2, `B ${pct(bL)} vs. A ${pct(aL)}`],
    ["tokens on M/L: median change ≤ −50 %", median(tokenChanges) <= -0.5, `median ${pct(median(tokenChanges))}`],
    [
      "collateral: median B = 0 and mean B ≤ mean A",
      median(bRuns.map((r) => r.collateral)) === 0 &&
        mean(bRuns, (r) => r.collateral) <= mean(aRuns, (r) => r.collateral),
      `mean B ${num(
        mean(bRuns, (r) => r.collateral),
        2,
      )} vs. A ${num(
        mean(aRuns, (r) => r.collateral),
        2,
      )}`,
    ],
    [
      "hard layout defects in B = 0",
      bRuns.every((r) => r.hardDefects === 0),
      `${bRuns.reduce((t, r) => t + r.hardDefects, 0)}`,
    ],
  ];
  lines.push("", "## Gate (ADR 0008)", "", "| criterion | result | measured |", "|---|---|---|");
  for (const [name, ok, measured] of checks) lines.push(`| ${name} | ${ok ? "pass" : "FAIL"} | ${measured} |`);
  const gate = checks.every(([, ok]) => ok);
  lines.push("", `**Gate: ${gate ? "GO" : "NO-GO"}**`);
  return { lines, gate };
}

if (import.meta.main) {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error("usage: report.ts <results.jsonl> [--md <out.md>]");
    process.exit(2);
  }
  const runs = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Run);
  const { lines } = report(runs);
  console.log(lines.join("\n"));
  const md = process.argv.indexOf("--md");
  if (md !== -1 && process.argv[md + 1]) writeFileSync(process.argv[md + 1]!, `${lines.join("\n")}\n`);
}
