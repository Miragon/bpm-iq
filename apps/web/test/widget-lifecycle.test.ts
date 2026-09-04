/**
 * The widget core's state machine (src/mcp-app/core/lifecycle.ts) driven
 * DOM-free through its ports — the CAS autosave, the conflict banner, the
 * live upgrade and the post-outage reconcile, each branch the BPMN widget
 * fixed once and every canvas widget now shares.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createWidgetLifecycle, type LifecycleDeps } from "../src/mcp-app/core/lifecycle.ts";
import { fakeBridge, fakeChrome, fakeClaim, type FakeEngine, fakeEngine, fakeLive, tick, TIMING } from "./fakes.ts";

const REPO = "acme/models";

function setup(o: { engine?: FakeEngine; live?: ReturnType<typeof fakeLive> | null; readonly?: boolean } = {}) {
  const engine = o.engine ?? fakeEngine({ editable: !(o.readonly ?? false) });
  const bridge = fakeBridge();
  const chrome = fakeChrome();
  const claim = fakeClaim();
  const live = o.live === null ? undefined : (o.live ?? fakeLive({ handle: false }));
  const extras = { docs: [] as string[], destroyed: 0, mountedAt: -1 };
  const deps: LifecycleDeps<FakeEngine> = {
    readonly: o.readonly ?? false,
    noun: "model",
    mountEngine: () => {
      engine.log.push("mountEngine");
      return engine;
    },
    bridge: bridge.bridge,
    live: live?.live,
    claim: claim.claim,
    chrome: chrome.port,
    extras: (e) => {
      extras.mountedAt = e.log.length;
      e.log.push("extras");
      return {
        onDocument: (doc) => void extras.docs.push(doc.path),
        destroy: () => {
          extras.destroyed++;
        },
      };
    },
    timing: TIMING,
  };
  const lc = createWidgetLifecycle(deps);
  return { lc, engine, bridge, chrome, claim, live, extras };
}

test("load: bridge read → engine mounted once → extras before the first import → claim → ready → live attempted", async () => {
  const { lc, engine, bridge, chrome, claim, live, extras } = setup();
  assert.equal(lc.hasLoaded(), false);
  await lc.load({ repo: REPO, id: "a" });
  assert.deepEqual(bridge.loads, [{ repo: REPO, id: "a" }]);
  assert.deepEqual(engine.log, ["mountEngine", "extras", "importText"]);
  assert.deepEqual(engine.imported, ["v1"]);
  assert.deepEqual(extras.docs, ["processes/a.owm"]);
  assert.deepEqual(claim.keys, [`${REPO}/processes/a.owm`]);
  assert.deepEqual(chrome.titles, [`${REPO} · processes/a.owm`]);
  assert.deepEqual(chrome.openVisible, [false, true]);
  assert.deepEqual(chrome.status, ["Loading model…", "Ready — changes save automatically"]);
  assert.deepEqual(chrome.saveButton, [{ visible: true }]);
  assert.deepEqual(lc.document(), { repo: REPO, path: "processes/a.owm" });
  assert.equal(lc.hasLoaded(), true);
  assert.deepEqual(live?.calls, [{ repo: REPO, path: "processes/a.owm" }]);
  // a second load re-imports without re-mounting
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(engine.log.filter((l) => l === "mountEngine").length, 1);
  assert.equal(engine.imported.length, 2);
});

test("read-only: no save button, no live attempt, a second load re-imports without re-mounting", async () => {
  const { lc, engine, chrome, live } = setup({ readonly: true });
  await lc.load({ repo: REPO, id: "a" });
  assert.deepEqual(chrome.saveButton, [{ visible: false }]);
  assert.equal(chrome.last(), "Read-only view");
  assert.equal(live?.calls.length, 0);
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(engine.log.filter((l) => l === "mountEngine").length, 1);
  assert.equal(engine.imported.length, 2);
});

test("an engine without bindLive (or no live port) never attempts the upgrade", async () => {
  const a = setup({ engine: fakeEngine({ live: false }) });
  await a.lc.load({ repo: REPO, id: "a" });
  assert.equal(a.live?.calls.length, 0);
  assert.equal(a.chrome.last(), "Ready — changes save automatically");
  const b = setup({ live: null });
  await b.lc.load({ repo: REPO, id: "a" });
  assert.equal(b.chrome.last(), "Ready — changes save automatically");
});

test("autosave: an edit saves after the debounce, findings inform, the token advances", async () => {
  const { lc, engine, bridge, chrome } = setup();
  bridge.onSave(async () => ({ ok: true, path: "processes/a.owm", baseVersion: "v2", warnings: ["w1"] }));
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  assert.equal(lc.state().dirty, true);
  assert.equal(bridge.saves.length, 0, "nothing saved before the debounce");
  await tick(TIMING.autosaveMs * 4);
  assert.deepEqual(bridge.saves, [
    { doc: { repo: REPO, path: "processes/a.owm" }, content: "canvas#1", baseVersion: "b1" },
  ]);
  assert.equal(lc.state().dirty, false);
  assert.equal(chrome.last(), "Saved · 1 warning");
  assert.deepEqual(chrome.tooltips, ["w1"]);
  assert.equal(bridge.saved.length, 1);
  // the next save carries the advanced token
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 4);
  assert.equal(bridge.saves[1]?.baseVersion, "v2");
});

test("a mid-flight edit stays dirty and a second save follows with the new export", async () => {
  const { lc, engine, bridge } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  bridge.onSave(async (n) => {
    if (n === 1) await gate;
    return { ok: true, path: "processes/a.owm", baseVersion: `v${n + 1}`, warnings: [] };
  });
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(bridge.saves.length, 1);
  engine.fire.dirty(); // while the first save is pending
  release();
  await tick(TIMING.autosaveMs * 4);
  assert.equal(bridge.saves.length, 2, "the finally re-arm persisted the mid-flight edit");
  assert.equal(bridge.saves[1]?.content, "canvas#2");
  assert.equal(lc.state().dirty, false);
});

test("exportText rejects → autosave reports and retries on the next edit", async () => {
  const engine = fakeEngine();
  let fail = true;
  engine.exportText = async () => {
    if (fail) throw new Error("empty model");
    return "canvas#ok";
  };
  const { lc, bridge, chrome } = setup({ engine });
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 0);
  assert.equal(chrome.last(), "Autosave failed: empty model — retrying on next change");
  fail = false;
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves[0]?.content, "canvas#ok");
});

test("conflict: the banner owns the next step — load theirs / overwrite / keep editing", async () => {
  const { lc, engine, bridge, chrome } = setup();
  let conflict = true;
  bridge.onSave(async (n) =>
    conflict
      ? {
          ok: false,
          conflict: true,
          path: "processes/a.owm",
          currentContent: "<theirs>",
          baseVersion: "v9",
          message: "moved",
        }
      : { ok: true, path: "processes/a.owm", baseVersion: `v${n + 10}`, warnings: [] },
  );
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(lc.state().paused, true);
  assert.equal(chrome.last(), "Conflict — autosave paused");
  assert.deepEqual(chrome.bannerLabels(), ["Load their version", "Overwrite anyway", "Keep editing"]);
  assert.equal(chrome.banners[0]?.actions[1]?.danger, true);
  // an edit while the banner is up saves NOTHING
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 1);

  // load theirs: import, adopt their token, clean
  conflict = false;
  chrome.click("Load their version");
  await tick(TIMING.autosaveMs);
  assert.equal(engine.imported.at(-1), "<theirs>");
  assert.equal(lc.state().dirty, false);
  assert.equal(chrome.last(), "Reloaded");
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.at(-1)?.baseVersion, "v9", "the next save uses their token");

  // an unimportable snapshot re-shows the SAME banner and touches nothing
  conflict = true;
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  const before = lc.state().baseVersion;
  engine.importText = async () => {
    throw new Error("bad");
  };
  chrome.click("Load their version");
  await tick(TIMING.autosaveMs);
  assert.deepEqual(chrome.bannerLabels(), ["Load their version", "Overwrite anyway", "Keep editing"]);
  assert.equal(lc.state().baseVersion, before);

  // overwrite anyway: resend MY text against the fresh token, immediately
  conflict = false;
  const myText = bridge.saves.at(-1)!.content;
  chrome.click("Overwrite anyway");
  await tick(TIMING.autosaveMs);
  assert.deepEqual(bridge.saves.at(-1), {
    doc: { repo: REPO, path: "processes/a.owm" },
    content: myText,
    baseVersion: "v9",
  });
  assert.equal(lc.state().paused, false);

  // keep editing: adopt their token, a save follows WITHOUT a new edit
  conflict = true;
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  conflict = false;
  const n = bridge.saves.length;
  chrome.click("Keep editing");
  assert.equal(chrome.last(), "Editing on — autosave will overwrite their version");
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, n + 1);
  assert.equal(bridge.saves.at(-1)?.baseVersion, "v9");
});

test("live upgrade: the flush lands before the bind, autosave retires, edits stop saving", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, engine, bridge, chrome } = setup({ live });
  // an edit is pending when the upgrade's beforeBind runs: it must be flushed first
  engine.fire.dirty(); // before load — ignored (no engine yet), just noise
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(lc.state().live, true);
  assert.ok(chrome.saveButton.some((s) => s.visible === false));
  assert.equal(chrome.last(), "Live — co-editing enabled, changes sync instantly");
  assert.ok(engine.bound, "the engine was bound to the live session");
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 0, "live mode: Yjs persists, no CAS save");
  engine.bound?.onImportError("x");
  assert.equal(chrome.last(), "Live import failed: x");
});

test("live upgrade: an edit made while the socket connects is flushed BEFORE the bind", async () => {
  const live = fakeLive({ handle: true, delayMs: TIMING.autosaveMs * 3 });
  const { lc, engine, bridge } = setup({ live });
  const loading = lc.load({ repo: REPO, id: "a" });
  await tick(TIMING.autosaveMs); // imported, the upgrade is waiting for the sync
  engine.fire.dirty();
  await loading;
  assert.equal(lc.state().live, true);
  assert.equal(bridge.saves.length, 1, "the pending edit reached the server before Yjs replaced the canvas");
  assert.equal(lc.state().dirty, false);
});

test("live upgrade: when the flush cannot land, the upgrade gives up after the deadline and autosave stays", async () => {
  const live = fakeLive({ handle: true, delayMs: TIMING.autosaveMs * 3 });
  const { lc, engine, bridge, chrome } = setup({ live });
  bridge.onSave(async () => {
    throw new Error("net");
  });
  const loading = lc.load({ repo: REPO, id: "a" });
  await tick(TIMING.autosaveMs);
  const t0 = Date.now();
  engine.fire.dirty();
  await loading;
  assert.equal(lc.state().live, false, "the flush never cleared — no bind on top of unsaved state");
  assert.ok(Date.now() - t0 >= TIMING.flushDeadlineMs, "gave up only at the deadline, not on the first failure");
  assert.ok(bridge.saves.length >= 5, "kept retrying until the deadline");
  assert.equal(lc.state().dirty, true);
  assert.match(chrome.last() ?? "", /Autosave failed/);
});

test("onDead, byte-equal: resume live; if that fails, re-import the fresh state and go back to autosave", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, engine, bridge, chrome } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(lc.state().live, true);
  // the server holds exactly the replica; the next upgrade fails → re-import + autosave
  bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v1", baseVersion: "b7" }));
  live.next = { handle: false };
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(bridge.loads.length, 2, "reconciled against a fresh read");
  assert.equal(lc.state().baseVersion, "b7");
  assert.equal(lc.state().live, false);
  assert.equal(engine.imported.at(-1), "v1", "the clean canvas was reconciled to the fresh state");
  assert.equal(chrome.last(), "Live sync lost — changes save automatically");
  assert.ok(chrome.saveButton.at(-1)?.visible);
});

test("onDead, diverged: the interrupted banner decides — load server version or keep my canvas", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, engine, bridge, chrome } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v2-by-a-colleague", baseVersion: "b8" }));
  live.next = { handle: false };
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(chrome.last(), "Live sync interrupted");
  assert.deepEqual(chrome.bannerLabels(), ["Load server version", "Keep my canvas"]);
  assert.equal(lc.state().paused, true);
  chrome.click("Load server version");
  await tick(TIMING.autosaveMs);
  assert.equal(engine.imported.at(-1), "v2-by-a-colleague");
  assert.equal(lc.state().baseVersion, "b8");
  assert.equal(lc.state().paused, false);
  // the other branch: re-establish live (a re-load upgrades again), die
  // diverged once more, keep MY canvas
  live.next = { handle: true, snapshot: "v2-by-a-colleague" };
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(lc.state().live, true);
  bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v3", baseVersion: "b9" }));
  live.next = { handle: false };
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs * 2);
  assert.deepEqual(chrome.bannerLabels(), ["Load server version", "Keep my canvas"]);
  chrome.click("Keep my canvas");
  assert.equal(chrome.last(), "Keeping this canvas — autosave will overwrite the server version");
  assert.equal(lc.state().dirty, true);
  assert.equal(lc.state().paused, false);
  assert.equal(lc.state().baseVersion, "b9");
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.at(-1)?.baseVersion, "b9", "the canvas overwrote the server version");
});

test("onDead with the bridge down: keep the stale token, autosave, let CAS decide", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, engine, bridge, chrome } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  bridge.onLoad(async () => {
    throw new Error("bridge down");
  });
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs);
  assert.equal(lc.state().paused, false);
  assert.equal(lc.state().dirty, true);
  assert.equal(chrome.last(), "Live sync lost — changes save automatically");
  bridge.onSave(async () => ({ ok: true, path: "processes/a.owm", baseVersion: "b2", warnings: [] }));
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.at(-1)?.baseVersion, "b1", "the PRE-death token — the CAS conflict decides");
  void engine;
});

test("superseded by a newer widget: inactive for good", async () => {
  const live = fakeLive({ handle: true });
  const { lc, engine, bridge, chrome, claim, extras } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  claim.supersede();
  assert.equal(lc.state().inactive, true);
  assert.equal(live.handles[0]?.destroyed, 1);
  assert.equal(extras.destroyed, 1);
  assert.deepEqual(chrome.bannerLabels(), []);
  assert.deepEqual(chrome.saveButton.at(-1), { enabled: false });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 0);
  await lc.load({ repo: REPO, id: "b" });
  assert.equal(engine.imported.length, 1, "a later load bails after its read");
});

test("re-load races: the newer load owns the widget, the old claim is released first", async () => {
  const { lc, engine, bridge, claim } = setup();
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => (releaseA = r));
  let n = 0;
  bridge.onLoad(async () => {
    n++;
    if (n === 1) {
      await gateA;
      return { path: "processes/a.owm", content: "A", baseVersion: "bA" };
    }
    return { path: "processes/b.owm", content: "B", baseVersion: "bB" };
  });
  const a = lc.load({ repo: REPO, id: "a" });
  assert.equal(lc.document(), undefined, "no document while a load is in flight");
  const b = lc.load({ repo: REPO, id: "b" });
  releaseA();
  await Promise.all([a, b]);
  assert.deepEqual(engine.imported, ["B"]);
  assert.deepEqual(lc.document(), { repo: REPO, path: "processes/b.owm" });
  assert.deepEqual(claim.keys, [`${REPO}/processes/b.owm`]);
  assert.equal(claim.releases, 0, "nothing to release before the first claim landed");
  await lc.load({ repo: REPO, id: "b" });
  assert.equal(claim.releases, 1, "the previous claim is released before the next");
});

test("flushOnLeave saves a dirty canvas — never while paused or live", async () => {
  const { lc, engine, bridge, chrome } = setup();
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  lc.flushOnLeave();
  await tick(TIMING.autosaveMs);
  assert.equal(bridge.saves.length, 1);
  // paused under a conflict banner
  bridge.onSave(async () => ({
    ok: false,
    conflict: true,
    path: "p",
    currentContent: "t",
    baseVersion: "v",
    message: "m",
  }));
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(lc.state().paused, true);
  lc.flushOnLeave();
  await tick(TIMING.autosaveMs);
  assert.equal(bridge.saves.length, 2);
  void chrome;
});

test("mountEngine throws → the load fails loudly, no claim, a second load retries the mount", async () => {
  const engine = fakeEngine();
  let fail = true;
  const { lc, claim } = setup({ engine });
  const deps = { mount: 0 };
  // wrap the mount: fail once
  const original = engine.log;
  void original;
  const lcFailing = createWidgetLifecycle<FakeEngine>({
    readonly: false,
    noun: "model",
    mountEngine: () => {
      deps.mount++;
      if (fail) throw new Error("engine broke");
      return engine;
    },
    bridge: fakeBridge().bridge,
    claim: claim.claim,
    chrome: fakeChrome().port,
    timing: TIMING,
  });
  await assert.rejects(() => lcFailing.load({ repo: REPO, id: "a" }), /engine broke/);
  assert.equal(claim.keys.length, 0);
  fail = false;
  await lcFailing.load({ repo: REPO, id: "a" });
  assert.equal(deps.mount, 2);
  assert.equal(engine.imported.length, 1);
  void lc;
});

test("an edit racing a re-load's import never saves against the incoming document", async () => {
  const { lc, engine, bridge } = setup();
  await lc.load({ repo: REPO, id: "a" });
  let releaseImport!: () => void;
  const gate = new Promise<void>((r) => (releaseImport = r));
  const realImport = engine.importText.bind(engine);
  engine.importText = async (text) => {
    await gate; // the incoming document is still parsing…
    return realImport(text);
  };
  bridge.onLoad(async () => ({ path: "processes/b.owm", content: "B", baseVersion: "bB" }));
  const reload = lc.load({ repo: REPO, id: "b" });
  await tick(TIMING.autosaveMs);
  assert.equal(lc.document(), undefined, "no document while the import is in flight");
  engine.fire.dirty(); // …while the user still edits the OLD canvas
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 0, "nothing PUT against processes/b.owm");
  releaseImport();
  await reload;
  assert.deepEqual(lc.document(), { repo: REPO, path: "processes/b.owm" });
  assert.equal(lc.state().dirty, false, "the landed load owns a clean canvas");
});
