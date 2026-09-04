/**
 * Widget wiring: App handshake → tool input → load the live document → modeler,
 * plus the save lifecycle with the baseVersion CAS conflict flow (the same
 * GET→edit→PUT-CAS dance every AI client does — deliberately NOT the Yjs path).
 *
 * Data path is ontoolinput + an app-initiated get_bpmn_xml — never the tool
 * result (Claude Desktop strips structuredContent, ext-apps #696), and never
 * a payload big enough to trip the hosts' ~150k-char result limit.
 */
import "./styles.css";

import { processDeepLink } from "@bpmiq/contracts/deep-link";
import { roomName } from "@bpmiq/contracts/live";
import { modelStem } from "@bpmiq/notations";

import { tbpmToggleAction } from "@/notations/bpmn-sticky";

import {
  bootConfig,
  claimDocument,
  getBpmnXml,
  makeApp,
  type ProcessRef,
  saveBpmnXml,
  type SaveConflict,
} from "./bridge";
import { loadIconFont } from "./font";
import { type LiveHandle, tryLive, type TryLiveHooks } from "./live";
import { type ModelerHandle, mountModeler } from "./modeler";
import { el, mountChrome, openExternal, wireApp } from "./shell";
import { mountTodos, type TodosHandle } from "./todos";

// kick off immediately — palette icons need it, but nothing blocks on it
loadIconFont("bpmn").catch(() => {
  /* icons degrade to tofu; the modeler itself is unaffected */
});

const { toolbar, saveBtn, openBtn, fullscreenBtn, status, setStatus, showBanner, hideBanner } = mountChrome();

const cfg = bootConfig();
const app = makeApp();
if (cfg.publicUrl) openBtn.title = `Open this model in the full bpmiq web modeler (${cfg.publicUrl})`;

let modeler: ModelerHandle | undefined;
let todos: TodosHandle | undefined; // model-anchored work items — absent without a tracker
let ref: ProcessRef | undefined;
let baseVersion = "";
let inactive = false; // superseded by a newer widget — stop all saving
let live: LiveHandle | undefined; // Yjs session — when set, autosave is off
let dirty = false; // authoritative unsaved-changes flag (the dot mirrors it)
let editSeq = 0; // bumps on every canvas edit — save() detects mid-flight edits
let liveEpoch = 0; // bumps on every load() — stale async continuations bail out
let upgradingLive = false; // single-flight guard for upgradeToLive
let releaseClaim: (() => void) | undefined; // undo of the current claimDocument

const setDirty = (d: boolean): void => {
  dirty = d;
  toolbar.dirty.hidden = !d;
};

// ── autosave: the widget behaves like a live room — every pause in modelling
// persists; findings inform, never block. Paused while a conflict banner is up
// (the timer must not race the user's decision).
const AUTOSAVE_MS = 1500;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let autosavePaused = false;
let saving = false;
function scheduleAutosave(): void {
  // clear BEFORE the gate: a schedule attempt while paused/live must also
  // kill a zombie timer armed earlier, not leave it racing the banner
  clearTimeout(autosaveTimer);
  if (inactive || autosavePaused || live) return; // live mode: Yjs persists continuously
  autosaveTimer = setTimeout(() => {
    void save();
  }, AUTOSAVE_MS);
}

/** non-blocking findings display — errors/warnings live in the status line */
function showFindings(errors: string[] | undefined, warnings: string[]): void {
  const parts: string[] = ["Saved"];
  if (errors?.length) parts.push(`${errors.length} validation error${errors.length > 1 ? "s" : ""}`);
  if (warnings.length) parts.push(`${warnings.length} warning${warnings.length > 1 ? "s" : ""}`);
  setStatus(parts.join(" · "));
  status.title = [...(errors ?? []), ...warnings].join("\n");
}

async function load(processRef: ProcessRef): Promise<void> {
  // defensive against out-of-contract hosts re-delivering tool input: this
  // load owns the widget from here. Bump the epoch (stale async continuations
  // — pending upgrades, banner actions, an OLDER load — bail out on it),
  // release the old claim (re-claiming without releasing supersedes OURSELVES
  // via the BroadcastChannel), and tear down live state, timers and banners.
  const epoch = ++liveEpoch;
  releaseClaim?.();
  releaseClaim = undefined;
  live?.destroy();
  live = undefined;
  clearTimeout(autosaveTimer);
  hideBanner();
  autosavePaused = false;
  ref = processRef;
  // `ref` now names the INCOMING document while the canvas still shows the old
  // one — no deep link (and no flush) until the load owns the widget
  openBtn.hidden = true;
  setStatus("Loading model…");
  const loaded = await getBpmnXml(app, processRef);
  if (epoch !== liveEpoch || inactive) return; // a newer load owns the widget
  ref = { repo: processRef.repo, path: loaded.path };
  toolbar.title.textContent = `${processRef.repo} · ${loaded.path}`;
  // a loaded model has a web address — even for a later-superseded instance
  // the deep link stays the most useful remaining control
  openBtn.hidden = !cfg.publicUrl;
  baseVersion = loaded.baseVersion;
  if (!modeler) {
    modeler = mountModeler(el<HTMLDivElement>("canvas"), cfg.readonly);
    modeler.onDirty(() => {
      if (live) return; // Yjs already persisted the change
      editSeq++;
      setDirty(true);
      scheduleAutosave();
    });
    saveBtn.hidden = !modeler.editable;
    // t.BPM switch (#117): same document-property flip as the web editor's
    // header toggle — a facilitator can start a workshop from the widget
    if (modeler.editable) mountTbpmSwitch(saveBtn, modeler);
    // bound BEFORE the first import: the canvas controller re-renders its
    // badges on every `import.done` (incl. the live re-imports)
    todos = mountTodos(app, modeler, { readonly: cfg.readonly });
  }
  await modeler.importText(loaded.content);
  if (epoch !== liveEpoch || inactive) return; // a newer load owns the widget
  setDirty(false);
  // the todos of THIS document — a failing/absent tracker never blocks the model
  todos?.load({ repo: processRef.repo, path: loaded.path });
  releaseClaim = claimDocument(roomName(processRef.repo, loaded.path), () => {
    inactive = true;
    clearTimeout(autosaveTimer);
    live?.destroy();
    live = undefined;
    todos?.destroy();
    todos = undefined;
    showBanner("This document was opened in a newer widget — this instance is now inactive.", []);
    saveBtn.disabled = true;
  });
  setStatus(cfg.readonly ? "Read-only view" : "Ready — changes save automatically");

  // progressive upgrade to the live Yjs session (the web SPA's co-editing
  // path): on success autosave retires — the CRDT persists every edit and
  // remote changes appear as they happen. Any failure leaves autosave on.
  // beforeBind (flushForLive) persists unsaved canvas state before the first
  // Yjs import may replace the canvas.
  if (modeler.editable) await upgradeToLive();
}

/** attempt the live upgrade; on success autosave retires (timer cleared,
 *  save button hidden). Unsaved canvas state is safe: tryLive's beforeBind
 *  flushes it before the first Yjs import. Failure leaves autosave on. */
async function upgradeToLive(): Promise<void> {
  if (!modeler || !ref || !modeler.editable || inactive || live || upgradingLive) return;
  upgradingLive = true;
  const epoch = liveEpoch;
  try {
    const handle = await tryLive(app, ref, modeler, liveHooks());
    if (!handle) return;
    if (inactive || epoch !== liveEpoch || live) {
      // superseded or re-loaded while connecting (the claim callback / the
      // next load ran before `live` was assigned) — tear the session down
      handle.destroy();
      return;
    }
    live = handle;
    clearTimeout(autosaveTimer);
    saveBtn.hidden = true;
    setDirty(false);
    setStatus("Live — co-editing enabled, changes sync instantly");
  } finally {
    upgradingLive = false;
  }
}

/** hooks shared by every live upgrade attempt (initial load + reconnects) */
function liveHooks(): TryLiveHooks {
  return {
    onConflict: (msg) => setStatus(`Sync conflict: ${msg}`),
    beforeBind: flushForLive,
    onDead: () => void onLiveDead(),
  };
}

/** the first Yjs import replaces the canvas — flush unsaved state through the
 *  normal CAS save first so nothing is lost; false aborts the upgrade */
async function flushForLive(): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (!inactive && !autosavePaused && (saving || dirty)) {
    if (Date.now() > deadline) {
      // give up on the UPGRADE only — autosave keeps retrying the edit
      scheduleAutosave();
      return false;
    }
    if (!saving) await save();
    await new Promise((r) => setTimeout(r, 100));
  }
  return !inactive && !autosavePaused;
}

/** the established live session died (any ws drop or doc-level close is
 *  final — the single-use ticket cannot re-authenticate the provider's
 *  auto-reconnect). Persistence must never stop silently: reconcile against
 *  a fresh bridge read, then either resume live with a fresh ticket or hand
 *  the decision to the user. */
async function onLiveDead(): Promise<void> {
  const epoch = liveEpoch;
  const replica = live?.snapshot(); // the room state this session last knew
  live?.destroy();
  live = undefined;
  if (inactive || !modeler || !ref) return;
  setStatus("Live sync lost — reconnecting…");
  // gate edits made during the reconcile: a save against the pre-death token
  // would be refused anyway (the live session moved the version) and its
  // conflict banner would fight the reconcile's own banner
  autosavePaused = true;
  clearTimeout(autosaveTimer);
  let fresh: Awaited<ReturnType<typeof getBpmnXml>>;
  try {
    fresh = await getBpmnXml(app, ref);
  } catch {
    if (epoch !== liveEpoch || inactive) return;
    // even the bridge is down: keep the stale token — the next save's CAS
    // conflict banner hands the decision to the user
    autosavePaused = false;
    editSeq++;
    setDirty(true);
    saveBtn.hidden = false;
    setStatus("Live sync lost — changes save automatically");
    scheduleAutosave();
    return;
  }
  if (epoch !== liveEpoch || inactive) return;
  if (fresh.content === replica) {
    // the server holds exactly what this session last knew — nothing is
    // unsaved in either direction (shared byte lineage, so formatting can't
    // false-positive), and a fresh ticket resumes live seamlessly
    baseVersion = fresh.baseVersion;
    autosavePaused = false;
    await upgradeToLive();
    if (epoch !== liveEpoch || inactive) return;
    if (!live) {
      // the canvas can lag the replica by a remote op still inside the
      // import debounce at death — reconcile it to the fresh state, or the
      // next canvas save would silently revert that op. ONLY safe while the
      // canvas is clean and unsaved-against-fresh: an edit made during the
      // upgrade attempt (dirty, or already flushed → baseVersion moved) must
      // win instead — its canvas is newer than `fresh`. (Residual: such an
      // edit racing a colleague op that was still inside the debounce at
      // death keeps the canvas's side — same class as the documented
      // model-sync import-window race.)
      if (!dirty && baseVersion === fresh.baseVersion) {
        try {
          await modeler.importText(fresh.content);
        } catch {
          // unimportable snapshot — let the user decide instead of guessing
          if (epoch !== liveEpoch || inactive) return;
          autosavePaused = true;
          saveBtn.hidden = false;
          onLiveInterrupted(fresh);
          return;
        }
        if (epoch !== liveEpoch || inactive) return;
        setDirty(false);
      } else if (dirty) {
        scheduleAutosave();
      }
      saveBtn.hidden = false;
      setStatus("Live sync lost — changes save automatically");
    }
    return;
  }
  // the room moved during the outage (a colleague), local edits never reached
  // it, or both — direction-blind, so the USER decides; never overwrite
  // either side silently
  saveBtn.hidden = false;
  onLiveInterrupted(fresh); // keeps autosavePaused=true — the banner owns it
}

/** post-outage divergence banner — mirrors the CAS conflict flow: the banner
 *  owns the next step, autosavePaused until a choice is made */
function onLiveInterrupted(fresh: { content: string; baseVersion: string }): void {
  const epoch = liveEpoch; // a re-load invalidates these closures wholesale
  setStatus("Live sync interrupted");
  showBanner("Live sync was interrupted and the server state differs from this canvas.", [
    {
      label: "Load server version",
      run: () => {
        if (epoch !== liveEpoch || inactive) return;
        void (async () => {
          hideBanner();
          try {
            await modeler?.importText(fresh.content);
          } catch {
            // the server snapshot didn't import — keep MY canvas and re-ask
            if (epoch !== liveEpoch || inactive) return;
            onLiveInterrupted(fresh);
            return;
          }
          if (epoch !== liveEpoch || inactive) return;
          baseVersion = fresh.baseVersion;
          setDirty(false);
          autosavePaused = false;
          setStatus("Reloaded — changes save automatically");
          void upgradeToLive();
        })();
      },
    },
    {
      label: "Keep my canvas",
      danger: true,
      run: () => {
        if (epoch !== liveEpoch || inactive) return;
        hideBanner();
        baseVersion = fresh.baseVersion;
        autosavePaused = false;
        editSeq++;
        setDirty(true);
        setStatus("Keeping this canvas — autosave will overwrite the server version");
        scheduleAutosave();
      },
    },
  ]);
}

async function save(textOverride?: string, versionOverride?: string, seqOverride?: number): Promise<void> {
  if (!modeler || !ref || inactive || saving || live || autosavePaused) return;
  saving = true;
  clearTimeout(autosaveTimer);
  saveBtn.disabled = true;
  // an override replays an EARLIER serialization — pair it with the seq from
  // that moment, or a mid-flight edit would be marked saved without being sent
  const seq = seqOverride ?? editSeq;
  const epoch = liveEpoch; // a re-load mid-flight orphans this save entirely
  try {
    const text = textOverride ?? (await modeler.exportText());
    // re-loaded during the serialization: `ref` now names the NEW document —
    // never PUT the old canvas there
    if (epoch !== liveEpoch) return;
    setStatus("Saving…");
    // no validate preflight: lint:"warn" saves like a live room and reports
    // findings on the result — one round-trip, nothing blocks
    const result = await saveBpmnXml(app, ref, text, versionOverride ?? baseVersion);
    if (epoch !== liveEpoch) return; // stale result — the new load owns state
    if (!result.ok) {
      autosavePaused = true; // the banner owns the next step — no timer racing it
      clearTimeout(autosaveTimer); // incl. one armed by a mid-flight edit
      onConflict(result, text, seq);
      return;
    }
    baseVersion = result.baseVersion;
    if (editSeq === seq) setDirty(false); // a mid-flight edit keeps the dot on
    showFindings(result.errors, result.warnings);
    // tell the model the live state moved — it re-reads instead of trusting stale XML
    void app.updateModelContext({
      content: [{ type: "text", text: `User saved ${ref.repo}/${ref.path} in the modeler widget.` }],
    });
  } catch (err) {
    // transient (token expiry, network): keep the model, retry on next change
    if (epoch === liveEpoch) setStatus(`Autosave failed: ${(err as Error).message} — retrying on next change`);
  } finally {
    saving = false;
    saveBtn.disabled = false;
    // an edit made while this save was in flight is NOT in the payload just
    // sent — its own timer may also have fired into the `saving` guard above,
    // so re-arm here or it would sit unsaved behind a false "Saved"
    if (epoch === liveEpoch && editSeq !== seq) scheduleAutosave();
  }
}

function onConflict(conflict: SaveConflict, myText: string, mySeq: number): void {
  const epoch = liveEpoch; // a re-load invalidates these closures wholesale
  setStatus("Conflict — autosave paused");
  showBanner("Someone saved this model in the meantime.", [
    {
      label: "Load their version",
      run: () => {
        if (epoch !== liveEpoch || inactive) return;
        void (async () => {
          hideBanner();
          try {
            await modeler?.importText(conflict.currentContent);
          } catch {
            // their snapshot didn't import (e.g. transiently invalid mid-edit
            // XML) — keep MY canvas and hand the decision back
            if (epoch !== liveEpoch || inactive) return;
            onConflict(conflict, myText, mySeq);
            return;
          }
          if (epoch !== liveEpoch || inactive) return;
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
      // resend MY text against the FRESH token — CAS passes, their edit loses.
      // mySeq travels along: an edit made after myText was serialized keeps
      // the dirty dot and re-arms autosave instead of being marked saved.
      run: () => {
        if (epoch !== liveEpoch || inactive) return;
        hideBanner();
        autosavePaused = false;
        void save(myText, conflict.baseVersion, mySeq);
      },
    },
    {
      label: "Keep editing",
      run: () => {
        // keep MY state and persist it — the status promises the next save
        // overwrites theirs, so arm it instead of waiting for another edit
        if (epoch !== liveEpoch || inactive) return;
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
// deep link into the web modeler, carrying the canvas selection (?element=).
// openLink FIRST, nothing awaited before it — an await would burn the user
// activation the window.open fallback needs. A still-unsaved edit follows via
// save() in parallel: REST saves land in the very live document the opened
// web editor joins (in live mode Yjs has already persisted everything). While
// a conflict/interrupted banner is up, save() stays paused on purpose — the
// opened editor then shows the SERVER version and the banner keeps owning the
// divergence decision.
openBtn.onclick = () => {
  if (!ref?.path || !cfg.publicUrl) return;
  const url = processDeepLink(cfg.publicUrl, ref.repo, modelStem(ref.path), modeler?.selectedElementId());
  void openExternal(app, url, setStatus);
  if (dirty && !live) void save();
};
fullscreenBtn.onclick = () => void app.requestDisplayMode({ mode: "fullscreen" });

wireApp(app, {
  setStatus,
  hasLoaded: () => ref !== undefined,
  onToolArgs: (args) => load({ repo: args.repo, id: args.id, path: args.path }),
});

/** the widget-chrome twin of the web editor's t.BPM header switch */
function mountTbpmSwitch(anchor: HTMLElement, handle: ModelerHandle): void {
  const action = tbpmToggleAction(handle.raw as never);
  const label = document.createElement("label");
  label.id = "tbpm";
  label.title = action.buttonTitle;
  const text = document.createElement("span");
  text.textContent = action.label;
  const sw = document.createElement("button");
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.append(document.createElement("span"));
  const sync = (): void => sw.setAttribute("aria-checked", String(action.isActive?.() ?? false));
  sw.onclick = () => action.run();
  action.onChanged?.(sync);
  sync();
  label.append(text, sw);
  anchor.before(label);
}
