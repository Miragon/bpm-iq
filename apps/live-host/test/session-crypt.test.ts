/**
 * Session provider-token encryption at rest (M6). A leaked live.db must not yield a
 * usable GitHub credential; the key lives in env (Fly secret), off the data volume.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { SessionStore } from "../src/adapters/sqlite/sessions.ts";

const user = { login: "petra", name: "Petra", avatarUrl: null, provider: "github" };
const grant = { accessToken: "gho_secret", refreshToken: "ghr_refresh", expiresAt: 0 };
const rawToken = (db: DatabaseSync, id: string) =>
  (db.prepare("SELECT provider_token, refresh_token FROM sessions WHERE id = ?").get(id) as {
    provider_token: string;
    refresh_token: string | null;
  }) ?? { provider_token: "", refresh_token: null };

test("with a key: tokens are encrypted on disk but get() round-trips them", () => {
  const db = new DatabaseSync(":memory:");
  const store = new SessionStore(db, "enc-key");
  const s = store.create(user, grant);
  const got = store.get(s.id);
  assert.equal(got?.providerToken, "gho_secret");
  assert.equal(got?.refreshToken, "ghr_refresh");
  const raw = rawToken(db, s.id);
  assert.notEqual(raw.provider_token, "gho_secret", "provider token is not cleartext on disk");
  assert.match(raw.provider_token, /^[^.]+\.[^.]+\.[^.]+$/, "iv.tag.ct blob shape");
  assert.notEqual(raw.refresh_token, "ghr_refresh", "refresh token is not cleartext either");
});

test("a token encrypted under a different key is unrecoverable → '' (re-auth, no crash)", () => {
  const db = new DatabaseSync(":memory:");
  const s = new SessionStore(db, "key-A").create(user, grant);
  const other = new SessionStore(db, "key-B");
  assert.equal(other.get(s.id)?.providerToken, "");
});

test("no key (dev fallback): stored cleartext, still round-trips", () => {
  const db = new DatabaseSync(":memory:");
  const store = new SessionStore(db);
  const s = store.create(user, grant);
  assert.equal(store.get(s.id)?.providerToken, "gho_secret");
  assert.equal(rawToken(db, s.id).provider_token, "gho_secret");
});

test("handoff/cell session (no grant) stores an empty token", () => {
  const store = new SessionStore(new DatabaseSync(":memory:"), "enc-key");
  const s = store.create(user);
  assert.equal(store.get(s.id)?.providerToken, "");
});
