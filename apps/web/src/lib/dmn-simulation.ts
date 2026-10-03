/**
 * The DMN simulation add-on (@emaarco/dmn-js-simulation), mounted the way a
 * decision table actually works — used by BOTH dmn-js hosts: the live editor
 * (notations/dmn-editor.ts) and the MCP-App decision widget
 * (mcp-app/engines/dmn.ts).
 *
 * A rule with `-` in a column reads nothing there, so for
 * `Rule 1: jahreszeit = "winter"` the season alone IS the whole scenario — the
 * other columns are not inputs the user owes the table. Since 0.3 the add-on
 * agrees natively: an empty input runs as FEEL `null` (matching `-` cells and
 * nothing else) in both the decision-table form and the DRD panel, the same way
 * @designiq/decisions reports what a scenario left unset rather than refusing to
 * run it (`simulateDecision`, `missingInputs`). That covers an agent-supplied
 * partial scenario (`open_decision_modeler` with a `scenario`) too — no store
 * override needed any more.
 */
import DmnSimulationModule from "@emaarco/dmn-js-simulation";
import type { DmnOptions } from "dmn-js/lib/Modeler";

/** the per-view dmn-js options both hosts construct their modeler with */
export const dmnSimulationViews = {
  drd: { additionalModules: [DmnSimulationModule.decisionRequirementsDiagram] },
  decisionTable: { additionalModules: [DmnSimulationModule.decisionTable] },
} satisfies Pick<DmnOptions, "drd" | "decisionTable">;
