/**
 * dmn-js wrapper for the decision widget — the modeler PLUS the simulation
 * add-on (@emaarco/dmn-js-simulation), mounted into both views through the
 * wiring the live editor uses too (lib/dmn-simulation.ts):
 *
 *   drd            → run the whole decision requirements diagram
 *   decisionTable  → enter values, see which rows light up
 *
 * The add-on is a drop-in dmn-js module; everything below it is the same
 * engine (`feelin`) the Live Host evaluates with server-side, so a scenario a
 * human clicks here and one an agent simulates cannot disagree.
 *
 * The wrapper exposes the two things the widget needs on top of editing: read
 * the values currently entered in the table simulator (to turn them into a
 * test case), and write values into it (to replay a stored case on the canvas).
 *
 * Both crossings go through `variableOf` from the shared library rather than a
 * local guess, because the two sides do NOT hold the same thing: the simulator
 * holds a column's value (what the input expression computed), a scenario holds
 * a variable's value (what the model reads). They coincide for a plain read and
 * for nothing else — see the note on variableOf in @bpmiq/decisions.
 */
import { type Scenario, variableOf } from "@bpmiq/decisions";
import DmnModeler from "dmn-js/lib/Modeler";
import DmnViewer from "dmn-js/lib/Viewer";

import { dmnSimulationViews } from "@/lib/dmn-simulation";

/** the simulation store of the ACTIVE decision-table view (add-on internals we
 *  depend on deliberately — its published surface, see SimulationStore.d.ts) */
interface SimulationStoreLike {
  getModel(): { inputs: Array<{ id: string; expression: string; label: string }>; rules: Array<{ id: string }> } | null;
  getValues(): Array<string | number | boolean | null | undefined>;
  getResult(): { matchedRuleIndices: number[]; reportedRuleIndices: number[] } | null;
  setValue(index: number, value: string | number | boolean | null | undefined): void;
  run(): unknown;
  reset(): void;
}

/** a scenario as the platform speaks it: variable name → value. THE library's
 *  type — the widget and the Live Host mean the same thing by it. */
export type { Scenario };

/** what the table simulator currently holds, in scenario terms */
export interface CapturedScenario {
  scenario: Scenario;
  /** labels of columns whose expression is not a plain variable read, so their
   *  value cannot be stated as a scenario — reported, never silently dropped */
  unmappable: string[];
}

export interface DmnModelerHandle {
  /** parse + render the document text (DMN XML for this engine) */
  importText(text: string): Promise<void>;
  /** serialize the current model, formatted */
  exportText(): Promise<string>;
  editable: boolean;
  onDirty(cb: () => void): void;
  /** the values currently entered in the table simulator, keyed by variable */
  currentScenario(): CapturedScenario | undefined;
  /** load a scenario into the table simulator and evaluate it */
  applyScenario(scenario: Scenario): boolean;
  /** true while a decision table (and with it the simulator) is on screen */
  simulatorReady(): boolean;
  /**
   * Switch to a decision table view — the simulator only exists there, and
   * dmn-js opens the DRD first whenever the model has DMNDI. Without an id:
   * the only table, if the model has exactly one.
   */
  openDecisionTable(decisionId?: string): Promise<boolean>;
  destroy(): void;
}

export function mountDmnModeler(container: HTMLElement, readonly: boolean): DmnModelerHandle {
  const options = { container, ...dmnSimulationViews };
  const instance = readonly ? new DmnViewer(options) : new DmnModeler(options);

  const dirtyCbs: Array<() => void> = [];

  /** the active view's simulation store, when the active view is a table.
   *  Read on demand rather than cached — each view is its own injector, so the
   *  store is a different object after every view switch. */
  const store = (): SimulationStoreLike | undefined => {
    try {
      // strict:false — the DRD and literal-expression views have no store
      return instance.getActiveViewer()?.get("simulationStore", false) as SimulationStoreLike | undefined;
    } catch {
      return undefined;
    }
  };

  // Edit tracking: dmn-js does NOT re-emit editing events on the manager —
  // every view is its own viewer with its own command stack, and an inactive
  // viewer's stack never fires. So subscribe per viewer, for its lifetime
  // (the same shape live-client/dmn-sync.ts uses for the web editor).
  const subscribed = new Set<{ on(e: string, cb: () => void): void; off(e: string, cb: () => void): void }>();
  const onChanged = (): void => {
    for (const cb of dirtyCbs) cb();
  };
  if (!readonly) {
    const subscribe = (viewer: unknown): void => {
      const target = viewer as { on(e: string, cb: () => void): void; off(e: string, cb: () => void): void } | null;
      if (!target || subscribed.has(target)) return;
      subscribed.add(target);
      target.on("commandStack.changed", onChanged);
    };
    instance.on("viewer.created", ((event: { viewer?: unknown }) => subscribe(event?.viewer)) as never);
    instance.on("views.changed", () => subscribe(instance.getActiveViewer()));
    subscribe(instance.getActiveViewer());
  }

  return {
    editable: !readonly,
    async importText(xml: string): Promise<void> {
      await instance.importXML(xml);
    },
    async exportText(): Promise<string> {
      if (readonly) throw new Error("read-only view");
      const { xml } = await (instance as DmnModeler).saveXML({ format: true });
      if (!xml) throw new Error("empty model");
      return xml;
    },
    onDirty(cb) {
      dirtyCbs.push(cb);
    },
    currentScenario(): CapturedScenario | undefined {
      const active = store();
      const model = active?.getModel();
      if (!active || !model) return undefined;
      const values = active.getValues();
      const scenario: Scenario = {};
      const unmappable: string[] = [];
      model.inputs.forEach((input, n) => {
        const value = values[n];
        // an unset column is left out — a partial scenario is still a scenario
        if (value === undefined || value === "") return;
        const variable = variableOf(input.expression);
        // a computed column (`upper case(kundentyp)`) holds a RESULT, not a
        // variable's value: writing it into a case would key the scenario on
        // something the model never reads, and the case would fail on save
        if (!variable) return void unmappable.push(input.label || input.expression);
        scenario[variable] = value;
      });
      return { scenario, unmappable };
    },
    simulatorReady(): boolean {
      return store()?.getModel() != null;
    },
    async openDecisionTable(decisionId?: string): Promise<boolean> {
      const tables = instance.getViews().filter((v) => v.type === "decisionTable");
      const target = decisionId ? tables.find((v) => v.element?.id === decisionId) : tables.length === 1 && tables[0];
      if (!target) return false;
      await instance.open(target);
      return true;
    },
    applyScenario(scenario: Scenario): boolean {
      const active = store();
      const model = active?.getModel();
      if (!active || !model) return false;
      active.reset();
      let applied = false;
      model.inputs.forEach((input, n) => {
        const variable = variableOf(input.expression);
        if (!variable || !(variable in scenario)) return;
        active.setValue(n, scenario[variable] ?? null);
        applied = true;
      });
      if (applied) active.run();
      return applied;
    },
    destroy(): void {
      for (const viewer of subscribed) viewer.off("commandStack.changed", onChanged);
      subscribed.clear();
      instance.destroy();
    },
  };
}
