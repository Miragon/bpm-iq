/**
 * The decision-test sidecar as a platform use-case: read it, run it, write it.
 *
 *   processes/rabatt.dmn
 *   processes/rabatt.tests.yaml   ← `<stem>.tests.yaml`, next to the model
 *
 * Reads and writes go through the SAME live-document path as the models
 * (content.ts): the sidecar is a `.yaml`, which the notation registry already
 * lists as an editable document — so it syncs, diffs, and ships in the release
 * PR alongside the `.dmn` it belongs to. Nothing here knows about git.
 *
 * The one thing that cannot go through putContent is the FIRST write: a live
 * document must exist on disk before it can be opened. A missing sidecar is
 * therefore created scaffold-style (a guarded direct write into the workspace
 * tree), after which every further save is a normal compare-and-set.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  parseTestSuite,
  recordExpectations,
  runDecisionTests,
  serializeTestSuite,
  type SuiteOutcome,
  testsPathFor,
  type TestSuite,
} from "@bpmiq/decisions/tests";
import { AppError } from "@bpmiq/http-kit";
import type { DerivedDecision } from "@bpmiq/notations/derive";

import type { ConnectedRepo } from "../repos/registry.ts";
import { baseVersionOf, type ContentDeps, getContent, putContent, type PutOutcome } from "./content.ts";
import { assertRealInsideWorkspace } from "./workspace-paths.ts";

export type DecisionTestsDeps = ContentDeps;

/** the sidecar's live content + its concurrency token, or undefined when the
 *  decision has no test file yet */
export async function readDecisionTests(
  opts: DecisionTestsDeps,
  repo: ConnectedRepo,
  dmnPath: string,
): Promise<{ path: string; raw: string; baseVersion: string } | undefined> {
  const path = testsPathFor(dmnPath);
  const workspace = await opts.workspaces.ensure(repo);
  // existence first: getContent would 404, and "no tests yet" is a normal state
  if (!existsSync(join(workspace, path))) return undefined;
  const content = await getContent(opts, repo, path);
  return { path, raw: content.xml, baseVersion: content.baseVersion };
}

export interface RunTestsResult extends SuiteOutcome {
  /** the sidecar the cases came from; null when they were passed inline */
  testsPath: string | null;
  baseVersion?: string;
}

/**
 * Run a decision's tests. `suite` overrides the sidecar (an agent trying cases
 * before committing to them); without it, a decision that has no sidecar comes
 * back as an empty, passing suite — "no tests" is not an error, it is a fact
 * the caller (and the coverage report) can act on.
 */
export async function runTestsFor(
  opts: DecisionTestsDeps,
  repo: ConnectedRepo,
  dmnPath: string,
  view: DerivedDecision,
  suite?: TestSuite,
): Promise<RunTestsResult> {
  if (suite) {
    return { ...runDecisionTests(view, suite), testsPath: null };
  }
  const stored = await readDecisionTests(opts, repo, dmnPath);
  if (!stored) {
    return { ...runDecisionTests(view, { cases: [] }), testsPath: null };
  }
  const parsed = parseTestSuite(stored.raw, stored.path);
  return { ...runDecisionTests(view, parsed), testsPath: stored.path, baseVersion: stored.baseVersion };
}

export interface SaveTestsResult {
  path: string;
  baseVersion: string;
  created: boolean;
  outcome: SuiteOutcome;
}

/**
 * Write the sidecar. `record: true` first runs the suite and freezes the
 * result of every case that carries no expectation (golden master) — the one
 * legitimate way for a machine to author expectations, because it states what
 * the model does today rather than what it should do.
 *
 * Returns a PutOutcome-style conflict instead of writing when `baseVersion` is
 * stale, exactly like the model saves.
 */
export async function saveTestsFor(
  opts: DecisionTestsDeps,
  repo: ConnectedRepo,
  dmnPath: string,
  view: DerivedDecision,
  suite: TestSuite,
  opt: { baseVersion?: string; record?: boolean } = {},
): Promise<SaveTestsResult | { conflict: NonNullable<Extract<PutOutcome, { ok: false }>["conflict"]> }> {
  const path = testsPathFor(dmnPath);
  const workspace = await opts.workspaces.ensure(repo);
  const file = resolve(workspace, path);
  const exists = existsSync(file);

  // Callers write CASES — neither the MCP tool nor the widget has a field for
  // the suite's own `decision:` key. Carry the stored one over, or a save
  // would silently retarget the top-level expectations to mainDecisionOf(),
  // which is a DIFFERENT decision in a chained DRD.
  const kept: TestSuite = suite.decision
    ? suite
    : { ...suite, ...(exists ? await storedDecision(opts, repo, dmnPath) : {}) };
  const final = opt.record ? recordExpectations(kept, runDecisionTests(view, kept)) : kept;
  const yaml = serializeTestSuite(final);
  const outcome = runDecisionTests(view, final);

  if (!exists) {
    // first write: create it in the workspace tree (a live doc must exist on
    // disk before it can be opened), through the shared scaffolding symlink guard
    assertRealInsideWorkspace(file, workspace, path, "decision-tests/outside-workspace");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, yaml, "utf8");
    // the token the caller needs for its NEXT save — the file is not open as a
    // live document yet, so it is simply the hash of what we just wrote
    return { path, baseVersion: baseVersionOf(yaml), created: true, outcome };
  }

  if (!opt.baseVersion) {
    throw new AppError(
      "decision-tests/base-version-required",
      `${path} already exists — read it first (get_decision_tests) and pass its baseVersion`,
      { status: 400, expose: true },
    );
  }
  const out = await putContent(opts, repo, path, { xml: yaml, baseVersion: opt.baseVersion });
  if (!out.ok) return { conflict: out.conflict };
  return { path, baseVersion: out.result.baseVersion, created: false, outcome };
}

/** the `decision:` key of the stored sidecar, or `{}` — a file that no longer
 *  parses has none to carry over, and the save replacing it is the fix */
async function storedDecision(
  opts: DecisionTestsDeps,
  repo: ConnectedRepo,
  dmnPath: string,
): Promise<{ decision?: string }> {
  try {
    const stored = await readDecisionTests(opts, repo, dmnPath);
    const decision = stored ? parseTestSuite(stored.raw, stored.path).decision : undefined;
    return decision ? { decision } : {};
  } catch {
    return {};
  }
}
