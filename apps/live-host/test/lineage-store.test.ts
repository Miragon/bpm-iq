/**
 * LineageStore (src/adapters/sqlite/lineage-store.ts) — Yjs lineage persistence
 * on an in-memory SQLite. The critical property is the GUARDED one-time
 * multi-repo migration: it must prefix legacy rows exactly once, and NEVER
 * re-run (re-prefixing legitimate rooms whose owner is "processes"/"landscape"/
 * "docs" — the historic crash class on the PRIMARY KEY).
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";

const HOST = "acme/host-repo";

function names(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM documents ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
}

test("save/load round-trip; load of an unknown room is undefined", () => {
  const db = new DatabaseSync(":memory:");
  const store = new LineageStore(db, HOST);
  assert.equal(store.load("acme/repo/processes/x.bpmn"), undefined);
  const state = new Uint8Array([1, 2, 3, 255]);
  store.save("acme/repo/processes/x.bpmn", state);
  assert.deepEqual([...(store.load("acme/repo/processes/x.bpmn") ?? [])], [1, 2, 3, 255]);
  // upsert: saving again replaces, never duplicates
  store.save("acme/repo/processes/x.bpmn", new Uint8Array([9]));
  assert.deepEqual([...(store.load("acme/repo/processes/x.bpmn") ?? [])], [9]);
});

test("drop removes a persisted lineage", () => {
  const db = new DatabaseSync(":memory:");
  const store = new LineageStore(db, HOST);
  store.save("acme/repo/docs/readme.md", new Uint8Array([7]));
  store.drop("acme/repo/docs/readme.md");
  assert.equal(store.load("acme/repo/docs/readme.md"), undefined);
});

test("seed flag: saveSeed marks, the first real save clears — in the row itself (crash-atomic)", () => {
  const db = new DatabaseSync(":memory:");
  const store = new LineageStore(db, HOST);
  const room = "acme/repo/processes/x.bpmn";
  assert.equal(store.isSeed(room), false, "unknown room is not a seed");
  store.saveSeed(room, new Uint8Array([1]));
  assert.equal(store.isSeed(room), true);
  store.save(room, new Uint8Array([2]));
  assert.equal(store.isSeed(room), false, "a real store clears the flag");
  store.drop(room);
  store.saveSeed(room, new Uint8Array([3]));
  assert.equal(store.isSeed(room), true, "re-seeding after a drop marks again");
});

test("legacy live.db without the seed column gains it; old rows count as edited (never droppable)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, state BLOB)");
  db.prepare("INSERT INTO documents (name, state) VALUES (?, ?)").run("processes/order/order.bpmn", Buffer.from([1]));

  const store = new LineageStore(db, HOST);
  assert.equal(store.isSeed(`${HOST}/processes/order/order.bpmn`), false);
  assert.deepEqual([...(store.load(`${HOST}/processes/order/order.bpmn`) ?? [])], [1]);
  new LineageStore(db, HOST); // idempotent on the migrated schema
});

test("migration prefixes pre-multi-repo rows with the host repo — once", () => {
  const db = new DatabaseSync(":memory:");
  // legacy layout: bare repo-relative room names (pre-multi-repo), no meta flag
  db.exec("CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, state BLOB)");
  db.prepare("INSERT INTO documents (name, state) VALUES (?, ?)").run("processes/order/order.bpmn", Buffer.from([1]));
  db.prepare("INSERT INTO documents (name, state) VALUES (?, ?)").run(
    "landscape/value-chain.vc.json",
    Buffer.from([2]),
  );
  db.prepare("INSERT INTO documents (name, state) VALUES (?, ?)").run("docs/method.md", Buffer.from([3]));

  new LineageStore(db, HOST);
  assert.deepEqual(names(db), [
    `${HOST}/docs/method.md`,
    `${HOST}/landscape/value-chain.vc.json`,
    `${HOST}/processes/order/order.bpmn`,
  ]);
});

test("migration idempotence: constructing twice never re-prefixes rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, state BLOB)");
  db.prepare("INSERT INTO documents (name, state) VALUES (?, ?)").run("processes/order/order.bpmn", Buffer.from([1]));

  new LineageStore(db, HOST);
  const afterFirst = names(db);
  // a legitimate MULTI-repo room whose owner happens to be "processes" — an
  // unguarded second migration would prefix this one too (and eventually crash
  // on the PRIMARY KEY when two rows collide)
  const store = new LineageStore(db, HOST);
  store.save("processes/models/processes/p.bpmn", new Uint8Array([4]));
  new LineageStore(db, HOST);

  assert.deepEqual(names(db), [...afterFirst, "processes/models/processes/p.bpmn"].sort());
  assert.deepEqual([...(store.load("processes/models/processes/p.bpmn") ?? [])], [4]);
});
