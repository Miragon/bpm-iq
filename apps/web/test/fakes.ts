/**
 * DOM-free fakes for the widget core suites: an engine that records imports
 * and exports and can fire user edits, a scripted Live-Host bridge, a chrome
 * that records every port call and can click banner actions, a claim that can
 * supersede, and a live upgrade that resolves whatever the test decides.
 * Real timers with fast timing knobs — no mocked clock to forget to advance.
 */
import type { LiveBindHooks, WidgetEngine } from "../src/mcp-app/core/engine.ts";
import type {
  BannerAction,
  ChromePort,
  ClaimDocument,
  DocRef,
  LiveHandle,
  LiveHooks,
  LiveUpgrade,
  LoadedModel,
  ModelBridge,
  ModelInput,
  SaveResult,
} from "../src/mcp-app/core/lifecycle.ts";

export const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** fast enough for a suite, slow enough that ordering stays observable */
export const TIMING = { autosaveMs: 10, flushDeadlineMs: 200, flushPollMs: 5 };

export interface FakeEngine extends WidgetEngine {
  imported: string[];
  exports: number;
  log: string[];
  fire: { dirty(): void };
  /** the hooks the last bindLive received (live mode) */
  bound?: LiveBindHooks;
  unbound: number;
}

export function fakeEngine(o: { editable?: boolean; live?: boolean; importFails?: () => boolean } = {}): FakeEngine {
  const dirtyCbs = new Set<() => void>();
  const engine: FakeEngine = {
    editable: o.editable ?? true,
    imported: [],
    exports: 0,
    log: [],
    unbound: 0,
    async importText(text) {
      engine.log.push("importText");
      if (o.importFails?.()) throw new Error("bad import");
      engine.imported.push(text);
    },
    async exportText() {
      engine.exports++;
      return `canvas#${engine.exports}`;
    },
    onDirty(cb) {
      dirtyCbs.add(cb);
      return () => dirtyCbs.delete(cb);
    },
    selectedElementId: () => undefined,
    destroy() {},
    fire: {
      dirty: () => {
        for (const cb of dirtyCbs) cb();
      },
    },
  };
  if (o.live !== false) {
    engine.bindLive = (_ytext, _doc, hooks) => {
      engine.bound = hooks;
      return () => {
        engine.unbound++;
      };
    };
  }
  return engine;
}

export interface FakeBridge {
  bridge: ModelBridge;
  loads: ModelInput[];
  saves: Array<{ doc: DocRef; content: string; baseVersion: string }>;
  saved: DocRef[];
  /** script the next loads / saves (default: a happy round-trip) */
  onLoad(f: () => Promise<LoadedModel>): void;
  onSave(f: (n: number) => Promise<SaveResult>): void;
}

export function fakeBridge(): FakeBridge {
  let loadResult: () => Promise<LoadedModel> = async () => ({
    path: "processes/a.owm",
    content: "v1",
    baseVersion: "b1",
  });
  let saveResult: (n: number) => Promise<SaveResult> = async (n) => ({
    ok: true,
    path: "processes/a.owm",
    baseVersion: `b${n + 1}`,
    warnings: [],
  });
  const f: FakeBridge = {
    loads: [],
    saves: [],
    saved: [],
    bridge: {
      async load(input) {
        f.loads.push(input);
        return loadResult();
      },
      async save(doc, content, baseVersion) {
        f.saves.push({ doc, content, baseVersion });
        return saveResult(f.saves.length);
      },
      saved(doc) {
        f.saved.push(doc);
      },
    },
    onLoad: (fn) => {
      loadResult = fn;
    },
    onSave: (fn) => {
      saveResult = fn;
    },
  };
  return f;
}

export interface FakeChrome {
  port: ChromePort;
  status: string[];
  tooltips: string[];
  titles: string[];
  dirty: boolean[];
  saveButton: Array<{ visible?: boolean; enabled?: boolean }>;
  openVisible: boolean[];
  banners: Array<{ text: string; actions: BannerAction[] }>;
  hidden: number;
  /** the current banner's labels ([] when hidden) */
  bannerLabels(): string[];
  /** run the current banner's action by label */
  click(label: string): void;
  last(): string | undefined;
}

export function fakeChrome(): FakeChrome {
  let current: { text: string; actions: BannerAction[] } | undefined;
  const c: FakeChrome = {
    status: [],
    tooltips: [],
    titles: [],
    dirty: [],
    saveButton: [],
    openVisible: [],
    banners: [],
    hidden: 0,
    port: {
      setTitle: (t) => void c.titles.push(t),
      setStatus: (text, tooltip) => {
        c.status.push(text);
        if (tooltip !== undefined) c.tooltips.push(tooltip);
      },
      setDirty: (d) => void c.dirty.push(d),
      setSaveButton: (s) => void c.saveButton.push(s),
      setOpenVisible: (v) => void c.openVisible.push(v),
      showBanner: (text, actions) => {
        current = { text, actions };
        c.banners.push(current);
      },
      hideBanner: () => {
        current = undefined;
        c.hidden++;
      },
    },
    bannerLabels: () => current?.actions.map((a) => a.label) ?? [],
    click: (label) => {
      const action = current?.actions.find((a) => a.label === label);
      if (!action) throw new Error(`no banner action '${label}' (banner: ${current?.text ?? "hidden"})`);
      action.run();
    },
    last: () => c.status[c.status.length - 1],
  };
  return c;
}

export interface FakeClaim {
  claim: ClaimDocument;
  keys: string[];
  releases: number;
  /** a newer widget took the document */
  supersede(): void;
}

export function fakeClaim(): FakeClaim {
  let onSuperseded: (() => void) | undefined;
  const f: FakeClaim = {
    keys: [],
    releases: 0,
    claim: (key, cb) => {
      f.keys.push(key);
      onSuperseded = cb;
      return () => {
        f.releases++;
      };
    },
    supersede: () => onSuperseded?.(),
  };
  return f;
}

export interface FakeLive {
  live: LiveUpgrade;
  calls: DocRef[];
  hooks?: LiveHooks;
  handles: Array<{ destroyed: number; snapshot: string }>;
  /** what the next upgrade resolves: a handle (with this snapshot) or
   *  undefined; `delayMs` = the socket connect time before the sync arrives
   *  (a test can edit the canvas in between) */
  next: { handle: boolean; snapshot?: string; awaitBeforeBind?: boolean; delayMs?: number };
}

export function fakeLive(next: FakeLive["next"] = { handle: true }): FakeLive {
  const f: FakeLive = {
    calls: [],
    handles: [],
    next,
    live: async (doc, engine, hooks) => {
      f.calls.push(doc);
      f.hooks = hooks;
      if (f.next.delayMs) await tick(f.next.delayMs);
      if (f.next.awaitBeforeBind !== false) {
        const proceed = await hooks.beforeBind();
        if (!proceed) return undefined;
      }
      if (!f.next.handle) return undefined;
      const state = { destroyed: 0, snapshot: f.next.snapshot ?? "v1" };
      f.handles.push(state);
      engine.bindLive(undefined as never, undefined as never, {
        onConflict: hooks.onConflict,
        onImportError: hooks.onImportError,
      });
      const handle: LiveHandle = {
        snapshot: () => state.snapshot,
        destroy: () => {
          state.destroyed++;
        },
      };
      return handle;
    },
  };
  return f;
}
