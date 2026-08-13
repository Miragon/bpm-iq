/**
 * dmn-js wrapper for the decision widget — the modeler PLUS the simulation
 * add-on (@emaarco/dmn-js-simulation), mounted into both views:
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
 */
import DmnSimulationModule from "@emaarco/dmn-js-simulation";
import DmnModeler from "dmn-js/lib/Modeler";
import DmnViewer from "dmn-js/lib/Viewer";

/** the simulation store of the ACTIVE decision-table view (add-on internals we
 *  depend on deliberately — its published surface, see SimulationStore.d.ts) */
interface SimulationStoreLike {
  getModel(): { inputs: Array<{ id: string; expression: string; label: string }>; rules: Array<{ id: string }> } | null;
  getValues(): Array<string | number | boolean | null | undefined>;
  getResult(): { matchedRuleIndices: number[]; reportedRuleIndices: number[] } | null;
  setValue(index: number, value: string | number | boolean | null | undefined): void;
  run(): unknown;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

/** a scenario as the platform speaks it: variable name → value */
export type Scenario = Record<string, string | number | boolean | null>;

export interface DmnModelerHandle {
  importXml(xml: string): Promise<void>;
  saveXml(): Promise<string>;
  editable: boolean;
  onDirty(cb: () => void): void;
  /** fires whenever the active view or its simulation state changes */
  onSimulationChange(cb: () => void): void;
  /** the values currently entered in the table simulator, keyed by variable */
  currentScenario(): Scenario | undefined;
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
  const options = {
    container,
    drd: { additionalModules: [DmnSimulationModule.decisionRequirementsDiagram] },
    decisionTable: { additionalModules: [DmnSimulationModule.decisionTable] },
  };
  const instance = readonly ? new DmnViewer(options) : new DmnModeler(options);

  const dirtyCbs: Array<() => void> = [];
  const simCbs: Array<() => void> = [];
  let unsubscribeStore: (() => void) | undefined;

  /** the active view's simulation store, when the active view is a table */
  const store = (): SimulationStoreLike | undefined => {
    try {
      // strict:false — the DRD and literal-expression views have no store
      return instance.getActiveViewer()?.get("simulationStore", false) as SimulationStoreLike | undefined;
    } catch {
      return undefined;
    }
  };

  /** re-subscribe to the simulation store whenever the active view changes —
   *  each view is its own injector, so the store is a different object */
  const rebind = (): void => {
    unsubscribeStore?.();
    unsubscribeStore = store()?.subscribe(() => {
      for (const cb of simCbs) cb();
    });
    for (const cb of simCbs) cb();
  };

  instance.on("views.changed", rebind);
  instance.on("import.done", rebind);

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
    async importXml(xml: string): Promise<void> {
      await instance.importXML(xml);
    },
    async saveXml(): Promise<string> {
      if (readonly) throw new Error("read-only view");
      const { xml } = await (instance as DmnModeler).saveXML({ format: true });
      if (!xml) throw new Error("empty model");
      return xml;
    },
    onDirty(cb) {
      dirtyCbs.push(cb);
    },
    onSimulationChange(cb) {
      simCbs.push(cb);
    },
    currentScenario(): Scenario | undefined {
      const active = store();
      const model = active?.getModel();
      if (!active || !model) return undefined;
      const values = active.getValues();
      const scenario: Scenario = {};
      model.inputs.forEach((input, n) => {
        const value = values[n];
        // an unset column is left out — a partial scenario is still a scenario
        if (value === undefined || value === "") return;
        scenario[input.expression.trim() || input.label] = value;
      });
      return scenario;
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
        const key = input.expression.trim() || input.label;
        if (!(key in scenario)) return;
        active.setValue(n, scenario[key] ?? null);
        applied = true;
      });
      if (applied) active.run();
      return applied;
    },
    destroy(): void {
      unsubscribeStore?.();
      for (const viewer of subscribed) viewer.off("commandStack.changed", onChanged);
      subscribed.clear();
      instance.destroy();
    },
  };
}
