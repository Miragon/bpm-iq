/**
 * tryLive (src/mcp-app/core/live.ts) against a fake session: the progressive
 * upgrade must resolve undefined on every failure path and hand out exactly
 * one death per established session.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import type { LiveEngine } from "../src/mcp-app/core/engine.ts";
import type { LiveHooks } from "../src/mcp-app/core/lifecycle.ts";
import { type LiveDeps, type LiveSessionLike, tryLive } from "../src/mcp-app/core/live.ts";
import { fakeEngine, tick } from "./fakes.ts";

function fakeSession() {
  const doc = new Y.Doc();
  const content = doc.getText("content");
  content.insert(0, "v1");
  const synced: Array<() => void> = [];
  const disconnected: Array<() => void> = [];
  const closed: Array<() => void> = [];
  let authFailed: (() => void) | undefined;
  const s = {
    destroyed: 0,
    session: {
      doc,
      content,
      onSynced: (cb: () => void) => {
        synced.push(cb);
        return () => {};
      },
      onDisconnect: (cb: () => void) => {
        disconnected.push(cb);
        return () => {};
      },
      onDocClose: (cb: () => void) => {
        closed.push(cb);
        return () => {};
      },
      destroy: () => {
        s.destroyed++;
      },
    } satisfies LiveSessionLike,
    sync: () => synced.forEach((cb) => cb()),
    drop: () => disconnected.forEach((cb) => cb()),
    close: () => closed.forEach((cb) => cb()),
    failAuth: () => authFailed?.(),
    open: (opts: { onAuthenticationFailed?: () => void }) => {
      authFailed = opts.onAuthenticationFailed;
      return s.session;
    },
  };
  return s;
}

function hooks(o: { beforeBind?: () => Promise<boolean> } = {}) {
  const h = {
    deaths: 0,
    conflicts: [] as string[],
    hooks: {
      onConflict: (m: string) => void h.conflicts.push(m),
      onImportError: () => {},
      beforeBind: o.beforeBind ?? (async () => true),
      onDead: () => {
        h.deaths++;
      },
    } satisfies LiveHooks,
  };
  return h;
}

const TICKET = { ticket: "t", url: "ws://live.test", room: "acme/models/processes/a.owm", expiresInSeconds: 60 };
const deps = (s: ReturnType<typeof fakeSession>, over: Partial<LiveDeps> = {}): LiveDeps => ({
  mint: async () => TICKET,
  open: s.open as never,
  syncTimeoutMs: 30,
  ...over,
});
const liveEngine = (): LiveEngine & ReturnType<typeof fakeEngine> =>
  fakeEngine() as LiveEngine & ReturnType<typeof fakeEngine>;

test("mint rejects → undefined, the session is never opened", async () => {
  const s = fakeSession();
  let opened = 0;
  const out = await tryLive(
    {
      mint: async () => {
        throw new Error("Tool mint_ws_ticket not found");
      },
      open: () => {
        opened++;
        return s.session;
      },
    },
    liveEngine(),
    hooks().hooks,
  );
  assert.equal(out, undefined);
  assert.equal(opened, 0);
});

test("no sync within the timeout → undefined and the session is destroyed", async () => {
  const s = fakeSession();
  const out = await tryLive(deps(s), liveEngine(), hooks().hooks);
  assert.equal(out, undefined);
  assert.equal(s.destroyed, 1);
});

test("sync, then beforeBind refuses → undefined; a drop DURING the flush aborts too", async () => {
  const s = fakeSession();
  const p = tryLive(deps(s), liveEngine(), hooks({ beforeBind: async () => false }).hooks);
  await tick(1); // the mint resolves first — only then is the session opened
  s.sync();
  assert.equal(await p, undefined);
  assert.equal(s.destroyed, 1);

  const s2 = fakeSession();
  const h = hooks({
    beforeBind: async () => {
      s2.drop();
      return true;
    },
  });
  const p2 = tryLive(deps(s2), liveEngine(), h.hooks);
  await tick(1);
  s2.sync();
  assert.equal(await p2, undefined);
  assert.equal(h.deaths, 0, "a pre-establish break is an abort, not a death");
});

test("happy path: the engine is bound after the flush; deaths fire once; destroy is silent", async () => {
  const s = fakeSession();
  const engine = liveEngine();
  const h = hooks();
  const p = tryLive(deps(s), engine, h.hooks);
  await tick(1); // the mint resolves first — only then is the session opened
  s.sync();
  const handle = await p;
  assert.ok(handle);
  assert.ok(engine.bound, "bindLive received the session's hooks");
  assert.equal(handle.snapshot(), "v1");
  engine.bound?.onConflict("overlap");
  assert.deepEqual(h.conflicts, ["overlap"]);
  // a second sync (the provider re-syncing) never re-binds
  s.sync();
  await tick(5);
  // any drop after establish IS the death — exactly once
  s.drop();
  s.drop();
  s.close();
  assert.equal(h.deaths, 1);
  // a deliberate teardown unbinds and never reports a death
  const s3 = fakeSession();
  const e3 = liveEngine();
  const h3 = hooks();
  const p3 = tryLive(deps(s3), e3, h3.hooks);
  await tick(1);
  s3.sync();
  const handle3 = await p3;
  handle3!.destroy();
  assert.equal(e3.unbound, 1);
  assert.equal(s3.destroyed, 1);
  s3.drop();
  assert.equal(h3.deaths, 0);
});

test("authentication failure: before establish → undefined; after → one death", async () => {
  const s = fakeSession();
  const p = tryLive(deps(s), liveEngine(), hooks().hooks);
  await tick(1);
  s.failAuth();
  assert.equal(await p, undefined);

  const s2 = fakeSession();
  const h = hooks();
  const p2 = tryLive(deps(s2), liveEngine(), h.hooks);
  await tick(1);
  s2.sync();
  await p2;
  s2.failAuth();
  s2.failAuth();
  assert.equal(h.deaths, 1);
});
