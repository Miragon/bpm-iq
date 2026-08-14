/**
 * The ONE module that touches @emaarco/dmn-js-simulation — the FEEL/hit-policy
 * engine the dmn-js modeler add-on also runs in the browser. Everything else
 * in this package talks to the shapes declared here.
 *
 * Why the shapes are re-declared instead of imported: the package publishes a
 * single bundle whose .d.ts uses EXTENSIONLESS relative imports, which this
 * workspace's NodeNext resolution cannot follow — every exported type silently
 * degrades to `any`, which would leak straight through our own API. The shapes
 * below are DMN-spec shapes (inputs, outputs, rules, hit policy), not vendor
 * inventions, so re-declaring them costs nothing and buys a real type gate.
 * Verified against the package's own d.ts and its runtime behaviour in
 * test/simulate.test.ts.
 *
 * It also keeps the engine swappable at one seam: an upstream `/core`
 * subexport (which would also drop the inferno import the bundle pulls in) or
 * a fork changes this file and nothing else.
 */
import { evaluateDecisionRequirementsDiagram } from "@emaarco/dmn-js-simulation";

/** a value before the engine coerces it to its DMN type */
export type RawValue = string | number | boolean | null | undefined;

export type HitPolicy = "UNIQUE" | "FIRST" | "ANY" | "PRIORITY" | "COLLECT" | "RULE ORDER" | "OUTPUT ORDER";
export type Aggregation = "SUM" | "MIN" | "MAX" | "COUNT";

export interface EngineInput {
  id: string;
  label: string;
  /** the FEEL input expression = what the column reads */
  expression: string;
  typeRef: string;
  /** distinct literals the column tests against (drives the widget's dropdown) */
  options: string[];
}

export interface EngineOutput {
  id: string;
  /** result key */
  name: string;
  label: string;
  typeRef: string;
  /** allowed values, highest priority first (PRIORITY / OUTPUT ORDER) */
  priorityValues: string[];
}

export interface EngineRule {
  id: string;
  /** raw FEEL unary tests, aligned to the inputs */
  inputEntries: string[];
  /** raw FEEL expressions, aligned to the outputs */
  outputEntries: string[];
}

export interface EngineDecisionModel {
  decisionId: string;
  decisionName: string;
  hitPolicy: HitPolicy;
  aggregation?: Aggregation;
  inputs: EngineInput[];
  outputs: EngineOutput[];
  rules: EngineRule[];
}

export type EngineLogic =
  | { kind: "decisionTable"; model: EngineDecisionModel }
  | { kind: "literalExpression"; expression: string }
  | { kind: "none" };

export interface EngineDrdDecision {
  id: string;
  name: string;
  /** the name downstream decisions read the result under */
  variableName: string;
  requiredDecisionIds: string[];
  requiredInputIds: string[];
  logic: EngineLogic;
}

export interface EngineDrdModel {
  inputData: Array<{ id: string; name: string; label: string; typeRef: string }>;
  decisions: EngineDrdDecision[];
}

export interface EngineTableResult {
  /** every rule that matched, by ROW INDEX, in table order */
  matchedRuleIndices: number[];
  /** the subset the hit policy reports */
  reportedRuleIndices: number[];
  outputs: Array<Record<string, unknown>>;
  aggregation?: { fn: string; output: string; value: unknown };
  /** e.g. "UNIQUE hit policy violated: 2 rules matched" */
  violation?: string;
}

export interface EngineDecisionEvaluation {
  value: unknown;
  table?: EngineTableResult;
  /** the values the table's columns saw, in column order */
  inputs?: RawValue[];
  skipped?: boolean;
}

export interface EngineDrdResult {
  /** decision ids in evaluation (topological) order */
  order: string[];
  results: Record<string, EngineDecisionEvaluation>;
}

/** Evaluate a whole DRD. `values` is keyed by InputData ID (not name). */
export function evaluateDrd(model: EngineDrdModel, values: Record<string, RawValue>): EngineDrdResult {
  return evaluateDecisionRequirementsDiagram(model, values) as EngineDrdResult;
}
