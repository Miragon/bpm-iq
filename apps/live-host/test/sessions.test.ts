/**
 * SessionStore (identity-only, ADR 0001 completed by ADR 0007): a session is
 * id + identity + age, nothing secret. A pre-0007 live.db — rows with the
 * stored-grant columns — is migrated in place: the credentials are dropped
 * from disk, the sessions themselves survive the upgrade.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { SessionStore } from "../src/adapters/sqlite/sessions.ts";

const user = { login: "petra", name: "Petra", avatarUrl: null, provider: "oidc" };
const columns = (db: DatabaseSync): string[] =>
  (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name).sort();

test("a session is identity-only: created, read back, deleted — no credential anywhere", () => {
  const db = new DatabaseSync(":memory:");
  const store = new SessionStore(db);
  const s = store.create(user);
  assert.deepEqual(Object.keys(s).sort(), ["createdAt", "id", "user"]);
  assert.deepEqual(store.get(s.id), s);
  assert.deepEqual(columns(db), ["created_at", "id", "user"]);
  store.delete(s.id);
  assert.equal(store.get(s.id), undefined);
  assert.equal(store.get(undefined), undefined);
});

test("upgrade: a pre-0007 sessions table loses its grant columns in place, its rows stay valid", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    provider_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    refresh_token TEXT,
    token_expires_at INTEGER
  )`);
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run(
    "legacy-1",
    JSON.stringify(user),
    "gho_secret",
    Date.now(),
    "ghr_refresh",
    null,
  );
  const store = new SessionStore(db, "any-secret");
  assert.deepEqual(columns(db), ["created_at", "id", "user"], "the credential columns are gone from disk");
  const s = store.get("legacy-1");
  assert.equal(s?.user.login, "petra", "the person stays signed in across the upgrade");
  assert.ok(store.create(user).id, "new rows insert into the migrated table");
});
