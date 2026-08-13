/**
 * Simulate a DMN: concrete input values in, matched rules and results out.
 *
 * Always evaluates the WHOLE DRD (in dependency order), because a decision
 * that feeds another is the interesting case; a single-table file is just the
 * degenerate one. Results are reported by RULE ID, never by row index — ids
 * survive re-ordering a table, indices don't, and a test case that pins
 * "Rule_stamm" still means something after an edit.
 *
 * The engine is @emaarco/dmn-js-simulation (feelin under the hood) — the same
 * one the dmn-js widget runs in the browser, so a scenario simulated by an
 * agent and one clicked by a human cannot drift apart.
 */
import type { DerivedDecision } from "@bpmiq/notations/derive";

import { evaluateDrd, type RawValue } from "./engine.ts";
import { decisionVariables, toDrdModel } from "./model.ts";

/** input values keyed by variable name (InputData name or a free variable) */
export type Scenario = Record<string, RawValue>;

export interface DecisionOutcome {
  id: string;
  name: string | null;
  /** the name downstream decisions see this result under */
  variable: string;
  /** the decision's value: scalar, list or object (null = no rule matched) */
  value: unknown;
  /** rule ids that matched, in table order */
  matchedRules: string[];
  /** the subset the hit policy actually reports (FIRST: one; COLLECT: all) */
  reportedRules: string[];
  /** the reported rules' outputs, one object per rule */
  outputs: Array<Record<string, unknown>>;
  /** COLLECT with an aggregator */
  aggregation?: { fn: string; output: string; value: unknown };
  /** hit-policy violation (e.g. two rules matched under UNIQUE) */
  violation?: string;
  /** what the table columns actually saw, keyed by column label */
  inputs?: Record<string, RawValue>;
  /** true when a dependency could not be resolved (cycle / missing upstream) */
  skipped?: boolean;
}

export interface SimulationResult {
  /** decision ids in evaluation (topological) order */
  order: string[];
  decisions: DecisionOutcome[];
  /** scenario keys that match no variable — the usual cause of "nothing matched" */
  unknownInputs: string[];
  /** variables the model reads but the scenario left unset */
  missingInputs: string[];
}

/**
 * Evaluate `scenario` against the decision view. Unknown/missing keys are
 * REPORTED, not rejected: a partially filled scenario is a legitimate probe
 * ("what happens if I only know the customer type?"), and a typo must be
 * visible rather than silently behave like an unmatched rule.
 */
export function simulateDecision(view: DerivedDecision, scenario: Scenario): SimulationResult {
  const variables = decisionVariables(view);
  const byName = new Map(variables.map((v) => [v.name, v]));

  const values: Record<string, RawValue> = {};
  const unknownInputs: string[] = [];
  for (const [key, value] of Object.entries(scenario)) {
    const variable = byName.get(key);
    if (!variable) {
      unknownInputs.push(key);
      continue;
    }
    values[variable.id] = value;
  }
  const missingInputs = variables.filter((v) => values[v.id] === undefined).map((v) => v.name);

  const result = evaluateDrd(toDrdModel(view), values);

  const decisions: DecisionOutcome[] = [];
  for (const id of result.order) {
    const evaluation = result.results[id];
    const source = view.decisions.find((d) => d.id === id);
    if (!evaluation || !source) continue;
    const ruleIds = source.rules.map((r) => r.id);
    const table = evaluation.table;
    decisions.push({
      id,
      name: source.name,
      variable: source.variable,
      value: evaluation.value ?? null,
      matchedRules: (table?.matchedRuleIndices ?? []).map((i) => ruleIds[i] ?? `#${i}`),
      reportedRules: (table?.reportedRuleIndices ?? []).map((i) => ruleIds[i] ?? `#${i}`),
      outputs: table?.outputs ?? [],
      ...(table?.aggregation ? { aggregation: table.aggregation } : {}),
      ...(table?.violation ? { violation: table.violation } : {}),
      ...(evaluation.inputs
        ? {
            inputs: Object.fromEntries(
              evaluation.inputs.map((value, n) => [
                source.inputs[n]?.label || source.inputs[n]?.expression || `#${n}`,
                value,
              ]),
            ),
          }
        : {}),
      ...(evaluation.skipped ? { skipped: true } : {}),
    });
  }

  return { order: [...result.order], decisions, unknownInputs, missingInputs };
}
