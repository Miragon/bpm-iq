/**
 * The STRUCTURED live-doc lane end to end (epic #118 step 8), DARK-LAUNCHED:
 * no shipped notation is structured, so the codec is INJECTED (the house
 * jsonLinesCodec on a .board-pretending .tt path) and the whole pipeline —
 * seed from canonical text, element edits, write-through, stale-seed drop,
 * restart-restore, CAS + element-wise reconcile over REST — runs against a
 * REAL Hocuspocus server exactly like content.test.ts does for text rooms.
 *
 * Release/history coverage is INHERENT, not separate: both read the
 * workspace FILE, and the write-through test pins that the file always holds
 * the canonical line-per-element encoding — a release PR of a structured doc
 * therefore diffs line-per-element by construction.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { ELEMENTS_KEY } from "@bpmiq/contracts/live";
import { readSnapshot, reconcileSnapshot } from "@bpmiq/live-client/structured";
import { jsonLinesCodec } from "@bpmiq/notations/codecs";
import { Server } from "@hocuspocus/server";
import * as Y from "yjs";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { type ContentDeps, getContent, putContent } from "../src/application/content.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import { loadContentConfig } from "../src/repos/content.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};
const PATH = "processes/board.md"; // an EDITABLE extension without a baseline gate; the codec injection makes it structured
const ROOM = `${REPO.fullName}/${PATH}`;
const codec = jsonLinesCodec();
const docCodec = (path: string) => (path === PATH ? codec : undefined);

const BOARD = {
  meta: { title: "Order flow" },
  elements: {
    e1: { type: "command", text: "Place order", x: 20 },
    e2: { type: "event", text: "Order placed", x: 100 },
  },
};
const CANONICAL = codec.encode(BOARD);

const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.destroy()));
  setTimeout(() => process.exit(), 2000).unref();
});

/** tmpdir content repo + real Hocuspocus with the INJECTED structured codec */
function setup(existing?: { ws: string; db: DatabaseSync }) {
  const ws = existing?.ws ?? mkdtempSync(join(tmpdir(), "bpm-structured-"));
  if (!existing) {
    mkdirSync(join(ws, "processes"), { recursive: true });
    writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
    writeFileSync(join(ws, PATH), CANONICAL);
  }
  const db = existing?.db ?? new DatabaseSync(":memory:");
  const lineage = new LineageStore(db, REPO.fullName);
  const registry = { get: (n: string) => (n.toLowerCase() === REPO.fullName ? REPO : undefined) };
  const workspaces = { ensure: async () => ws };
  const hp = new Server({
    ...makeCollabHooks({
      lineage,
      docGuard: new DocSizeGuard(8_000_000),
      maxDocBytes: 8_000_000,
      sessions: { get: () => undefined },
      access: { canWrite: async () => true },
      registry,
      workspaces,
      contentConfig: loadContentConfig,
      devToken: () => undefined,
      liveDocs: new Set(),
      docCodec,
    }),
  });
  servers.push(hp);
  const deps: ContentDeps = {
    registry,
    workspaces,
    openDoc: (room) => hp.hocuspocus.openDirectConnection(room),
    maxDocBytes: 8_000_000,
    docCodec,
  };
  return { ws, db, deps, hp, lineage };
}

/** peer-open with the same open-during-unload retry the use-case applies —
 *  Hocuspocus can hand out a doc whose async unload is still in flight
 *  (content.test.ts precedent; a raw open here hangs the suite) */
async function openPeer(hp: Server, room: string) {
  for (let i = 0; ; i++) {
    const conn = await hp.hocuspocus.openDirectConnection(room);
    if (!conn.document?.isDestroyed) return conn;
    await conn.disconnect().catch(() => undefined);
    if (i >= 3) throw new Error(`room is stuck unloading: ${room}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("seed: the canonical text populates the element maps; write-through re-encodes it", async () => {
  const { ws, hp } = setup();
  const conn = await openPeer(hp, ROOM);
  await conn.transact((doc: Y.Doc) => {
    assert.deepEqual(readSnapshot(doc), BOARD, "seeded element-wise from the canonical text");
    // a live element edit — one attribute
    (doc.getMap(ELEMENTS_KEY).get("e1") as Y.Map<unknown>).set("x", 42);
  });
  await conn.disconnect(); // forces the store hook (write-through)
  const onDisk = await readFile(join(ws, PATH), "utf8");
  const expected = codec.encode({ ...BOARD, elements: { ...BOARD.elements, e1: { ...BOARD.elements.e1, x: 42 } } });
  assert.equal(onDisk, expected, "the file is the canonical encoding — one element line changed");
});

test("restart: the lineage restores an edited board", async () => {
  const first = setup();
  const conn = await openPeer(first.hp, ROOM);
  await conn.transact((doc: Y.Doc) => {
    (doc.getMap(ELEMENTS_KEY).get("e2") as Y.Map<unknown>).set("text", "Order confirmed");
  });
  await conn.disconnect();
  const second = setup({ ws: first.ws, db: first.db });
  const conn2 = await openPeer(second.hp, ROOM);
  await conn2.transact((doc: Y.Doc) => {
    assert.equal(readSnapshot(doc).elements.e2?.text, "Order confirmed", "edit survived the restart");
  });
  await conn2.disconnect();
});

test("kill -9 after write-through: lineage LOST, the board reseeds from the edited canonical", async () => {
  // the true crash case: edits written through to the file, live.db gone —
  // a fresh db must rebuild the board from the canonical text alone
  const first = setup();
  const conn = await openPeer(first.hp, ROOM);
  await conn.transact((doc: Y.Doc) => {
    (doc.getMap(ELEMENTS_KEY).get("e1") as Y.Map<unknown>).set("text", "Edited before crash");
  });
  await conn.disconnect(); // write-through lands the canonical on disk
  const revived = setup({ ws: first.ws, db: new DatabaseSync(":memory:") }); // live.db is gone
  const conn2 = await openPeer(revived.hp, ROOM);
  await conn2.transact((doc: Y.Doc) => {
    assert.equal(readSnapshot(doc).elements.e1?.text, "Edited before crash", "reseeded from the edited canonical");
  });
  await conn2.disconnect();
});

test("a stale UNEDITED structured seed re-seeds from the changed file", async () => {
  // the eager-persist scenario: a seed-marked row exists (no client ever
  // edited — built directly, since any store clears the marker), then the
  // workspace file changes out of band before the next open
  const { ws, hp, lineage } = setup();
  const seedDoc = new Y.Doc();
  reconcileSnapshot(seedDoc, codec.decode(CANONICAL));
  lineage.saveSeed(ROOM, Y.encodeStateAsUpdate(seedDoc));
  const changed = codec.encode({ meta: { title: "Rewritten" }, elements: {} });
  writeFileSync(join(ws, PATH), changed);

  const conn = await openPeer(hp, ROOM);
  await conn.transact((doc: Y.Doc) => {
    const snapshot = readSnapshot(doc);
    assert.equal(snapshot.meta.title, "Rewritten", "stale structured seed was dropped and re-seeded");
    assert.deepEqual(snapshot.elements, {}, "no duplicated elements from the dead seed");
  });
  await conn.disconnect();
});

test("REST: getContent serves the canonical text; putContent CAS-gates and reconciles element-wise", async () => {
  const { deps, hp } = setup();
  const got = await getContent(deps, REPO, PATH);
  assert.equal(got.xml, CANONICAL);

  // a co-editor moves e2 AFTER the read — the agent's token is now stale
  const conn = await openPeer(hp, ROOM);
  await conn.transact((doc: Y.Doc) => {
    (doc.getMap(ELEMENTS_KEY).get("e2") as Y.Map<unknown>).set("x", 500);
  });
  await conn.disconnect();
  const stale = await putContent(deps, REPO, PATH, {
    xml: codec.encode({ ...BOARD, meta: { title: "Stale write" } }),
    baseVersion: got.baseVersion,
  });
  assert.ok(!stale.ok, "a stale token must conflict");
  assert.match(stale.ok ? "" : stale.conflict.currentXml, /"x":500/, "the conflict carries the current canonical");

  // fresh read → whole-board save that renames e1: reconcile touches ONLY e1
  const fresh = await getContent(deps, REPO, PATH);
  const renamed = codec.decode(fresh.xml);
  renamed.elements.e1 = { ...renamed.elements.e1, text: "Submit order" };
  const saved = await putContent(deps, REPO, PATH, { xml: codec.encode(renamed), baseVersion: fresh.baseVersion });
  assert.ok(saved.ok);
  const after = await getContent(deps, REPO, PATH);
  const snapshot = codec.decode(after.xml);
  assert.equal(snapshot.elements.e1?.text, "Submit order");
  assert.equal(snapshot.elements.e2?.x, 500, "the co-editor's move survived the whole-board save");
  assert.equal(after.baseVersion, saved.ok ? saved.result.baseVersion : "", "the returned token matches the doc");
});

test("a non-canonical (but decodable) payload normalizes — token matches the canonical state", async () => {
  const { deps } = setup();
  const got = await getContent(deps, REPO, PATH);
  // same board, scrambled key order and a garbage line — decode is total
  const messy = `garbage line\n{"meta":{"title":"Order flow"},"version":1,"format":"bpmiq-structured"}\n{"x":20,"id":"e1","text":"Place order","type":"command"}\n{"id":"e2","type":"event","text":"Order placed","x":100}\n`;
  const saved = await putContent(deps, REPO, PATH, { xml: messy, baseVersion: got.baseVersion });
  assert.ok(saved.ok);
  const after = await getContent(deps, REPO, PATH);
  assert.equal(after.xml, CANONICAL, "the doc holds the canonical form, not the messy payload");
  assert.equal(saved.ok ? saved.result.baseVersion : "", after.baseVersion);
});
