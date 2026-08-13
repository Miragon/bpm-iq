/**
 * @bpmiq/decisions — what the platform can say about a DMN decision beyond
 * "here is the XML":
 *
 *   simulateDecision — run a scenario through the whole DRD, in dependency
 *                      order, reporting matched rules BY ID
 *   analyzeDecision  — the static checks that need no test cases (broken FEEL,
 *                      unreachable rules, wiring that does nothing) plus the
 *                      value candidates a test case draws from
 *   runDecisionTests — the sidecar test suite (./tests)
 *
 * The evaluation engine is @emaarco/dmn-js-simulation, the same add-on the
 * dmn-js modeler runs in the browser, driven here through the platform's own
 * DMN parse (@bpmiq/notations) — one parser, one FEEL semantics, server and
 * widget included.
 */
export {
  analyzeDecision,
  type DecisionAnalysis,
  type DecisionFinding,
  type Severity,
  type VariableProfile,
} from "./analyze.ts";
export {
  type DecisionVariable,
  decisionVariables,
  FREE_INPUT_PREFIX,
  freeVariablesOf,
  type RawValue,
  toDecisionModel,
  toDrdModel,
} from "./model.ts";
export { type DecisionOutcome, type Scenario, simulateDecision, type SimulationResult } from "./simulate.ts";
