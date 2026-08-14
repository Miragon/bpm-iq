#!/usr/bin/env node
/**
 * The decision gate for a content repo: analyse every `.dmn` and run the test
 * cases next to it.
 *
 *   node packages/decisions/cli.ts --root <dir> [<decision-id>]
 *
 * The sibling of the platform validator (@bpmiq/validator, which checks the
 * MECHANICAL invariants of BPMN and DMN). This one adds what needs the FEEL
 * engine: expressions that do not parse, rules that can never decide anything,
 * chains that read a variable nobody produces — and the versioned test suites.
 *
 * Exit code 0 = no errors and no failing cases (warnings allowed), 1 = not.
 * The target checkout is pure data; no code from it is ever executed.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { discoverDecisions, loadContentConfig } from "@bpmiq/notations/content";
import { deriveDecision } from "@bpmiq/notations/derive";
import { extractModelGraph } from "@bpmiq/notations/extract";

import { analyzeDecision } from "./analyze.ts";
import { parseTestSuite, runDecisionTests, testsPathFor } from "./tests.ts";

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const rootArg = rootFlag >= 0 ? argv[rootFlag + 1] : undefined;
if (rootFlag >= 0 && !rootArg) {
  console.error("--root requires a directory argument");
  process.exit(2);
}
const ROOT = rootArg ? resolve(rootArg) : resolve(".");
if (rootFlag >= 0) argv.splice(rootFlag, 2);
/** optional single-decision filter (a .dmn file stem) */
const only = argv[0];

const cfg = loadContentConfig(ROOT);
if (!cfg) {
  console.error(`[ERROR] ${ROOT}: no bpmiq.yml at the root — not a BPM content repo (or wrong --root)`);
  process.exit(1);
}

const all = await discoverDecisions(ROOT, cfg);
const decisions = only ? all.filter((d) => d.id === only) : all;
if (only && decisions.length === 0) {
  console.error(`[ERROR] unknown decision '${only}'. Available: ${all.map((d) => d.id).join(", ") || "(none)"}`);
  process.exit(1);
}

let errors = 0;
let warnings = 0;
let failedCases = 0;
let cases = 0;

for (const decision of decisions) {
  const file = relative(ROOT, resolve(ROOT, decision.path));
  const graph = extractModelGraph(decision.path, readFileSync(resolve(ROOT, decision.path), "utf8"));
  if (!graph) {
    console.log(`[ERROR] ${file}: could not be parsed as DMN`);
    errors++;
    continue;
  }
  const view = deriveDecision(graph);

  for (const finding of analyzeDecision(view).findings) {
    const where = [finding.decision, finding.rule, finding.column].filter(Boolean).join("/");
    console.log(`[${finding.severity}] ${file}${where ? ` (${where})` : ""}: ${finding.message}`);
    if (finding.severity === "ERROR") errors++;
    else if (finding.severity === "WARN") warnings++;
  }

  const testsPath = testsPathFor(decision.path);
  if (!existsSync(resolve(ROOT, testsPath))) {
    console.log(`[WARN] ${file}: no test cases (${testsPath} does not exist)`);
    warnings++;
    continue;
  }
  let outcome;
  try {
    outcome = runDecisionTests(view, parseTestSuite(readFileSync(resolve(ROOT, testsPath), "utf8"), testsPath));
  } catch (e) {
    console.log(`[ERROR] ${testsPath}: ${(e as Error).message}`);
    errors++;
    continue;
  }
  cases += outcome.cases.length;
  for (const result of outcome.cases) {
    if (result.status === "fail") {
      failedCases++;
      console.log(`[FAIL] ${testsPath}: ${result.name} — ${result.failures.join("; ")}`);
    } else if (result.status === "pending") {
      warnings++;
      console.log(
        `[WARN] ${testsPath}: ${result.name} has no expectation — it produced ${JSON.stringify(result.actual.value)}`,
      );
    }
  }
  if (outcome.uncoveredRules.length > 0) {
    warnings++;
    console.log(`[WARN] ${file}: no case decides ${outcome.uncoveredRules.join(", ")}`);
  }
}

const verdict = errors === 0 && failedCases === 0 ? "OK" : "FAIL";
console.log(
  `\n${errors} error(s), ${warnings} warning(s), ${failedCases} failed case(s) — ${verdict} ` +
    `(${decisions.length} decision(s), ${cases} case(s) checked)`,
);
process.exit(verdict === "OK" ? 0 : 1);
