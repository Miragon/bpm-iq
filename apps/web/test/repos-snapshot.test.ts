/**
 * The overview's repo-list snapshot (#212, src/lib/repos-snapshot.ts): the
 * last known list survives a page load, but only for the login it belongs
 * to, only while it is fresh enough, and never from a damaged entry. The
 * cache subscription writes every successful ["repos"] result — the forced
 * refresh's setQueryData included — and nothing once the login is gone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Me, RepoInfo } from "@designiq/contracts/live-host";
import { QueryClient } from "@tanstack/react-query";

import {
  clearRepoSnapshot,
  persistRepoSnapshots,
  readRepoSnapshot,
  writeRepoSnapshot,
} from "../src/lib/repos-snapshot.ts";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

const repo = (fullName: string): RepoInfo => {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    fullName,
    owner,
    name,
    defaultBranch: "main",
    avatarUrl: null,
    suspended: false,
    permission: "write",
    processCount: 2,
    decisionCount: 1,
    dirtyCount: 0,
    liveSessions: 0,
  };
};

const me = (login: string): Me => ({
  user: { login, name: login, avatarUrl: null, provider: "oidc" },
  wsToken: "sess-secret",
});

const DAY = 24 * 60 * 60_000;

test("a snapshot is read back for its own login only", () => {
  const storage = memoryStorage();
  writeRepoSnapshot("petra", [repo("acme/models")], storage, 1_000);
  assert.deepEqual(readRepoSnapshot("petra", storage, 2_000), {
    login: "petra",
    savedAt: 1_000,
    repos: [repo("acme/models")],
  });
  assert.equal(readRepoSnapshot("paul", storage, 2_000), undefined, "another account never sees petra's repos");
});

test("a snapshot older than a week is ignored", () => {
  const storage = memoryStorage();
  writeRepoSnapshot("petra", [repo("acme/models")], storage, 0);
  assert.ok(readRepoSnapshot("petra", storage, 7 * DAY));
  assert.equal(readRepoSnapshot("petra", storage, 7 * DAY + 1), undefined);
});

test("a damaged or foreign-shaped entry is ignored, never thrown", () => {
  const storage = memoryStorage();
  for (const raw of [
    "{not json",
    JSON.stringify({ login: "petra", savedAt: 1, repos: "acme/models" }),
    JSON.stringify({ login: "petra", savedAt: 1, repos: [{ fullName: 42 }] }),
    JSON.stringify({ login: "petra", repos: [] }),
  ]) {
    storage.setItem("designiq.repos.v1", raw);
    assert.equal(readRepoSnapshot("petra", storage, 2), undefined, raw);
  }
});

test("blocked storage degrades to no snapshot", () => {
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.doesNotThrow(() => writeRepoSnapshot("petra", [repo("acme/models")], blocked));
  assert.equal(readRepoSnapshot("petra", blocked), undefined);
  assert.doesNotThrow(() => clearRepoSnapshot(blocked));
});

test("clearRepoSnapshot (logout) removes the entry", () => {
  const storage = memoryStorage();
  writeRepoSnapshot("petra", [repo("acme/models")], storage);
  clearRepoSnapshot(storage);
  assert.equal(readRepoSnapshot("petra", storage), undefined);
});

test("persistRepoSnapshots writes each successful repos result under the signed-in login — and only that", () => {
  const storage = memoryStorage();
  const qc = new QueryClient();
  const stop = persistRepoSnapshots(qc, storage);

  qc.setQueryData(["repos"], [repo("acme/models")]);
  assert.equal(storage.items.size, 0, "no login in the cache (e.g. a fetch landing after logout) → nothing written");

  qc.setQueryData(["me"], me("petra"));
  assert.equal(storage.items.size, 0, "other queries are never persisted — ['me'] carries the session id");

  qc.setQueryData(["repos"], [repo("acme/models"), repo("acme/claims")]);
  assert.deepEqual(
    readRepoSnapshot("petra", storage)?.repos.map((r) => r.fullName),
    ["acme/models", "acme/claims"],
  );
  assert.ok(!storage.items.get("designiq.repos.v1")?.includes("sess-secret"), "the ws token never reaches storage");

  stop();
  qc.setQueryData(["repos"], []);
  assert.equal(readRepoSnapshot("petra", storage)?.repos.length, 2, "unsubscribed → no further writes");
});
