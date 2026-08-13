/**
 * Decision test cases: the versioned, reviewable artefact next to a `.dmn`.
 *
 *   processes/rabatt.dmn
 *   processes/rabatt.tests.yaml     ← this
 *
 * A sidecar file, NOT DMN extension elements: `.yaml` is already an editable
 * live document on the platform, it diffs and reviews like prose, it ships in
 * the same release PR as the model — and a dmn-js round-trip would silently
 * drop foreign extension elements it has no moddle descriptor for.
 *
 *   decision: rabatt              # optional, defaults to the file stem
 *   cases:
 *     - name: Stammkunde ab 500 EUR
 *       given: { kundentyp: stamm, bestellwert: 500 }
 *       expect:
 *         value: 10               # the decision's result
 *         rules: [Rule_stamm_gross]   # the rule(s) that MUST fire
 *     - name: Unbekannter Kundentyp
 *       given: { kundentyp: partner }
 *       expect: { value: null }
 *
 * A case with NO `expect` is legal and reported as `pending` together with the
 * value it actually produced — that is the golden-master path: record today's
 * behaviour, review it, then freeze it. Expectations that a human (or the
 * business) did not sign off on are worth little; recording what the model
 * does today is worth a lot, because it makes the NEXT change visible.
 *
 * `value` is compared against the decision's DMN result: a scalar for a single
 * output, an object for several, a list under COLLECT. `rules` is compared as
 * a SET against the rules the hit policy reported.
 */
import type { DerivedDecision } from "@bpmiq/notations/derive";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { RawValue } from "./engine.ts";
import { type Scenario, simulateDecision } from "./simulate.ts";

/** the sidecar's file suffix — `rabatt.dmn` → `rabatt.tests.yaml` */
export const TESTS_SUFFIX = ".tests.yaml";

/** the test file belonging to a .dmn path (same folder, same stem) */
export function testsPathFor(dmnPath: string): string {
  return dmnPath.replace(/\.dmn$/i, "") + TESTS_SUFFIX;
}

export interface CaseExpectation {
  /** the expected result of the suite's decision */
  value?: unknown;
  /** rule ids the hit policy must report, compared as a set */
  rules?: string[];
  /** per-decision expectations, for chained DRDs */
  decisions?: Record<string, { value?: unknown; rules?: string[] }>;
}

export interface TestCase {
  name: string;
  given: Scenario;
  /** absent = golden-master candidate: run it, report what it does */
  expect?: CaseExpectation;
}

export interface TestSuite {
  /** the decision the top-level expectations are about */
  decision?: string;
  cases: TestCase[];
}

export interface CaseOutcome {
  name: string;
  status: "pass" | "fail" | "pending";
  given: Scenario;
  /** what the model actually produced — always present, also on pass */
  actual: {
    value: unknown;
    rules: string[];
    decisions: Record<string, { value: unknown; rules: string[] }>;
  };
  /** one human-readable line per unmet expectation */
  failures: string[];
  /** scenario keys that match no variable of the model */
  unknownInputs: string[];
  /** variables the case left unset */
  missingInputs: string[];
}

export interface SuiteOutcome {
  /** the decision the suite is about */
  decision: string;
  cases: CaseOutcome[];
  passed: number;
  failed: number;
  pending: number;
  /**
   * Every rule of the model with the cases that touched it. `matchedBy` = the
   * rule's conditions held; `decidedBy` = the hit policy actually reported it.
   * The distinction matters: under FIRST a shadowed rule matches all day
   * without its result ever being observed.
   */
  coverage: Array<{ decision: string; rule: string; matchedBy: string[]; decidedBy: string[] }>;
  /** rules whose result no case ever observed — "<decision>/<rule>" */
  uncoveredRules: string[];
  /** true when nothing failed (pending cases do not fail a suite) */
  ok: boolean;
}

/** the decision top-level expectations refer to: the one nothing else needs
 *  (the leaf of the DRD), else the last one declared */
export function mainDecisionOf(view: DerivedDecision): string | undefined {
  const required = new Set(view.decisions.flatMap((d) => d.requires.decisions));
  const leaves = view.decisions.filter((d) => !required.has(d.id));
  return (leaves[leaves.length - 1] ?? view.decisions[view.decisions.length - 1])?.id;
}

/** Parse a sidecar. Throws with an actionable message — a malformed test file
 *  must never look like "0 cases, all green". */
export function parseTestSuite(raw: string, file = "<tests>"): TestSuite {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (e) {
    throw new Error(`${file}: not valid YAML — ${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) return { cases: [] };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${file}: expected a mapping with a 'cases' list`);
  }
  const record = doc as Record<string, unknown>;
  const rawCases = record.cases;
  if (rawCases !== undefined && !Array.isArray(rawCases)) {
    throw new Error(`${file}: 'cases' must be a list`);
  }
  const cases: TestCase[] = (rawCases ?? []).map((entry, n) => {
    const at = `${file}: case #${n + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${at} must be a mapping with 'name' and 'given'`);
    }
    const c = entry as Record<string, unknown>;
    const name = typeof c.name === "string" && c.name.trim() !== "" ? c.name.trim() : `case ${n + 1}`;
    if (c.given !== undefined && (typeof c.given !== "object" || c.given === null || Array.isArray(c.given))) {
      throw new Error(`${at} ('${name}'): 'given' must be a mapping of variable → value`);
    }
    const given = (c.given ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(given)) {
      const kind = typeof value;
      if (value !== null && kind !== "string" && kind !== "number" && kind !== "boolean") {
        throw new Error(`${at} ('${name}'): given.${key} must be a string, number, boolean or null`);
      }
    }
    if (c.expect !== undefined && (typeof c.expect !== "object" || c.expect === null || Array.isArray(c.expect))) {
      throw new Error(`${at} ('${name}'): 'expect' must be a mapping (omit it to record the current behaviour)`);
    }
    return {
      name,
      given: given as Scenario,
      ...(c.expect === undefined ? {} : { expect: c.expect as CaseExpectation }),
    };
  });
  const decision = typeof record.decision === "string" ? record.decision : undefined;
  return { ...(decision ? { decision } : {}), cases };
}

/** Render a suite back to YAML (stable key order, block style) */
export function serializeTestSuite(suite: TestSuite): string {
  const doc = {
    ...(suite.decision ? { decision: suite.decision } : {}),
    cases: suite.cases.map((c) => ({
      name: c.name,
      given: c.given,
      ...(c.expect ? { expect: c.expect } : {}),
    })),
  };
  return stringifyYaml(doc, { lineWidth: 0 });
}

/** DMN numbers are decimals; YAML gives us JS numbers. Compare structurally,
 *  with a tolerance that only forgives float representation (4.90 vs 4.9). */
function sameValue(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "number" && typeof actual === "number") {
    return Math.abs(expected - actual) < 1e-9;
  }
  if (expected === null || actual === null) return expected === actual;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((v, i) => sameValue(v, actual[i]));
  }
  if (typeof expected === "object" && typeof actual === "object") {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
    return [...keys].every((k) => sameValue(e[k], a[k]));
  }
  return expected === actual;
}

const show = (value: unknown): string => (typeof value === "string" ? `"${value}"` : (JSON.stringify(value) ?? "null"));

/** Run a suite against a decision view. Pure: no filesystem, no engine state. */
export function runDecisionTests(view: DerivedDecision, suite: TestSuite): SuiteOutcome {
  const main = suite.decision ?? mainDecisionOf(view) ?? "";
  const matched = new Map<string, string[]>(); // "<decision>/<rule>" → case names
  const decided = new Map<string, string[]>();

  const cases: CaseOutcome[] = suite.cases.map((testCase) => {
    const run = simulateDecision(view, testCase.given as Record<string, RawValue>);
    const byId = new Map(run.decisions.map((d) => [d.id, d]));
    for (const decision of run.decisions) {
      for (const [into, rules] of [
        [matched, decision.matchedRules],
        [decided, decision.reportedRules],
      ] as const) {
        for (const rule of rules) {
          const key = `${decision.id}/${rule}`;
          into.set(key, [...(into.get(key) ?? []), testCase.name]);
        }
      }
    }

    const actual = {
      value: byId.get(main)?.value ?? null,
      rules: byId.get(main)?.reportedRules ?? [],
      decisions: Object.fromEntries(run.decisions.map((d) => [d.id, { value: d.value, rules: d.reportedRules }])),
    };

    const failures: string[] = [];
    for (const key of run.unknownInputs) {
      failures.push(`'${key}' is not an input of this decision (check the spelling and the case)`);
    }
    const expectation = testCase.expect;
    if (expectation) {
      const check = (id: string, want: { value?: unknown; rules?: string[] }, label: string): void => {
        const got = byId.get(id);
        if (!got) {
          failures.push(`${label} did not evaluate (is '${id}' a decision in this file?)`);
          return;
        }
        if ("value" in want && !sameValue(want.value, got.value)) {
          failures.push(`${label}: expected ${show(want.value)}, got ${show(got.value)}`);
        }
        if (want.rules) {
          const expected = [...want.rules].sort();
          const fired = [...got.reportedRules].sort();
          if (expected.length !== fired.length || expected.some((r, i) => r !== fired[i])) {
            failures.push(
              `${label}: expected rule(s) ${expected.join(", ") || "(none)"}, got ${fired.join(", ") || "(none)"}`,
            );
          }
        }
      };
      if ("value" in expectation || expectation.rules) {
        check(main, expectation, `decision '${main}'`);
      }
      for (const [id, want] of Object.entries(expectation.decisions ?? {})) {
        check(id, want, `decision '${id}'`);
      }
    }

    return {
      name: testCase.name,
      status: failures.length > 0 ? "fail" : expectation ? "pass" : "pending",
      given: testCase.given,
      actual,
      failures,
      unknownInputs: run.unknownInputs,
      missingInputs: run.missingInputs,
    };
  });

  const coverage = view.decisions.flatMap((decision) =>
    decision.rules.map((rule) => ({
      decision: decision.id,
      rule: rule.id,
      matchedBy: matched.get(`${decision.id}/${rule.id}`) ?? [],
      decidedBy: decided.get(`${decision.id}/${rule.id}`) ?? [],
    })),
  );

  return {
    decision: main,
    cases,
    passed: cases.filter((c) => c.status === "pass").length,
    failed: cases.filter((c) => c.status === "fail").length,
    pending: cases.filter((c) => c.status === "pending").length,
    coverage,
    uncoveredRules: coverage.filter((c) => c.decidedBy.length === 0).map((c) => `${c.decision}/${c.rule}`),
    ok: cases.every((c) => c.status !== "fail"),
  };
}

/**
 * Fill every `pending` case with the value it actually produced — the
 * golden-master step. Returns a NEW suite; the caller decides whether to save
 * it (and a human still reviews the diff).
 */
export function recordExpectations(suite: TestSuite, outcome: SuiteOutcome): TestSuite {
  const byName = new Map(outcome.cases.map((c) => [c.name, c]));
  return {
    ...suite,
    cases: suite.cases.map((testCase) => {
      if (testCase.expect) return testCase;
      const result = byName.get(testCase.name);
      if (!result) return testCase;
      return {
        ...testCase,
        expect: { value: result.actual.value, rules: result.actual.rules },
      };
    }),
  };
}
