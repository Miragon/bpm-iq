/**
 * The ONE widget lifecycle — the BPMN widget's state machine (load → lazy
 * engine mount → dirty tracking → debounced CAS autosave → conflict banner →
 * newest-widget claim → progressive live upgrade → post-outage reconcile)
 * MOVED out of main.ts behind ports, so every canvas notation's widget runs
 * the same code (#156) and the node --test suite drives it without a DOM.
 * DOM-free: the only runtime import is roomName; `.ts`-extension relative
 * imports and no "@/" alias, or node cannot load it.
 *
 * The move is verbatim except for this substitution table (review the diff
 * with `git diff -M --color-moved=dimmed-zebra`):
 *  - the chrome DOM writes → ChromePort calls (setTitle / setStatus(+tooltip)
 *    / setDirty / setSaveButton / setOpenVisible / showBanner / hideBanner)
 *  - `modeler: ModelerHandle` → `engine: E`; `todos` → `extras` (WidgetExtras)
 *  - `ref: ProcessRef` → TWO latches: `input` (the tool input, set at load
 *    START — hasLoaded) and `ref: DocRef` (set only once the load's IMPORT
 *    has landed, cleared at load start). The types force it, and a save()
 *    racing a re-load — its bridge read OR its import — now bails on `!ref`
 *    instead of PUTting the old canvas against the incoming document.
 *  - getBpmnXml / saveBpmnXml / updateModelContext → bridge.load / save / saved
 *  - tryLive(app, ref, modeler, hooks) → deps.live(ref, engine, hooks), guarded
 *    by `engine.bindLive` (a capability) and the presence of a live port
 *  - claimDocument → deps.claim; AUTOSAVE_MS / 10_000 / 100 → deps.timing
 *  - liveHooks gains onImportError (the DSL/JSON binds report it; bpmn never)
 *  - `cfg.readonly`, the deep link, the icon font and the button handlers
 *    live in widget.ts (the DOM composition)
 * Everything else is unchanged on purpose — latch names and order, every
 * `epoch !== liveEpoch || inactive` re-check after an await, clearTimeout
 * BEFORE the scheduleAutosave gate, autosavePaused + clearTimeout BEFORE the
 * conflict banner, the finally re-arm on `editSeq !== seq`, the
 * `!dirty && baseVersion === fresh.baseVersion` re-import guard, the
 * byte-equal `fresh.content === replica` reconcile, the banner and status
 * texts. Each of them is a race that was fixed once; keep them.
 */
import { roomName } from "@bpmiq/contracts/live";

import type { LiveEngine, WidgetEngine } from "./engine.ts";

/** tool input: the document to open. `id` resolves SERVER-side (the bridge
 *  adds the widget's notation, so a stem shared with a .bpmn opens THIS
 *  notation's file); extra tool args (a DMN scenario, one day) ride along
 *  untouched. */
export interface ModelInput extends Record<string, unknown> {
  repo: string;
  id?: string;
  path?: string;
}
/** the document the widget OWNS — the path the load resolved */
export interface DocRef {
  repo: string;
  path: string;
}
export interface LoadedModel {
  path: string;
  content: string;
  baseVersion: string;
}
export interface SaveOk {
  ok: true;
  path: string;
  baseVersion: string;
  warnings: string[];
  /** ERROR findings — present on lint:"warn" saves, where they inform */
  errors?: string[];
}
/** a retryable RESULT, never a throw (mcp.ts conflictResult) */
export interface SaveConflict {
  ok: false;
  conflict: true;
  path: string;
  currentContent: string;
  baseVersion: string;
  message: string;
}
export type SaveResult = SaveOk | SaveConflict;

/** the Live Host as the lifecycle sees it (widget.ts binds it to the app
 *  bridge: get_model_content / save_model_content / ui/update-model-context) */
export interface ModelBridge {
  load(input: ModelInput): Promise<LoadedModel>;
  /** CAS save, lint:"warn" — findings inform, never block */
  save(doc: DocRef, content: string, baseVersion: string): Promise<SaveResult>;
  /** tell the host's model the live state moved — it re-reads instead of
   *  trusting stale text */
  saved(doc: DocRef): void;
}

export interface LiveHandle {
  destroy(): void;
  /** the room state this session last knew (its local Y.Text replica) — the
   *  post-death reconcile compares it byte-for-byte with a fresh bridge read */
  snapshot(): string;
}
export interface LiveHooks {
  /** overlapping concurrent edit — the remote change won (model-sync rule 4) */
  onConflict(message: string): void;
  /** a remote snapshot did not import — the binds that take the parameter
   *  report it; bpmn's never does */
  onImportError(message: string): void;
  /** runs after sync, before the first Yjs import replaces the canvas — flush
   *  unsaved state through the bridge here; false aborts the upgrade */
  beforeBind(): Promise<boolean>;
  /** the ESTABLISHED session died: any ws drop is final, because the
   *  auto-reconnect re-sends the consumed single-use ticket and can never
   *  re-authenticate; fires at most once per session */
  onDead(): void;
}
/** the progressive upgrade (live.ts tryLive bound to the bridge) — undefined
 *  when this host cannot go live; the caller stays on autosave */
export type LiveUpgrade = (doc: DocRef, engine: LiveEngine, hooks: LiveHooks) => Promise<LiveHandle | undefined>;

/** newest-widget-wins claim (bridge.ts claimDocument); returns the release */
export type ClaimDocument = (key: string, onSuperseded: () => void) => () => void;

export interface BannerAction {
  label: string;
  danger?: boolean;
  run(): void;
}
/** the chrome as the lifecycle sees it — one method per DOM write the BPMN
 *  widget used to make (the table in the header); the DOM adapter is widget.ts */
export interface ChromePort {
  setTitle(text: string): void;
  /** `tooltip` = the findings list (status.title) — written ONLY when given
   *  (main.ts touched status.title only in showFindings) */
  setStatus(text: string, tooltip?: string): void;
  setDirty(dirty: boolean): void;
  setSaveButton(state: { visible?: boolean; enabled?: boolean }): void;
  /** the adapter ANDs the deep-link base in — no publicUrl, no button */
  setOpenVisible(visible: boolean): void;
  showBanner(text: string, actions: BannerAction[]): void;
  hideBanner(): void;
}

/** notation-only chrome mounted ONCE after the engine and BEFORE the first
 *  import (bpmn: todos + the t.BPM switch — the todo canvas re-renders its
 *  badges on every import.done, the live re-imports included) */
export interface WidgetExtras {
  /** the document now open (+ the tool input it came from) — after every
   *  successful load import */
  onDocument(doc: DocRef, input: ModelInput): void;
  /** superseded by a newer widget — tear down; never called twice */
  destroy(): void;
}

export interface LifecycleDeps<E extends WidgetEngine> {
  readonly: boolean;
  /** status copy: "Loading <noun>…" (bpmn passes "model" — today's strings) */
  noun: string;
  /** lazy: the engine mounts on the FIRST load only (the container is the caller's) */
  mountEngine: () => E;
  bridge: ModelBridge;
  /** absent = never attempt the upgrade (a host without tickets) */
  live?: LiveUpgrade;
  claim: ClaimDocument;
  chrome: ChromePort;
  extras?: (engine: E) => WidgetExtras;
  /** test seams — production keeps the defaults (1500 / 10_000 / 100) */
  timing?: { autosaveMs?: number; flushDeadlineMs?: number; flushPollMs?: number };
}

export interface LifecycleState {
  dirty: boolean;
  live: boolean;
  inactive: boolean;
  /** a banner owns the next step — autosave and flushOnLeave are paused */
  paused: boolean;
  saving: boolean;
  baseVersion: string;
}

export interface WidgetLifecycle<E extends WidgetEngine> {
  /** a (re)delivered tool input — bumps the epoch, releases the old claim,
   *  tears down live state, timers and banners, then owns the widget */
  load(input: ModelInput): Promise<void>;
  /** the manual "Save now" — the same save() the autosave timer runs */
  save(): Promise<void>;
  /** "Open in bpmiq" leaves the chat: `if (dirty && !live) void save()` —
   *  paused under a banner on purpose (the banner owns the divergence decision) */
  flushOnLeave(): void;
  /** true once tool input arrived (set at load START) — wireApp's no-input guard */
  hasLoaded(): boolean;
  /** the document this widget owns — undefined until the load lands */
  document(): DocRef | undefined;
  engine(): E | undefined;
  state(): LifecycleState;
}

export const AUTOSAVE_MS = 1500;
export const FLUSH_DEADLINE_MS = 10_000;
export const FLUSH_POLL_MS = 100;

export function createWidgetLifecycle<E extends WidgetEngine>(deps: LifecycleDeps<E>): WidgetLifecycle<E> {
  const { chrome, bridge } = deps;
  const autosaveMs = deps.timing?.autosaveMs ?? AUTOSAVE_MS;
  const flushDeadlineMs = deps.timing?.flushDeadlineMs ?? FLUSH_DEADLINE_MS;
  const flushPollMs = deps.timing?.flushPollMs ?? FLUSH_POLL_MS;

  let engine: E | undefined;
  let extras: WidgetExtras | undefined; // notation chrome (bpmn: todos) — absent for the others
  let input: ModelInput | undefined; // tool input arrived — set at load START (hasLoaded)
  let ref: DocRef | undefined; // the document this load OWNS — cleared while a load is in flight
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
    chrome.setDirty(d);
  };

  // ── autosave: the widget behaves like a live room — every pause in modelling
  // persists; findings inform, never block. Paused while a conflict banner is up
  // (the timer must not race the user's decision).
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
    }, autosaveMs);
  }

  /** non-blocking findings display — errors/warnings live in the status line */
  function showFindings(errors: string[] | undefined, warnings: string[]): void {
    const parts: string[] = ["Saved"];
    if (errors?.length) parts.push(`${errors.length} validation error${errors.length > 1 ? "s" : ""}`);
    if (warnings.length) parts.push(`${warnings.length} warning${warnings.length > 1 ? "s" : ""}`);
    chrome.setStatus(parts.join(" · "), [...(errors ?? []), ...warnings].join("\n"));
  }

  async function load(next: ModelInput): Promise<void> {
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
    chrome.hideBanner();
    autosavePaused = false;
    input = next;
    // `input` names the INCOMING document while the canvas still shows the old
    // one — no deep link (and no flush, no save) until the load owns the widget
    ref = undefined;
    chrome.setOpenVisible(false);
    chrome.setStatus(`Loading ${deps.noun}…`);
    const loaded = await bridge.load(next);
    if (epoch !== liveEpoch || inactive) return; // a newer load owns the widget
    chrome.setTitle(`${next.repo} · ${loaded.path}`);
    baseVersion = loaded.baseVersion;
    if (!engine) {
      engine = deps.mountEngine();
      engine.onDirty(() => {
        if (live) return; // Yjs already persisted the change
        editSeq++;
        setDirty(true);
        scheduleAutosave();
      });
      chrome.setSaveButton({ visible: engine.editable });
      // notation chrome, bound BEFORE the first import (bpmn: the todo canvas
      // re-renders its badges on every `import.done`, incl. the live re-imports)
      extras = deps.extras?.(engine);
    }
    await engine.importText(loaded.content);
    if (epoch !== liveEpoch || inactive) return; // a newer load owns the widget
    // the load OWNS the widget from here: only now may a save PUT against this
    // document (an edit racing the import above found no `ref` and bailed)
    ref = { repo: next.repo, path: loaded.path };
    // a loaded model has a web address — even for a later-superseded instance
    // the deep link stays the most useful remaining control
    chrome.setOpenVisible(true);
    setDirty(false);
    // the extras of THIS document — a failing/absent tracker never blocks the model
    extras?.onDocument({ repo: next.repo, path: loaded.path }, next);
    releaseClaim = deps.claim(roomName(next.repo, loaded.path), () => {
      inactive = true;
      clearTimeout(autosaveTimer);
      live?.destroy();
      live = undefined;
      extras?.destroy();
      extras = undefined;
      chrome.showBanner("This document was opened in a newer widget — this instance is now inactive.", []);
      chrome.setSaveButton({ enabled: false });
    });
    chrome.setStatus(deps.readonly ? "Read-only view" : "Ready — changes save automatically");

    // progressive upgrade to the live Yjs session (the web SPA's co-editing
    // path): on success autosave retires — the CRDT persists every edit and
    // remote changes appear as they happen. Any failure leaves autosave on.
    // beforeBind (flushForLive) persists unsaved canvas state before the first
    // Yjs import may replace the canvas.
    if (engine.editable) await upgradeToLive();
  }

  /** attempt the live upgrade; on success autosave retires (timer cleared,
   *  save button hidden). Unsaved canvas state is safe: tryLive's beforeBind
   *  flushes it before the first Yjs import. Failure leaves autosave on. */
  async function upgradeToLive(): Promise<void> {
    if (!engine || !ref || !engine.editable || inactive || live || upgradingLive) return;
    // live is a capability: an engine without a binding (or a host without
    // tickets) stays on CAS autosave — the DMN widget's deliberate mode
    if (!engine.bindLive || !deps.live) return;
    upgradingLive = true;
    const epoch = liveEpoch;
    try {
      const handle = await deps.live(ref, engine as E & LiveEngine, liveHooks());
      if (!handle) return;
      if (inactive || epoch !== liveEpoch || live) {
        // superseded or re-loaded while connecting (the claim callback / the
        // next load ran before `live` was assigned) — tear the session down
        handle.destroy();
        return;
      }
      live = handle;
      clearTimeout(autosaveTimer);
      chrome.setSaveButton({ visible: false });
      setDirty(false);
      chrome.setStatus("Live — co-editing enabled, changes sync instantly");
    } finally {
      upgradingLive = false;
    }
  }

  /** hooks shared by every live upgrade attempt (initial load + reconnects) */
  function liveHooks(): LiveHooks {
    return {
      onConflict: (msg) => chrome.setStatus(`Sync conflict: ${msg}`),
      onImportError: (msg) => chrome.setStatus(`Live import failed: ${msg}`),
      beforeBind: flushForLive,
      onDead: () => void onLiveDead(),
    };
  }

  /** the first Yjs import replaces the canvas — flush unsaved state through the
   *  normal CAS save first so nothing is lost; false aborts the upgrade */
  async function flushForLive(): Promise<boolean> {
    const deadline = Date.now() + flushDeadlineMs;
    while (!inactive && !autosavePaused && (saving || dirty)) {
      if (Date.now() > deadline) {
        // give up on the UPGRADE only — autosave keeps retrying the edit
        scheduleAutosave();
        return false;
      }
      if (!saving) await save();
      await new Promise((r) => setTimeout(r, flushPollMs));
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
    if (inactive || !engine || !ref) return;
    const doc = ref;
    chrome.setStatus("Live sync lost — reconnecting…");
    // gate edits made during the reconcile: a save against the pre-death token
    // would be refused anyway (the live session moved the version) and its
    // conflict banner would fight the reconcile's own banner
    autosavePaused = true;
    clearTimeout(autosaveTimer);
    let fresh: LoadedModel;
    try {
      fresh = await bridge.load({ repo: doc.repo, path: doc.path });
    } catch {
      if (epoch !== liveEpoch || inactive) return;
      // even the bridge is down: keep the stale token — the next save's CAS
      // conflict banner hands the decision to the user
      autosavePaused = false;
      editSeq++;
      setDirty(true);
      chrome.setSaveButton({ visible: true });
      chrome.setStatus("Live sync lost — changes save automatically");
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
            await engine.importText(fresh.content);
          } catch {
            // unimportable snapshot — let the user decide instead of guessing
            if (epoch !== liveEpoch || inactive) return;
            autosavePaused = true;
            chrome.setSaveButton({ visible: true });
            onLiveInterrupted(fresh);
            return;
          }
          if (epoch !== liveEpoch || inactive) return;
          setDirty(false);
        } else if (dirty) {
          scheduleAutosave();
        }
        chrome.setSaveButton({ visible: true });
        chrome.setStatus("Live sync lost — changes save automatically");
      }
      return;
    }
    // the room moved during the outage (a colleague), local edits never reached
    // it, or both — direction-blind, so the USER decides; never overwrite
    // either side silently
    chrome.setSaveButton({ visible: true });
    onLiveInterrupted(fresh); // keeps autosavePaused=true — the banner owns it
  }

  /** post-outage divergence banner — mirrors the CAS conflict flow: the banner
   *  owns the next step, autosavePaused until a choice is made */
  function onLiveInterrupted(fresh: { content: string; baseVersion: string }): void {
    const epoch = liveEpoch; // a re-load invalidates these closures wholesale
    chrome.setStatus("Live sync interrupted");
    chrome.showBanner("Live sync was interrupted and the server state differs from this canvas.", [
      {
        label: "Load server version",
        run: () => {
          if (epoch !== liveEpoch || inactive) return;
          void (async () => {
            chrome.hideBanner();
            try {
              await engine?.importText(fresh.content);
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
            chrome.setStatus("Reloaded — changes save automatically");
            void upgradeToLive();
          })();
        },
      },
      {
        label: "Keep my canvas",
        danger: true,
        run: () => {
          if (epoch !== liveEpoch || inactive) return;
          chrome.hideBanner();
          baseVersion = fresh.baseVersion;
          autosavePaused = false;
          editSeq++;
          setDirty(true);
          chrome.setStatus("Keeping this canvas — autosave will overwrite the server version");
          scheduleAutosave();
        },
      },
    ]);
  }

  async function save(textOverride?: string, versionOverride?: string, seqOverride?: number): Promise<void> {
    if (!engine || !ref || inactive || saving || live || autosavePaused) return;
    const doc = ref;
    saving = true;
    clearTimeout(autosaveTimer);
    chrome.setSaveButton({ enabled: false });
    // an override replays an EARLIER serialization — pair it with the seq from
    // that moment, or a mid-flight edit would be marked saved without being sent
    const seq = seqOverride ?? editSeq;
    const epoch = liveEpoch; // a re-load mid-flight orphans this save entirely
    try {
      const text = textOverride ?? (await engine.exportText());
      // re-loaded during the serialization: the widget now names a NEW
      // document — never PUT the old canvas there
      if (epoch !== liveEpoch) return;
      chrome.setStatus("Saving…");
      // no validate preflight: lint:"warn" saves like a live room and reports
      // findings on the result — one round-trip, nothing blocks
      const result = await bridge.save(doc, text, versionOverride ?? baseVersion);
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
      // tell the model the live state moved — it re-reads instead of trusting stale text
      bridge.saved(doc);
    } catch (err) {
      // transient (token expiry, network): keep the model, retry on next change
      if (epoch === liveEpoch) chrome.setStatus(`Autosave failed: ${(err as Error).message} — retrying on next change`);
    } finally {
      saving = false;
      chrome.setSaveButton({ enabled: true });
      // an edit made while this save was in flight is NOT in the payload just
      // sent — its own timer may also have fired into the `saving` guard above,
      // so re-arm here or it would sit unsaved behind a false "Saved"
      if (epoch === liveEpoch && editSeq !== seq) scheduleAutosave();
    }
  }

  function onConflict(conflict: SaveConflict, myText: string, mySeq: number): void {
    const epoch = liveEpoch; // a re-load invalidates these closures wholesale
    chrome.setStatus("Conflict — autosave paused");
    chrome.showBanner("Someone saved this model in the meantime.", [
      {
        label: "Load their version",
        run: () => {
          if (epoch !== liveEpoch || inactive) return;
          void (async () => {
            chrome.hideBanner();
            try {
              await engine?.importText(conflict.currentContent);
            } catch {
              // their snapshot didn't import (e.g. transiently invalid mid-edit
              // text) — keep MY canvas and hand the decision back
              if (epoch !== liveEpoch || inactive) return;
              onConflict(conflict, myText, mySeq);
              return;
            }
            if (epoch !== liveEpoch || inactive) return;
            baseVersion = conflict.baseVersion;
            setDirty(false);
            autosavePaused = false;
            chrome.setStatus("Reloaded");
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
          chrome.hideBanner();
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
          chrome.hideBanner();
          baseVersion = conflict.baseVersion;
          autosavePaused = false;
          chrome.setStatus("Editing on — autosave will overwrite their version");
          scheduleAutosave();
        },
      },
    ]);
  }

  /** "Open in bpmiq": a still-unsaved edit follows in parallel — REST saves
   *  land in the very live document the opened web editor joins (in live mode
   *  Yjs has already persisted everything). While a conflict/interrupted
   *  banner is up, save() stays paused on purpose — the opened editor then
   *  shows the SERVER version and the banner keeps owning the decision. */
  function flushOnLeave(): void {
    if (dirty && !live) void save();
  }

  return {
    load,
    save: () => save(),
    flushOnLeave,
    hasLoaded: () => input !== undefined,
    document: () => ref,
    engine: () => engine,
    state: () => ({ dirty, live: live !== undefined, inactive, paused: autosavePaused, saving, baseVersion }),
  };
}
