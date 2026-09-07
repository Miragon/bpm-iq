/**
 * The decision widget — the dmn engine on the shared widget core
 * (core/widget.ts + core/lifecycle.ts: App handshake → tool input → load the
 * live document → engine → CAS autosave with the conflict banner → the
 * newest-widget claim). What is DMN here: the simulation add-on inside the
 * engine (engines/dmn.ts), the tests panel (dmn-tests.ts), the inlined dmn
 * icon font — and NO live upgrade: the engine has no bindLive, so the core
 * stays on CAS autosave (a decision table is edited cell by cell by one
 * person at a time; the conflict flow covers the rare collision honestly).
 *
 * `open_decision_modeler` may carry a `scenario`, which rides along in the
 * tool input and is played straight into the simulator once the decision
 * table is up — so an agent can say "here is the case that fails" and the
 * user SEES the row that lights up.
 */
import "./dmn-styles.css";

import { bootWidget } from "./core/widget";
import { mountTests } from "./dmn-tests";
import { type DmnEngine, mountDmnEngine, type Scenario } from "./engines/dmn";

bootWidget<DmnEngine>({
  notation: "dmn",
  noun: "decision",
  engine: mountDmnEngine,
  iconFont: "dmn",
  extras: ({ app, engine, readonly, chrome }) => {
    const tests = mountTests(app, engine, { readonly, onStatus: chrome.setStatus });
    let generation = 0; // bumps per document — a stale scenario replay bails out
    return {
      onDocument: (doc, input) => {
        const mine = ++generation;
        tests.load(doc);
        void (async () => {
          // dmn-js opens the DRD whenever the model has DMNDI, but a one-decision
          // file IS its table — and the simulator only exists in the table view.
          // Open it, or the widget's whole point sits one click away behind a box.
          await engine.openDecisionTable().catch(() => false);
          const scenario = (input as { scenario?: Scenario }).scenario;
          if (scenario && mine === generation) {
            await playScenario(engine, scenario, () => mine === generation, chrome.setStatus);
          }
        })();
      },
      destroy: () => {
        generation++;
        tests.destroy();
      },
    };
  },
});

/** an agent-supplied scenario: play it into the simulator. The table
 *  simulator only exists once its view is active, so retry briefly rather
 *  than dropping the scenario on the floor. */
async function playScenario(
  engine: DmnEngine,
  scenario: Scenario,
  alive: () => boolean,
  setStatus: (text: string) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!alive()) return;
    if (engine.applyScenario(scenario)) {
      setStatus("Scenario loaded — the matching rules are highlighted");
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (alive()) setStatus("Open the decision table view to see the scenario");
}
