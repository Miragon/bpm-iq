/**
 * The DMN simulation add-on (@emaarco/dmn-js-simulation), mounted the way a
 * decision table actually works — used by BOTH dmn-js hosts: the live editor
 * (components/live-editor.tsx) and the MCP-App decision widget
 * (mcp-app/dmn-modeler.ts).
 *
 * The add-on's decision-table form gates "Simulate" on EVERY input column
 * holding a value. A decision table does not read that way: a rule with `-` in
 * a column reads nothing there, so for `Rule 1: jahreszeit = "winter"` the
 * season alone IS the whole scenario — the other three columns are not inputs
 * the user owes the table. The add-on's own evaluation core already agrees (an
 * unset input matches `-` cells and nothing else), as does @bpmiq/decisions,
 * which reports what a scenario left unset rather than refusing to run it
 * (`simulateDecision`, `missingInputs`). Only that form's gate disagrees, and
 * it lives in one overridable place: the injected `simulationStore`.
 *
 * So we replace that store with one whose completeness check is "there is a
 * table with input columns", and every input stays optional. Nothing else
 * changes — the hit policy, the highlighting and the result bar are the
 * add-on's.
 *
 * The same gate blocks `run()` itself, which is why an agent-supplied partial
 * scenario (`open_decision_modeler` with a `scenario`) silently produced no
 * highlight before.
 *
 * NOT covered: the DRD view's own panel keeps the all-inputs-required gate. It
 * is plain DOM in a class the add-on does not export, with no store to swap, so
 * a multi-decision model still refuses a partial run from the DRD — reaching it
 * would mean poking at private fields that no `override` could typecheck.
 * Drilling into a decision table gets the relaxed gate either way.
 */
import DmnSimulationModule, { SimulationStore } from "@emaarco/dmn-js-simulation";
import type { DmnOptions } from "dmn-js/lib/Modeler";

class PartialScenarioStore extends SimulationStore {
  /** Runnable as soon as there is a table with columns to read: an unset column
   *  is not "missing input", it is a scenario that says nothing about it. */
  override isComplete(): boolean {
    const model = this.getModel();
    return !!model && model.inputs.length > 0;
  }
}

/** didi module — a later definition of a name wins, so this replaces the
 *  add-on's own `simulationStore` registration for the decision-table view. */
const partialScenarios = { simulationStore: ["type", PartialScenarioStore] };

/** the per-view dmn-js options both hosts construct their modeler with */
export const dmnSimulationViews = {
  drd: { additionalModules: [DmnSimulationModule.decisionRequirementsDiagram] },
  decisionTable: { additionalModules: [DmnSimulationModule.decisionTable, partialScenarios] },
} satisfies Pick<DmnOptions, "drd" | "decisionTable">;
