/**
 * The decision half of a release PR: what the shipped `.dmn` files actually
 * DECIDE differently now.
 *
 * A DMN diff is unreadable — reordered rules, renamed ids, a `>=` that became
 * a `>`. So instead of diffing XML, this runs the decision's own test cases
 * against BOTH versions (origin/<default> and the workspace) and reports the
 * cases whose outcome moved. That table is the review a business reader can
 * actually do, and it is derived from the same engine the modeler simulates
 * with, so it cannot flatter the change.
 *
 * Everything here degrades quietly: no previous version (a new decision), no
 * test cases, no `fileAtCommit` on the injected workspace manager → the
 * section shrinks or disappears. A release must never fail because its
 * commentary could not be produced.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { analyzeDecision } from "@bpmiq/decisions";
import { parseTestSuite, runDecisionTests, type SuiteOutcome, testsPathFor } from "@bpmiq/decisions/tests";
import { type DerivedDecision, deriveDecision } from "@bpmiq/notations/derive";
import { extractModelGraph } from "@bpmiq/notations/extract";

import type { ConnectedRepo } from "../repos/registry.ts";

export interface DecisionImpactDeps {
  workspaces: {
    /** content of ONE file at a commit; null when it does not exist there */
    fileAtCommit?: (repo: ConnectedRepo, path: string, sha: string) => Promise<string | null>;
  };
}

const view = (path: string, xml: string): DerivedDecision | undefined => {
  const graph = extractModelGraph(path, xml);
  return graph && graph.notation === "dmn" ? deriveDecision(graph) : undefined;
};

const show = (value: unknown): string =>
  value === null || value === undefined ? "_(no match)_" : `\`${JSON.stringify(value)}\``;

/**
 * A markdown section for the release PR body — empty string when the release
 * ships no decision (or nothing worth saying about one).
 *
 * `files` are repo-root-relative paths as staged; both the `.dmn` and its
 * `<stem>.tests.yaml` count as touching a decision.
 */
export async function decisionImpact(
  deps: DecisionImpactDeps,
  repo: ConnectedRepo,
  workspace: string,
  files: string[],
): Promise<string> {
  const decisions = new Set<string>();
  for (const file of files) {
    if (file.endsWith(".dmn")) decisions.add(file);
    // a suite changed on its own: report against the unchanged model
    else if (file.endsWith(".tests.yaml")) decisions.add(`${file.slice(0, -".tests.yaml".length)}.dmn`);
  }
  if (decisions.size === 0) return "";

  const sections: string[] = [];
  for (const path of [...decisions].sort()) {
    const section = await one(deps, repo, workspace, path).catch(() => undefined);
    if (section) sections.push(section);
  }
  return sections.length > 0 ? `\n\n## Decision impact\n\n${sections.join("\n\n")}` : "";
}

async function one(
  deps: DecisionImpactDeps,
  repo: ConnectedRepo,
  workspace: string,
  path: string,
): Promise<string | undefined> {
  const xml = await readFile(join(workspace, path), "utf8").catch(() => undefined);
  if (xml === undefined) return `**\`${path}\`** — deleted.`;
  const next = view(path, xml);
  if (!next) return undefined;

  const lines: string[] = [`**\`${path}\`**`];

  // the static findings of the NEW version — a released decision with broken
  // FEEL is worth a line in the PR, not a surprise in production
  const findings = analyzeDecision(next).findings.filter((f) => f.severity !== "INFO");
  for (const finding of findings.slice(0, 5)) {
    lines.push(`- ${finding.severity === "ERROR" ? "❌" : "⚠️"} ${finding.message}`);
  }
  if (findings.length > 5) lines.push(`- …and ${findings.length - 5} more finding(s)`);

  const suiteRaw = await readFile(join(workspace, testsPathFor(path)), "utf8").catch(() => undefined);
  if (suiteRaw === undefined) {
    lines.push(`- no test cases (\`${testsPathFor(path)}\`) — nothing pins this decision's behaviour`);
    return lines.join("\n");
  }
  const suite = parseTestSuite(suiteRaw, testsPathFor(path));
  const after = runDecisionTests(next, suite);
  lines.push(`- ${summary(after)}`);

  // …and the actual point: which cases decide differently than on the default branch
  const previousXml = await deps.workspaces
    .fileAtCommit?.(repo, path, `origin/${repo.defaultBranch}`)
    .catch(() => null);
  if (!previousXml) {
    lines.push("- new decision — no previous version to compare against");
    return lines.join("\n");
  }
  const previous = view(path, previousXml);
  if (!previous) return lines.join("\n");
  const before = runDecisionTests(previous, suite);
  const beforeByName = new Map(before.cases.map((c) => [c.name, c]));

  const changed = after.cases.filter((c) => {
    const was = beforeByName.get(c.name);
    return was && JSON.stringify(was.actual.value) !== JSON.stringify(c.actual.value);
  });
  if (changed.length === 0) {
    lines.push("- every existing case decides exactly as before");
    return lines.join("\n");
  }
  lines.push("", `${changed.length} case(s) decide differently than on \`${repo.defaultBranch}\`:`, "");
  lines.push("| Case | Before | After |", "| --- | --- | --- |");
  for (const c of changed.slice(0, 20)) {
    lines.push(`| ${c.name} | ${show(beforeByName.get(c.name)?.actual.value)} | ${show(c.actual.value)} |`);
  }
  if (changed.length > 20) lines.push(`| …and ${changed.length - 20} more | | |`);
  return lines.join("\n");
}

function summary(outcome: SuiteOutcome): string {
  const parts = [`${outcome.cases.length} test case(s): ${outcome.passed} pass`];
  if (outcome.failed > 0) parts.push(`**${outcome.failed} FAILING**`);
  if (outcome.pending > 0) parts.push(`${outcome.pending} without an expectation`);
  if (outcome.uncoveredRules.length > 0) parts.push(`${outcome.uncoveredRules.length} rule(s) never decide an outcome`);
  return parts.join(", ");
}
