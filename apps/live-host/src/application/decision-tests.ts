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
import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

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
  const final = opt.record ? recordExpectations(suite, runDecisionTests(view, suite)) : suite;
  const yaml = serializeTestSuite(final);
  const outcome = runDecisionTests(view, final);

  const file = resolve(workspace, path);
  if (!existsSync(file)) {
    // first write: create it in the workspace tree (a live doc must exist on
    // disk before it can be opened), with the same symlink guard as scaffolding
    assertInsideWorkspace(file, workspace, path);
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

function assertInsideWorkspace(target: string, workspace: string, what: string): void {
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  const realWorkspace = realpathSync(workspace);
  if (real !== realWorkspace && !real.startsWith(realWorkspace + sep)) {
    throw new AppError("decision-tests/outside-workspace", `${what} escapes the workspace (symlink)`, {
      status: 400,
      expose: true,
    });
  }
}
