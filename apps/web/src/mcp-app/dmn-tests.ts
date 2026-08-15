/**
 * The decision widget's test panel — where a simulation becomes an artefact.
 *
 * Three moves, and the middle one is the point of the whole widget:
 *
 *   run      → run the stored `<decision>.tests.yaml` on the server and show
 *              pass/fail per case (the SAME engine the canvas simulates with)
 *   capture  → turn the values currently entered in the decision table into a
 *              new case; the server records what it produces (golden master),
 *              so tacit knowledge someone just clicked becomes a versioned,
 *              reviewable file in the release PR
 *   replay   → click a case to load its values back onto the canvas; a failing
 *              case is then visible ON the table instead of in a message
 *
 * The panel never evaluates anything itself: expectations are compared
 * server-side, so a case that passes here passes in CI.
 */
import type { App } from "@modelcontextprotocol/ext-apps";

import { caseGlyph, pendingActualLine, uncoveredRulesLine } from "@/lib/decision-view";

import {
  type CaseOutcomeWire,
  type DecisionTestCase,
  getDecisionTests,
  isMissingTool,
  type ProcessRef,
  runDecisionTests,
  saveDecisionTests,
  type SuiteRunWire,
} from "./bridge";
import type { DmnModelerHandle, Scenario } from "./dmn-modeler";

export interface TestsHandle {
  /** (re)load the panel for a decision */
  load(ref: ProcessRef): void;
  destroy(): void;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function mountTests(
  app: App,
  modeler: DmnModelerHandle,
  opts: { readonly: boolean; onStatus: (text: string) => void },
): TestsHandle {
  const panel = el<HTMLElement>("tests");
  const toggle = el<HTMLButtonElement>("tests-toggle");
  const list = el<HTMLDivElement>("test-list");
  const empty = el<HTMLDivElement>("test-empty");
  const count = el<HTMLSpanElement>("test-count");
  const error = el<HTMLDivElement>("test-error");
  const coverage = el<HTMLDivElement>("coverage");
  const runBtn = el<HTMLButtonElement>("test-run");
  const captureBtn = el<HTMLButtonElement>("test-capture");
  const hideBtn = el<HTMLButtonElement>("test-hide");
  const form = el<HTMLFormElement>("test-form");
  const formGiven = el<HTMLDivElement>("test-form-given");
  const nameInput = el<HTMLInputElement>("test-name");
  const cancelBtn = el<HTMLButtonElement>("test-cancel");

  let ref: ProcessRef | undefined;
  let cases: DecisionTestCase[] = [];
  let outcome: SuiteRunWire | undefined;
  let baseVersion: string | undefined;
  let busy = false;
  let destroyed = false;
  /** the scenario the open name form belongs to */
  let pending: Scenario | undefined;

  captureBtn.hidden = opts.readonly;

  const showError = (message: string | undefined): void => {
    error.textContent = message ?? "";
    error.hidden = !message;
  };

  function render(): void {
    list.innerHTML = "";
    const results = new Map((outcome?.cases ?? []).map((c) => [c.name, c]));
    for (const testCase of cases) {
      list.append(row(testCase, results.get(testCase.name)));
    }
    empty.hidden = cases.length > 0;
    count.textContent = outcome
      ? `${outcome.passed}/${cases.length} pass${outcome.failed > 0 ? ` · ${outcome.failed} failing` : ""}`
      : cases.length > 0
        ? `${cases.length} case${cases.length > 1 ? "s" : ""}`
        : "";
    const uncovered = outcome?.uncoveredRules ?? [];
    coverage.hidden = uncovered.length === 0;
    coverage.textContent = uncovered.length > 0 ? uncoveredRulesLine(uncovered) : "";
    // stays enabled with zero cases: the run then reports which rules nothing
    // covers, which is exactly what a decision without tests needs to hear
    runBtn.disabled = busy;
  }

  function row(testCase: DecisionTestCase, result: CaseOutcomeWire | undefined): HTMLElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "case";
    item.title = "Load these values into the decision table";

    const head = document.createElement("div");
    head.className = "case-head";
    const status = document.createElement("span");
    status.className = `case-status ${result?.status ?? ""}`;
    status.textContent = caseGlyph(result?.status);
    const name = document.createElement("span");
    name.textContent = testCase.name;
    head.append(status, name);

    const given = document.createElement("div");
    given.className = "muted";
    given.textContent = Object.entries(testCase.given)
      .map(([k, v]) => `${k}: ${v ?? "null"}`)
      .join(" · ");
    item.append(head, given);

    for (const failure of result?.failures ?? []) {
      const line = document.createElement("div");
      line.className = "case-failure";
      line.textContent = failure;
      item.append(line);
    }
    if (result?.status === "pending") {
      const line = document.createElement("div");
      line.className = "muted";
      line.textContent = pendingActualLine(result.actual.value);
      item.append(line);
    }

    item.onclick = () => {
      // replay ON the canvas: the decision table is the better error message
      if (modeler.applyScenario(testCase.given)) {
        opts.onStatus(`Replaying "${testCase.name}" on the decision table`);
      } else {
        opts.onStatus("Open the decision table view to replay a case");
      }
    };
    return item;
  }

  /** load the stored suite (and its concurrency token) */
  async function reload(): Promise<void> {
    if (!ref || busy) return;
    busy = true;
    showError(undefined);
    try {
      const stored = await getDecisionTests(app, ref);
      if (destroyed) return;
      cases = stored.suite?.cases ?? [];
      baseVersion = stored.baseVersion;
      outcome = undefined;
      render();
      busy = false; // run() owns the flag from here
      await run(); // also with zero cases: it reports what nothing covers
    } catch (err) {
      if (destroyed) return;
      // a host without the decision tools (older Live Host) — hide, don't shout
      if (isMissingTool(err, "get_decision_tests")) {
        toggle.hidden = true;
        panel.hidden = true;
        return;
      }
      showError((err as Error).message);
    } finally {
      busy = false;
      render();
    }
  }

  async function run(): Promise<void> {
    if (!ref || busy) return;
    busy = true;
    showError(undefined);
    opts.onStatus("Running test cases…");
    render();
    try {
      outcome = await runDecisionTests(app, ref);
      if (destroyed) return;
      const summary =
        outcome.cases.length === 0
          ? "No test cases yet — capture a run to create the first one"
          : outcome.failed > 0
            ? `${outcome.failed} test case${outcome.failed > 1 ? "s" : ""} failing`
            : `All ${outcome.passed} test case${outcome.passed === 1 ? "" : "s"} pass`;
      opts.onStatus(summary);
      // the empty state carries it too — the status line alone is easy to miss
      empty.textContent =
        outcome.cases.length === 0
          ? outcome.uncoveredRules.length > 0
            ? `No test cases yet. ${outcome.uncoveredRules.length} rule(s) decide nothing that any case checks — enter values in the decision table and capture the run.`
            : "No test cases yet. Enter values in the decision table and capture the run."
          : "";
    } catch (err) {
      if (!destroyed) showError((err as Error).message);
    } finally {
      busy = false;
      render();
    }
  }

  /** step 1 of capturing: show the name form for the values on the canvas.
   *  Deliberately NOT window.prompt() — app hosts sandbox the iframe without
   *  allow-modals, where prompt() is ignored and the button looks dead. */
  async function startCapture(): Promise<void> {
    if (!ref || busy) return;
    showError(undefined);
    if (!modeler.simulatorReady()) {
      // the simulator lives in the decision-table view — take the user there
      // instead of explaining where to click
      const opened = await modeler.openDecisionTable();
      if (!opened) {
        showError("Open the decision table of the decision you want to test, then capture the run.");
        return;
      }
    }
    const captured = modeler.currentScenario();
    if (!captured || Object.keys(captured.scenario).length === 0) {
      showError(
        captured && captured.unmappable.length > 0
          ? `Only computed columns are filled in (${captured.unmappable.join(", ")}). A test case states VARIABLE values, so enter a value in a column that reads one directly.`
          : "Enter values in the decision table first — the captured case records what they produce.",
      );
      return;
    }
    pending = captured.scenario;
    formGiven.textContent =
      Object.entries(captured.scenario)
        .map(([k, v]) => `${k}: ${v ?? "null"}`)
        .join(" · ") +
      // a silently dropped column would make the case look complete when it is not
      (captured.unmappable.length > 0 ? ` — without the computed column(s) ${captured.unmappable.join(", ")}` : "");
    nameInput.value = "";
    form.hidden = false;
    nameInput.focus();
  }

  /** step 2: the named case goes to the server, which records its result */
  async function capture(name: string, scenario: Scenario): Promise<void> {
    if (!ref || busy) return;
    form.hidden = true;
    busy = true;
    render();
    showError(undefined);
    try {
      // no `expect`: the server records what the decision produces today, so
      // the case states the truth rather than a guess
      const next = [...cases, { name, given: scenario }];
      const saved = await saveDecisionTests(app, ref, next, { baseVersion, record: true });
      if (destroyed) return;
      if (saved.conflict) {
        showError("The test file changed meanwhile — reloading it, then try again.");
        busy = false;
        await reload();
        return;
      }
      baseVersion = saved.baseVersion;
      opts.onStatus(`Captured "${name}" into ${saved.path}`);
      void app.updateModelContext({
        content: [{ type: "text", text: `User captured a test case in ${saved.path}: "${name}".` }],
      });
      busy = false;
      await reload();
    } catch (err) {
      if (!destroyed) showError((err as Error).message);
    } finally {
      busy = false;
      render();
    }
  }

  toggle.onclick = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !outcome) void reload();
  };
  hideBtn.onclick = () => {
    panel.hidden = true;
  };
  runBtn.onclick = () => void run();
  captureBtn.onclick = () => void startCapture();
  cancelBtn.onclick = () => {
    form.hidden = true;
    pending = undefined;
  };
  form.onsubmit = (event) => {
    event.preventDefault(); // a form post would navigate the sandboxed iframe
    const name = nameInput.value.trim();
    if (!name || !pending) return;
    const scenario = pending;
    pending = undefined;
    void capture(name, scenario);
  };

  return {
    load(next: ProcessRef): void {
      ref = next;
      cases = [];
      outcome = undefined;
      baseVersion = undefined;
      render();
      if (!panel.hidden) void reload();
    },
    destroy(): void {
      destroyed = true;
      panel.hidden = true;
    },
  };
}
