/**
 * DerivedDecision (@bpmiq/notations/derive) → the evaluation models of
 * @emaarco/dmn-js-simulation. The platform parses DMN exactly ONCE (the
 * notation registry's extractor); this module only re-shapes that view, so the
 * server and the dmn-js widget simulate against the same numbers.
 *
 * The one thing it adds is FREE VARIABLES. Most real decision tables are
 * written without modelling InputData nodes: the columns simply read
 * `kundentyp`, and nothing in the DRD declares it. Evaluation still needs a
 * value for it, so every variable a table reads but no InputData / upstream
 * decision binds becomes a SYNTHETIC input — which is also exactly the list a
 * test case has to fill in.
 *
 * Node-safe: only the framework-free half of the simulation package is used
 * here (its dmn-js/inferno integration is never touched at runtime).
 */
import type { DecisionView, DerivedDecision } from "@bpmiq/notations/derive";
import { evaluate } from "feelin";

import type { EngineDecisionModel, EngineDrdDecision, EngineDrdModel, RawValue } from "./engine.ts";

export type { RawValue };

/** id prefix of the InputData we synthesize for an unmodelled variable */
export const FREE_INPUT_PREFIX = "free:";

/** one value a simulation/test case must supply */
export interface DecisionVariable {
  /** the key a scenario supplies the value under */
  name: string;
  /** InputData id, or "free:<name>" for a synthesized one */
  id: string;
  typeRef: string;
  /** "inputData" = modelled in the DRD, "free" = only read by a table column */
  source: "inputData" | "free";
  /** ids of the decisions that read it */
  usedBy: string[];
}

/** a FEEL identifier we can treat as a plain variable read */
const SIMPLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables a FEEL expression reads, via the engine itself: evaluating
 * against an EMPTY context makes feelin report every unresolved name as a
 * NO_VARIABLE_FOUND warning. More faithful than a regex — it knows literals,
 * built-ins and keywords.
 *
 * Caveat: feelin evaluates lazily, so a branch that is never taken
 * (`if a then b else c` with `a` unset) hides its names. Simple column
 * expressions — the overwhelming majority — are exact.
 */
export function freeVariablesOf(expression: string): string[] {
  const text = expression.trim();
  if (text === "") return [];
  if (SIMPLE_NAME.test(text)) return [text];
  let warnings: Array<{ type?: string; message?: string }>;
  try {
    warnings = (evaluate(text, {}) as { warnings?: Array<{ type?: string; message?: string }> }).warnings ?? [];
  } catch {
    // a syntax error yields no variables — analyze.ts reports the syntax itself
    return [];
  }
  const names = new Set<string>();
  for (const w of warnings) {
    if (w.type !== "NO_VARIABLE_FOUND") continue;
    const name = /Variable '([^']+)' not found/.exec(w.message ?? "")?.[1];
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * Every value a caller must supply to evaluate this DMN: the modelled
 * InputData first (declaration order), then the free variables in the order
 * the tables read them.
 */
export function decisionVariables(view: DerivedDecision): DecisionVariable[] {
  const bound = new Map<string, DecisionVariable>();
  for (const input of view.inputData) {
    bound.set(input.variable, {
      name: input.variable,
      id: input.id,
      typeRef: input.typeRef,
      source: "inputData",
      usedBy: [],
    });
  }
  // a decision's own result is bound by evaluation, never supplied
  const produced = new Set(view.decisions.map((d) => d.variable));

  const out = [...bound.values()];
  const free = new Map<string, DecisionVariable>();
  for (const decision of view.decisions) {
    const reads = new Set<string>();
    for (const input of decision.inputs) for (const name of freeVariablesOf(input.expression)) reads.add(name);
    if (decision.kind === "literalExpression") {
      for (const name of freeVariablesOf(decision.expression ?? "")) reads.add(name);
    }
    for (const name of reads) {
      const known = bound.get(name);
      if (known) {
        if (!known.usedBy.includes(decision.id)) known.usedBy.push(decision.id);
        continue;
      }
      if (produced.has(name)) continue; // fed by an upstream decision
      const existing = free.get(name);
      if (existing) {
        if (!existing.usedBy.includes(decision.id)) existing.usedBy.push(decision.id);
        continue;
      }
      const column = decision.inputs.find((i) => i.expression.trim() === name);
      free.set(name, {
        name,
        id: `${FREE_INPUT_PREFIX}${name}`,
        typeRef: column?.typeRef ?? "string",
        source: "free",
        usedBy: [decision.id],
      });
    }
  }
  return [...out, ...free.values()];
}

/** the distinct FEEL string literals a column tests against — the value set a
 *  test case can pick from (and what the widget offers as a dropdown) */
function optionsOf(view: DecisionView, column: number): string[] {
  const declared = view.inputs[column]?.inputValues ?? [];
  const source = declared.length > 0 ? declared : view.rules.map((r) => r.when[column] ?? "");
  const options = new Set<string>();
  for (const entry of source) {
    const text = entry.trim();
    // only unambiguous single literals — a range or a test like `> 5` is not a value
    const literal = /^"([^"]*)"$/.exec(text);
    if (literal?.[1] !== undefined) options.add(literal[1]);
  }
  return [...options];
}

/** one decision table → the engine's evaluation model */
export function toDecisionModel(view: DecisionView): EngineDecisionModel {
  return {
    decisionId: view.id,
    decisionName: view.name ?? view.id,
    hitPolicy: view.hitPolicy ?? "UNIQUE",
    ...(view.aggregation ? { aggregation: view.aggregation } : {}),
    inputs: view.inputs.map((input, n) => ({
      id: input.id,
      label: input.label || input.expression,
      expression: input.expression,
      typeRef: input.typeRef,
      options: optionsOf(view, n),
    })),
    outputs: view.outputs.map((output) => ({
      id: output.id,
      // an unnamed single output still needs a result key
      name: output.name || output.label || "result",
      label: output.label || output.name,
      typeRef: output.typeRef,
      priorityValues: output.outputValues.map((v) => v.replace(/^"|"$/g, "")),
    })),
    rules: view.rules.map((rule) => ({
      id: rule.id,
      inputEntries: rule.when,
      outputEntries: rule.then,
    })),
  };
}

/**
 * The whole DMN → the engine's DRD model, with the free variables added as
 * synthetic InputData so tables written without a DRD evaluate like modelled
 * ones. Decision order/dependencies stay exactly as modelled.
 */
export function toDrdModel(view: DerivedDecision): EngineDrdModel {
  const variables = decisionVariables(view);
  const freeByDecision = new Map<string, string[]>();
  for (const variable of variables) {
    if (variable.source !== "free") continue;
    for (const decisionId of variable.usedBy) {
      freeByDecision.set(decisionId, [...(freeByDecision.get(decisionId) ?? []), variable.id]);
    }
  }
  const decisions: EngineDrdDecision[] = view.decisions.map((decision) => ({
    id: decision.id,
    name: decision.name ?? decision.id,
    variableName: decision.variable,
    requiredDecisionIds: decision.requires.decisions,
    requiredInputIds: [...decision.requires.inputData, ...(freeByDecision.get(decision.id) ?? [])],
    logic:
      decision.kind === "decisionTable"
        ? { kind: "decisionTable", model: toDecisionModel(decision) }
        : decision.kind === "literalExpression"
          ? { kind: "literalExpression", expression: decision.expression ?? "" }
          : { kind: "none" },
  }));
  return {
    inputData: variables.map((v) => ({
      id: v.id,
      name: v.name,
      label: view.inputData.find((i) => i.id === v.id)?.name ?? v.name,
      typeRef: v.typeRef,
    })),
    decisions,
  };
}
