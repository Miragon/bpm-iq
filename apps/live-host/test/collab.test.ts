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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
