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
 * ISOMORPHIC BY DESIGN. The evaluation engine is @emaarco/dmn-js-simulation —
 * the add-on the dmn-js modeler runs in the BROWSER — driven through the
 * platform's own DMN parse (@bpmiq/notations, itself pure). So the same module
 * answers on every side:
 *
 *   Node    apps/live-host (the /mcp decision tools, the release PR's decision
 *           impact) and packages/decisions/cli.ts (the `pnpm validate` gate)
 *   Browser apps/web — the SPA's live DMN editor and the MCP-App widget
 *
 * That is the whole point: a scenario a human clicks, one an agent simulates
 * and one CI runs are the SAME computation, not three implementations that
 * agree until they don't. Nothing exported here may import a Node builtin —
 * `pnpm arch` enforces it (rule: decisions-lib-stays-isomorphic); ./cli.ts is
 * the one Node-only module and is not exported.
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
  variableOf,
} from "./model.ts";
export { type DecisionOutcome, type Scenario, simulateDecision, type SimulationResult } from "./simulate.ts";
