/**
 * Collaboration hooks (src/application/collab.ts) — the Hocuspocus room
 * lifecycle, called directly with minimal fake payloads (no server boot, no
 * websocket). Registry/workspace fakes follow the established inline style
 * (test/rooms.test.ts); the lineage store runs on an in-memory SQLite.
 *
 * The heart of it: restore-vs-seed. A persisted lineage must be RESTORED and
 * never re-seeded on top — the historic every-character-duplicates bug class.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import * as Y from "yjs";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import type { Session } from "../src/adapters/sqlite/sessions.ts";
import { type CollabDeps, makeCollabHooks } from "../src/application/collab.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};
const ROOM = "acme/models/processes/order/order.bpmn";

const session = (login = "petra"): Session => ({
  id: `sess-${login}`,
  user: { login, name: login, avatarUrl: null, provider: "github" },
  providerToken: "user-token",
  createdAt: Date.now(),
});

/** a tmpdir workspace + fully-injected deps; overrides mirror server.ts wiring */
function setup(over: Partial<CollabDeps> = {}) {
  const ws = mkdtempSync(join(tmpdir(), "bpm-collab-"));
  mkdirSync(join(ws, "processes", "order"), { recursive: true });
  const deps: CollabDeps = {
    lineage: new LineageStore(new DatabaseSync(":memory:"), REPO.fullName),
    docGuard: new DocSizeGuard(8_000_000),
    maxDocBytes: 8_000_000,
    sessions: { get: () => undefined },
    access: { canWrite: async () => true },
    registry: { get: (n) => (n.toLowerCase() === REPO.fullName ? REPO : undefined) },
    workspaces: { ensure: async () => ws },
    contentConfig: () => ({ processes: "processes" }),
    devToken: () => undefined,
    liveDocs: new Set<string>(),
    ...over,
  };
  return { ws, deps, hooks: makeCollabHooks(deps) };
}

// ── onAuthenticate ──────────────────────────────────────────────────────────

test("onAuthenticate: session with write access passes, without is refused", async () => {
  const s = session();
  const { hooks } = setup({ sessions: { get: (id) => (id === s.id ? s : undefined) } });
  const ctx = await hooks.onAuthenticate({ token: s.id, documentName: ROOM });
  assert.equal(ctx.user.login, "petra");

  const denied = setup({
    sessions: { get: () => s },
    access: { canWrite: async () => false },
  });
  await assert.rejects(() => denied.hooks.onAuthenticate({ token: s.id, documentName: ROOM }), /no write access/);
});

test("onAuthenticate: dev token grants headless access; anything else is invalid", async () => {
  const { hooks } = setup({ devToken: () => "demo" });
  const ctx = await hooks.onAuthenticate({ token: "demo", documentName: ROOM });
  assert.equal(ctx.user.login, "dev-token");
  await assert.rejects(() => hooks.onAuthenticate({ token: "wrong", documentName: ROOM }), /invalid session/);
  // malformed/unknown rooms are rejected BEFORE any token is considered
  await assert.rejects(
    () => hooks.onAuthenticate({ token: "demo", documentName: "stranger/repo/x.bpmn" }),
    /not a connected repository/,
  );
});

// ── onLoadDocument: restore vs seed ─────────────────────────────────────────

test("onLoadDocument: a persisted lineage is restored, NOT re-seeded on top (char-duplication bug class)", async () => {
  const { ws, deps, hooks } = setup();
  writeFileSync(join(ws, "processes", "order", "order.bpmn"), "<bpmn from disk/>");

  // a previous run persisted this lineage — its content DIFFERS from the file
  const previous = new Y.Doc();
  previous.getText("content").insert(0, "<bpmn from lineage/>");
  deps.lineage.save(ROOM, Y.encodeStateAsUpdate(previous));

  const doc = new Y.Doc();
  await hooks.onLoadDocument({ document: doc, documentName: ROOM });
  // restored exactly — the workspace file must NOT have been inserted on top
  assert.equal(doc.getText("content").toString(), "<bpmn from lineage/>");
});

test("onLoadDocument: no lineage → seeds once from the workspace file", async () => {
  const { ws, hooks } = setup();
  writeFileSync(join(ws, "processes", "order", "order.bpmn"), "<bpmn from disk/>");

  const doc = new Y.Doc();
  await hooks.onLoadDocument({ document: doc, documentName: ROOM });
  assert.equal(doc.getText("content").toString(), "<bpmn from disk/>");
});

test("onLoadDocument: the seed is persisted EAGERLY — a host death before the debounced store must not re-seed (#103)", async () => {
  const { ws, deps, hooks } = setup();
  const content = "<bpmn from disk/>";
  writeFileSync(join(ws, "processes", "order", "order.bpmn"), content);

  // first load seeds from the workspace file …
  const server1 = new Y.Doc();
  await hooks.onLoadDocument({ document: server1, documentName: ROOM });
  // … and the lineage row must exist NOW, not only after the debounced
  // onStoreDocument (which a dying host never reaches)
  assert.ok(deps.lineage.load(ROOM), "seed persisted in onLoadDocument itself");

  // a browser tab syncs the seeded doc and keeps holding it in memory
  const browser = new Y.Doc();
  Y.applyUpdate(browser, Y.encodeStateAsUpdate(server1));

  // the host dies without ever reaching onStoreDocument, then restarts:
  // the next load must RESTORE the eager row (not seed a second time) …
  await hooks.afterUnloadDocument({ documentName: ROOM });
  const server2 = new Y.Doc();
  await hooks.onLoadDocument({ document: server2, documentName: ROOM });
  // … so the tab's auto-reconnect push merges cleanly instead of duplicating
  Y.applyUpdate(server2, Y.encodeStateAsUpdate(browser));

  assert.equal(server2.getText("content").toString(), content, "content must not grow on reconnect");
});

test("onLoadDocument: a never-edited seed row is REPLACED when the workspace file changed out of band (no stale pinning)", async () => {
  // in-place host checkout: no reconcile/reset path ever drops lineage there, so
  // without the stale-seed check a view-only open would pin the file's content
  // in live.db forever and the next edit would overwrite out-of-band updates
  const { ws, hooks } = setup();
  const file = join(ws, "processes", "order", "order.bpmn");
  writeFileSync(file, "<bpmn v1/>");

  // view-only session: seed (persisted eagerly), then the tab closes
  await hooks.onLoadDocument({ document: new Y.Doc(), documentName: ROOM });
  await hooks.afterUnloadDocument({ documentName: ROOM });

  // the operator updates the file out of band (git pull, editor, an agent)
  writeFileSync(file, "<bpmn v2 out-of-band/>");

  const doc = new Y.Doc();
  await hooks.onLoadDocument({ document: doc, documentName: ROOM });
  assert.equal(doc.getText("content").toString(), "<bpmn v2 out-of-band/>", "the fresh file wins over a pure seed");
});

test("onLoadDocument: an EDITED row wins over an out-of-band file change (client history is irreplaceable)", async () => {
  const { ws, hooks } = setup();
  const file = join(ws, "processes", "order", "order.bpmn");
  writeFileSync(file, "<bpmn v1/>");

  const doc = new Y.Doc();
  await hooks.onLoadDocument({ document: doc, documentName: ROOM });
  doc.getText("content").insert(0, "edited: ");
  await hooks.onStoreDocument({ document: doc, documentName: ROOM }); // clears the seed marker
  await hooks.afterUnloadDocument({ documentName: ROOM });

  writeFileSync(file, "<bpmn v2 out-of-band/>");

  const reopened = new Y.Doc();
  await hooks.onLoadDocument({ document: reopened, documentName: ROOM });
  assert.equal(reopened.getText("content").toString(), "edited: <bpmn v1/>", "edited lineage is never dropped");
});

test("onLoadDocument: an over-cap workspace file is seeded but never persisted (durable footprint stays bounded)", async () => {
  const { ws, deps, hooks } = setup({ docGuard: new DocSizeGuard(10), maxDocBytes: 10 });
  const big = "definitely more than ten bytes of content";
  writeFileSync(join(ws, "processes", "order", "order.bpmn"), big);

  const doc = new Y.Doc();
  await hooks.onLoadDocument({ document: doc, documentName: ROOM });
  assert.equal(doc.getText("content").toString(), big, "the room itself still opens");
  assert.equal(deps.lineage.load(ROOM), undefined, "oversized seed must never reach SQLite");
});

test("onLoadDocument: throws for a missing file (room validated, nothing registered)", async () => {
  const { deps, hooks } = setup();
  await assert.rejects(
    () => hooks.onLoadDocument({ document: new Y.Doc(), documentName: "acme/models/processes/ghost.bpmn" }),
    /no such file/,
  );
  // a failed load must leak neither a live room nor a guard entry
  assert.equal(deps.liveDocs.size, 0);
  assert.equal(deps.docGuard.tracked, 0);
});

test("onLoadDocument: rooms outside the configured processes folder are refused", async () => {
  const { ws, hooks } = setup();
  writeFileSync(join(ws, "notes.md"), "outside the processes folder");
  await assert.rejects(
    () => hooks.onLoadDocument({ document: new Y.Doc(), documentName: "acme/models/notes.md" }),
    /outside the configured processes folder/,
  );
});

test("onLoadDocument: a repo without bpmiq.yml has no live rooms at all", async () => {
  const { ws, hooks } = setup({ contentConfig: () => undefined });
  writeFileSync(join(ws, "processes", "order", "order.bpmn"), "<bpmn/>");
  await assert.rejects(
    () => hooks.onLoadDocument({ document: new Y.Doc(), documentName: ROOM }),
    /not a BPM content repo/,
  );
});

test("onLoadDocument: a *.bpmn symlink escaping the checkout is refused (no arbitrary host read)", async () => {
  // a symlink inside the processes folder pointing outside the checkout passes
  // the lexical containment but must be caught by resolveRoom's realpath guard
  const { ws, hooks } = setup();
  const outside = mkdtempSync(join(tmpdir(), "bpm-collab-out-"));
  writeFileSync(join(outside, "secret"), "not-yours");
  symlinkSync(join(outside, "secret"), join(ws, "processes", "order", "pwn.bpmn"));
  await assert.rejects(
    () =>
      hooks.onLoadDocument({
        document: new Y.Doc(),
        documentName: "acme/models/processes/order/pwn.bpmn",
      }),
    /symlink/,
  );
});

// ── liveDocs + docGuard symmetry ────────────────────────────────────────────

test("load registers liveDocs + guard; afterUnloadDocument removes both (symmetry)", async () => {
  const { ws, deps, hooks } = setup();
  writeFileSync(join(ws, "processes", "order", "order.bpmn"), "<bpmn/>");

  await hooks.onLoadDocument({ document: new Y.Doc(), documentName: ROOM });
  assert.ok(deps.liveDocs.has(ROOM));
  assert.equal(deps.docGuard.tracked, 1);

  await hooks.afterUnloadDocument({ documentName: ROOM });
  assert.ok(!deps.liveDocs.has(ROOM));
  assert.equal(deps.docGuard.tracked, 0);
});

// ── onStoreDocument: the size cap ───────────────────────────────────────────

test("onStoreDocument under the cap persists lineage + writes through to the file", async () => {
  const { ws, deps, hooks } = setup();
  writeFileSync(join(ws, "processes", "order", "order.bpmn"), "<stale/>");

  const doc = new Y.Doc();
  doc.getText("content").insert(0, "<bpmn v2/>");
  await hooks.onStoreDocument({ document: doc, documentName: ROOM });
  assert.ok(deps.lineage.load(ROOM), "lineage persisted");
  assert.equal(await readFile(join(ws, "processes", "order", "order.bpmn"), "utf8"), "<bpmn v2/>");
});

test("onStoreDocument above the cap skips persist + write-through but still re-anchors the guard", async () => {
  const guard = new DocSizeGuard(10);
  const { ws, deps, hooks } = setup({ docGuard: guard, maxDocBytes: 10 });
  writeFileSync(join(ws, "processes", "order", "order.bpmn"), "<original/>");

  const doc = new Y.Doc();
  doc.getText("content").insert(0, "definitely more than ten bytes of content");
  await hooks.onStoreDocument({ document: doc, documentName: ROOM });

  assert.equal(deps.lineage.load(ROOM), undefined, "oversized doc must never reach SQLite");
  assert.equal(
    await readFile(join(ws, "processes", "order", "order.bpmn"), "utf8"),
    "<original/>",
    "oversized doc must never reach the workspace file",
  );
  // re-anchored: the guard now knows the doc's true (over-cap) size — a 1-byte
  // update is refused. Without the stored() re-anchor its estimate would be 0
  // and this admit would pass.
  assert.equal(
    guard.admit(ROOM, 1, () => Y.encodeStateAsUpdate(doc).length),
    false,
  );
});

// ── beforeHandleMessage: ingest-side cap ────────────────────────────────────

test("beforeHandleMessage rejects when the guard rejects, passes small updates", async () => {
  const { hooks } = setup({ docGuard: new DocSizeGuard(10), maxDocBytes: 10 });
  const doc = new Y.Doc();
  await hooks.beforeHandleMessage({ documentName: ROOM, document: doc, update: new Uint8Array(3) });
  await assert.rejects(
    () => hooks.beforeHandleMessage({ documentName: ROOM, document: doc, update: new Uint8Array(50) }),
    /update rejected — document is at the 10B cap/,
  );
});
