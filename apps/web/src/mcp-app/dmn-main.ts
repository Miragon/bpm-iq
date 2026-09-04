/**
 * The decision widget: dmn-js + the simulation add-on, wired to the Live
 * Host's decision tools.
 *
 * Same contract as the BPMN widget (mcp-app/main.ts): the data path is
 * ontoolinput + an app-initiated get_dmn_xml (never the tool result — hosts
 * cap it and strip structuredContent), saves are autosaved with the
 * baseVersion CAS and a conflict banner.
 *
 * Deliberately WITHOUT the Yjs live upgrade the BPMN widget does: a decision
 * table is edited cell by cell by one person at a time, and the CAS conflict
 * flow covers the rare collision honestly. The moment two people co-edit
 * tables in practice, tryLive() is reusable as-is.
 *
 * What it adds instead: `open_decision_modeler` may carry a `scenario`, which
 * is played straight into the simulator — so an agent can say "here is the
 * case that fails" and the user SEES the row that lights up.
 */
import "./dmn-styles.css";

import { fileDeepLink } from "@bpmiq/contracts/deep-link";
import { roomName } from "@bpmiq/contracts/live";

import {
  bootConfig,
  claimDocument,
  getDmnXml,
  makeApp,
  type ProcessRef,
  type SaveConflict,
  saveDmnXml,
} from "./bridge";
import { type DmnModelerHandle, mountDmnModeler, type Scenario } from "./dmn-modeler";
import { mountTests, type TestsHandle } from "./dmn-tests";
import { loadIconFont } from "./font";
import { el, mountChrome, openExternal, wireApp } from "./shell";

// kick off immediately — the decision-table controls need it, nothing blocks
loadIconFont("dmn").catch(() => {
  /* icons degrade to tofu; the modeler itself is unaffected */
});

const { toolbar, saveBtn, openBtn, fullscreenBtn, status, setStatus, showBanner, hideBanner } = mountChrome();

const cfg = bootConfig();
const app = makeApp();
if (cfg.publicUrl) openBtn.title = `Open this decision in the full bpmiq web modeler (${cfg.publicUrl})`;

let modeler: DmnModelerHandle | undefined;
let tests: TestsHandle | undefined;
let ref: ProcessRef | undefined;
let baseVersion = "";
let inactive = false; // superseded by a newer widget — stop all saving
let editSeq = 0; // bumps on every edit — save() detects mid-flight edits
let loadEpoch = 0; // bumps on every load() — stale continuations bail out
let releaseClaim: (() => void) | undefined;

/**
 * The save button IS the state display: nothing to save reads "Saved" and is
 * inert, an unsaved edit reads "● Save now" and is armed (autosave will take
 * it within a second or two, the button just makes it immediate). The dot next
 * to the title mirrors it for the collapsed toolbar.
 */
let dirty = false;
const setDirty = (d: boolean): void => {
  dirty = d;
  // a superseded instance never re-arms: the claim callback disabled the save
  // button for good, and the next edit's setDirty(true) must not undo that
  // (save() would return immediately — an armed button that does nothing)
  if (inactive) return;
  toolbar.dirty.hidden = !d;
  if (!modeler?.editable) return;
  saveBtn.disabled = saving || !d;
  saveBtn.textContent = saving ? "Saving…" : d ? "● Save now" : "Saved";
  saveBtn.title = d ? "Unsaved changes — they save automatically, this saves them now" : "Everything is saved";
};

const AUTOSAVE_MS = 1500;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let autosavePaused = false;
let saving = false;

function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  if (inactive || autosavePaused || !modeler?.editable) return;
  autosaveTimer = setTimeout(() => void save(), AUTOSAVE_MS);
}

async function load(decisionRef: ProcessRef, scenario?: Scenario): Promise<void> {
  const epoch = ++loadEpoch;
  releaseClaim?.();
  releaseClaim = undefined;
  clearTimeout(autosaveTimer);
  hideBanner();
  autosavePaused = false;
  ref = decisionRef;
  // `ref` now names the INCOMING document while the table still shows the old
  // one — no deep link (and no flush) until the load owns the widget
  openBtn.hidden = true;
  setStatus("Loading decision…");
  const loaded = await getDmnXml(app, decisionRef);
  if (epoch !== loadEpoch || inactive) return;
  ref = { repo: decisionRef.repo, path: loaded.path };
  toolbar.title.textContent = `${decisionRef.repo} · ${loaded.path}`;
  // a loaded decision has a web address (the file-editor route — the same
  // target the repo overview links decisions to)
  openBtn.hidden = !cfg.publicUrl;
  baseVersion = loaded.baseVersion;
  if (!modeler) {
    modeler = mountDmnModeler(el<HTMLDivElement>("canvas"), cfg.readonly);
    modeler.onDirty(() => {
      editSeq++;
      setDirty(true);
      scheduleAutosave();
    });
    saveBtn.hidden = !modeler.editable;
    tests = mountTests(app, modeler, { readonly: cfg.readonly, onStatus: setStatus });
    setDirty(false);
  }
  await modeler.importText(loaded.content);
  if (epoch !== loadEpoch || inactive) return;
  // dmn-js opens the DRD whenever the model has DMNDI, but a one-decision file
  // IS its table — and the simulator only exists in the table view. Open it, or
  // the widget's whole point sits one click away behind a single box.
  await modeler.openDecisionTable().catch(() => false);
  if (epoch !== loadEpoch || inactive) return;
  setDirty(false);
  tests?.load(ref);
  releaseClaim = claimDocument(roomName(decisionRef.repo, loaded.path), () => {
    inactive = true;
    clearTimeout(autosaveTimer);
    tests?.destroy();
    tests = undefined;
    showBanner("This decision was opened in a newer widget — this instance is now inactive.", []);
    saveBtn.disabled = true;
  });
  setStatus(cfg.readonly ? "Read-only view" : "Ready — changes save automatically");

  // an agent-supplied scenario: play it into the simulator. dmn-js opens on
  // the DRD, and the table simulator only exists once its view is active, so
  // retry briefly rather than dropping the scenario on the floor.
  if (scenario) void playScenario(scenario, epoch);
}

async function playScenario(scenario: Scenario, epoch: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (epoch !== loadEpoch || inactive) return;
    if (modeler?.applyScenario(scenario)) {
      setStatus("Scenario loaded — the matching rules are highlighted");
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  setStatus("Open the decision table view to see the scenario");
}

async function save(textOverride?: string, versionOverride?: string, seqOverride?: number): Promise<void> {
  if (!modeler || !ref || inactive || saving || autosavePaused || !modeler.editable) return;
  saving = true;
  clearTimeout(autosaveTimer);
  setDirty(dirty); // repaints the button as "Saving…"
  const seq = seqOverride ?? editSeq;
  const epoch = loadEpoch;
  try {
    const text = textOverride ?? (await modeler.exportText());
    if (epoch !== loadEpoch) return;
    setStatus("Saving…");
    const result = await saveDmnXml(app, ref, text, versionOverride ?? baseVersion);
    if (epoch !== loadEpoch) return;
    if (!result.ok) {
      autosavePaused = true;
      clearTimeout(autosaveTimer);
      onConflict(result, text, seq);
      return;
    }
    baseVersion = result.baseVersion;
    if (editSeq === seq) setDirty(false);
    const problems = [...(result.errors ?? []), ...result.warnings];
    setStatus(problems.length > 0 ? `Saved · ${problems.length} finding(s)` : "Saved");
    status.title = problems.join("\n");
    void app.updateModelContext({
      content: [{ type: "text", text: `User saved ${ref.repo}/${ref.path} in the decision modeler widget.` }],
    });
  } catch (err) {
    if (epoch === loadEpoch) setStatus(`Autosave failed: ${(err as Error).message} — retrying on next change`);
  } finally {
    saving = false;
    setDirty(editSeq !== seq || (dirty && epoch === loadEpoch));
    if (epoch === loadEpoch && editSeq !== seq) scheduleAutosave();
  }
}

function onConflict(conflict: SaveConflict, myText: string, mySeq: number): void {
  const epoch = loadEpoch;
  setStatus("Conflict — autosave paused");
  showBanner("Someone saved this decision in the meantime.", [
    {
      label: "Load their version",
      run: () => {
        if (epoch !== loadEpoch || inactive) return;
        void (async () => {
          hideBanner();
          try {
            await modeler?.importText(conflict.currentContent);
          } catch {
            if (epoch !== loadEpoch || inactive) return;
            onConflict(conflict, myText, mySeq);
            return;
          }
          if (epoch !== loadEpoch || inactive) return;
          baseVersion = conflict.baseVersion;
          setDirty(false);
          autosavePaused = false;
          setStatus("Reloaded");
        })();
      },
    },
    {
      label: "Overwrite anyway",
      danger: true,
      run: () => {
        if (epoch !== loadEpoch || inactive) return;
        hideBanner();
        autosavePaused = false;
        void save(myText, conflict.baseVersion, mySeq);
      },
    },
    {
      label: "Keep editing",
      run: () => {
        if (epoch !== loadEpoch || inactive) return;
        hideBanner();
        baseVersion = conflict.baseVersion;
        autosavePaused = false;
        setStatus("Editing on — autosave will overwrite their version");
        scheduleAutosave();
      },
    },
  ]);
}

saveBtn.onclick = () => void save();
// deep link into the web app's file editor. openLink FIRST, nothing awaited
// before it (user activation, see the BPMN twin); the DMN widget has no live
// mode, so a pending edit is flushed in parallel — it lands in the same live
// document the opened editor joins. While a conflict banner is up, save()
// stays paused on purpose: the opened editor shows the SERVER version and the
// banner keeps owning the divergence decision.
openBtn.onclick = () => {
  if (!ref?.path || !cfg.publicUrl) return;
  const url = fileDeepLink(cfg.publicUrl, ref.repo, ref.path);
  void openExternal(app, url, setStatus);
  if (dirty) void save();
};
fullscreenBtn.onclick = () => void app.requestDisplayMode({ mode: "fullscreen" });

wireApp(app, {
  setStatus,
  hasLoaded: () => ref !== undefined,
  onToolArgs: (args) =>
    load({ repo: args.repo, id: args.id, path: args.path }, (args as { scenario?: Scenario }).scenario),
});
