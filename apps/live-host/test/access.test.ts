/**
 * AccessCache authorization logic (ADR 0001 — the one path since ADR 0007):
 * pure unit test with fakes. Proves: the app-side installation-token check is
 * the only path; a repository nobody can vouch for is closed; source errors
 * reuse the last known answer instead of locking users out; denials are
 * cached, errors are not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Session } from "../src/adapters/sqlite/sessions.ts";
import type { RepoConnectionSource, RepoPermission } from "../src/ports/connection-source.ts";
import { AccessCache } from "../src/repos/access.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const session = (login = "petra"): Session => ({
  id: `sess-${login}`,
  user: { login, name: login, avatarUrl: null, provider: "oidc" },
  createdAt: Date.now(),
});
const repo = (fullName = "acme/processes", installationId: number | null = 1): ConnectedRepo => ({
  fullName,
  defaultBranch: "main",
  private: true,
  avatarUrl: null,
  installationId,
  suspended: false,
});

const baseSource = {
  id: "github-app",
  canEnumerate: true,
  listConnectedRepos: async () => ({
    repos: [],
    knownRefs: new Set<number>(),
    enumeratedRefs: new Set<number>(),
    suspendedRefs: new Set<number>(),
  }),
  cloneToken: async () => undefined,
  connectUrl: () => undefined,
  verifyWebhook: () => undefined,
};

function fakeSource(
  fn: (ref: number, user: string, repo: string) => Promise<RepoPermission>,
): RepoConnectionSource & { calls: number } {
  const s = {
    ...baseSource,
    calls: 0,
    async checkUserPermission(ref: number, user: string, r: string) {
      this.calls++;
      return fn(ref, user, r);
    },
  };
  return s as unknown as RepoConnectionSource & { calls: number };
}

test("app-side path grants write for write/admin/maintain, denies read/none", async () => {
  for (const [perm, expected] of [
    ["admin", true],
    ["write", true],
    ["maintain", true],
    ["read", false],
    ["none", false],
  ] as const) {
    const source = fakeSource(async () => perm);
    const cache = new AccessCache(source);
    assert.equal(await cache.canWrite(session(), repo()), expected, `perm ${perm}`);
    assert.equal(source.calls, 1);
  }
});

test("result is cached: a second call does not re-hit the source", async () => {
  const source = fakeSource(async () => "write");
  const cache = new AccessCache(source);
  const r = repo();
  await cache.canWrite(session(), r);
  await cache.canWrite(session(), r);
  assert.equal(source.calls, 1, "second call served from cache");
});

test("app-side error reuses the last known answer, does not cache the error", async () => {
  let fail = false;
  const source = fakeSource(async () => {
    if (fail) throw new Error("GitHub 503");
    return "write";
  });
  const cache = new AccessCache(source);
  const r = repo();
  const s = session();
  assert.equal(await cache.canWrite(s, r), true); // primes the cache (write)
  fail = true;
  cache.invalidate(); // drop the cache so the next call must call the source (which now errors)
  assert.equal(await cache.canWrite(s, r), false, "no prior answer after invalidate + error → deny, not cached");
  assert.equal(await cache.canWrite(s, r), false);
  assert.equal(source.calls, 3, "an error is never cached — every call asks again");
});

test("nobody can vouch → closed: no source, a source without the check, a repo without an installation", async () => {
  assert.equal(await new AccessCache(undefined).canWrite(session(), repo()), false, "no connection source");
  const noCheck = new AccessCache(baseSource as unknown as RepoConnectionSource);
  assert.equal(await noCheck.canWrite(session(), repo()), false, "source cannot answer app-side");
  const source = fakeSource(async () => "write");
  const cache = new AccessCache(source);
  assert.equal(await cache.canWrite(session(), repo("host/repo", null)), false, "static repo, no installation");
  assert.equal(source.calls, 0, "there is no user-token fallback to fall back to");
  assert.equal(await cache.canWrite(session(), repo("host/repo", null)), false, "the denial is cached");
});

test("concurrent checks for the same (session, repo) share one round trip (#212)", async () => {
  let release: (perm: RepoPermission) => void = () => {};
  const source = fakeSource(() => new Promise<RepoPermission>((resolve) => (release = resolve)));
  const cache = new AccessCache(source);
  const checks = [cache.canWrite(session(), repo()), cache.canWrite(session(), repo())];
  release("write");
  assert.deepEqual(await Promise.all(checks), [true, true]);
  assert.equal(source.calls, 1, "the second caller joined the first round trip");
  assert.equal(await cache.canWrite(session(), repo()), true);
  assert.equal(source.calls, 1, "…and its answer landed in the cache");
});

test("invalidate(sessionId) drops only that session's answers (the overview refresh, #212)", async () => {
  const source = fakeSource(async () => "write");
  const cache = new AccessCache(source);
  await cache.canWrite(session("petra"), repo());
  await cache.canWrite(session("paul"), repo());
  assert.equal(source.calls, 2);
  cache.invalidate("sess-petra");
  await cache.canWrite(session("paul"), repo());
  assert.equal(source.calls, 2, "paul's answer stays cached");
  await cache.canWrite(session("petra"), repo());
  assert.equal(source.calls, 3, "petra asks the provider again");
});

test("a round trip that straddles invalidate() answers its caller but is not cached", async () => {
  let release: (perm: RepoPermission) => void = () => {};
  const source = fakeSource(() => new Promise<RepoPermission>((resolve) => (release = resolve)));
  const cache = new AccessCache(source);
  const before = cache.canWrite(session(), repo());
  cache.invalidate();
  release("write");
  assert.equal(await before, true);
  const after = cache.canWrite(session(), repo());
  assert.equal(source.calls, 2, "the pre-invalidate answer never reached the cache");
  release("read");
  assert.equal(await after, false);
});

test("invalidate(sessionId) discards only that session's in-flight round trips (#212)", async () => {
  const releases: Array<(perm: RepoPermission) => void> = [];
  const source = fakeSource(() => new Promise<RepoPermission>((resolve) => releases.push(resolve)));
  const cache = new AccessCache(source);
  const checks = [cache.canWrite(session("petra"), repo()), cache.canWrite(session("paul"), repo())];
  cache.invalidate("sess-petra");
  for (const release of releases) release("write");
  assert.deepEqual(await Promise.all(checks), [true, true]);
  assert.equal(await cache.canWrite(session("paul"), repo()), true);
  assert.equal(source.calls, 2, "paul's round trip straddled petra's refresh — its answer still landed");
  const again = cache.canWrite(session("petra"), repo());
  assert.equal(source.calls, 3, "petra's pre-refresh answer never reached the cache");
  releases[2]?.("write");
  assert.equal(await again, true);
});
