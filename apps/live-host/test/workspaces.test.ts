/**
 * WorkspaceManager (src/repos/workspaces.ts) — the pure, no-git path resolution
 * (which checkout a repo maps to, whether the host repo is served in place),
 * plus resetToDefault and the per-file catch-up (#185: reconcile, release
 * marks, conflicts) against real local repos (a bare "origin" + a workspace
 * clone — no network, no GitHub). The clone/fetch orchestration and the
 * release round trip stay covered by release-e2e.sh.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { ConnectedRepo, RepoRegistry } from "../src/repos/registry.ts";
import { WorkspaceManager } from "../src/repos/workspaces.ts";

const repo = (fullName: string): ConnectedRepo => ({
  fullName,
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
});

function manager(hostRoot: string, dataDir: string) {
  return new WorkspaceManager({
    dataDir,
    hostRepo: "Miragon/design-iq",
    hostRoot,
    registry: {} as RepoRegistry, // isHostRepo/dir never touch the registry
    githubBaseUrl: "https://github.com",
  });
}

test("isHostRepo: true only for the host repo WITH a root contract file (legacy name)", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "bpm-host-"));
  const data = mkdtempSync(join(tmpdir(), "bpm-data-"));
  const wm = manager(hostRoot, data);
  // no bpmiq.yml yet → the host checkout is NOT served in place (cloned like any repo)
  assert.equal(wm.isHostRepo("Miragon/design-iq"), false);
  writeFileSync(join(hostRoot, "bpmiq.yml"), "processes: processes\n"); // legacy-name-ok: pins the legacy path
  assert.equal(wm.isHostRepo("Miragon/design-iq"), true);
  assert.equal(wm.isHostRepo("miragon/DESIGN-IQ"), true, "host match is case-insensitive");
  assert.equal(wm.isHostRepo("acme/other"), false, "a different repo is never the host");
});

test("isHostRepo: a host root whose contract file is designiq.yml is served in place too", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "bpm-host-"));
  const data = mkdtempSync(join(tmpdir(), "bpm-data-"));
  const wm = manager(hostRoot, data);
  assert.equal(wm.isHostRepo("Miragon/design-iq"), false);
  // the bind-mount case: a checkout that only carries the new name must not be
  // bypassed (and GITHUB_REPO cloned instead) by a probe for the legacy file
  writeFileSync(join(hostRoot, "designiq.yml"), "models: processes\n");
  assert.equal(wm.isHostRepo("Miragon/design-iq"), true);
  assert.equal(wm.isHostRepo("acme/other"), false, "a different repo is never the host");
  assert.equal(wm.dir(repo("Miragon/design-iq")), hostRoot);
});

test("dir: host repo → its checkout in place; other repos → dataDir/workspaces/<owner>/<name>", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "bpm-host-"));
  const data = mkdtempSync(join(tmpdir(), "bpm-data-"));
  writeFileSync(join(hostRoot, "bpmiq.yml"), "processes: processes\n");
  const wm = manager(hostRoot, data);
  // the checkout root, NOT a content subdirectory — the bpmiq.yml folder is the
  // content config's business, so dir() no longer probes for processes/
  assert.equal(wm.dir(repo("Miragon/design-iq")), hostRoot);
  assert.equal(wm.dir(repo("acme/models")), join(data, "workspaces", "acme", "models"));
});

// ── resetToDefault (real git, no network) ────────────────────────────────────

// isolate from the operator's git config; give commits a deterministic identity
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.test",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });

/** a bare "origin" seeded on main with processes/order.bpmn = "v1" */
function bareOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), "bpm-bare-"));
  git(bare, "init", "--bare", "-b", "main");
  const seed = mkdtempSync(join(tmpdir(), "bpm-seed-"));
  git(seed, "clone", bare, ".");
  writeFileSync(join(seed, "bpmiq.yml"), "processes: processes\n");
  mkdirSync(join(seed, "processes"), { recursive: true });
  writeFileSync(join(seed, "processes", "order.bpmn"), "v1");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "v1");
  git(seed, "push", "origin", "main");
  return bare;
}

test("resetToDefault: discards dirty edits + untracked files, hard-resets onto origin, reports affected paths", async () => {
  const bare = bareOrigin();
  const data = mkdtempSync(join(tmpdir(), "bpm-data-"));
  const wsDir = join(data, "workspaces", "acme", "models");
  mkdirSync(dirname(wsDir), { recursive: true });
  git(data, "clone", bare, wsDir); // workspace @ v1

  // local, unreleased edits (write-through): a tracked change + an untracked file
  writeFileSync(join(wsDir, "processes", "order.bpmn"), "v1-live");
  writeFileSync(join(wsDir, "processes", "new.bpmn"), "brand new");

  // upstream advanced main since the clone (a merged release)
  const seed = mkdtempSync(join(tmpdir(), "bpm-seed2-"));
  git(seed, "clone", bare, ".");
  writeFileSync(join(seed, "processes", "order.bpmn"), "v2");
  git(seed, "commit", "-am", "v2");
  git(seed, "push", "origin", "main");

  const hostRoot = mkdtempSync(join(tmpdir(), "bpm-host-")); // no bpmiq.yml → not the host repo
  const wm = new WorkspaceManager({
    dataDir: data,
    hostRepo: "Miragon/design-iq",
    hostRoot,
    registry: { tokenFor: async () => undefined } as unknown as RepoRegistry,
    githubBaseUrl: "https://github.com",
  });

  const affected = await wm.resetToDefault(repo("acme/models"));
  assert.deepEqual(
    [...affected].sort(),
    ["processes/new.bpmn", "processes/order.bpmn"],
    "the overwritten tracked file and the removed untracked file are both reported",
  );
  assert.equal(
    readFileSync(join(wsDir, "processes", "order.bpmn"), "utf8"),
    "v2",
    "reset to the fetched origin content",
  );
  assert.equal(existsSync(join(wsDir, "processes", "new.bpmn")), false, "clean removed the untracked file");
  assert.equal(git(wsDir, "status", "--porcelain").toString().trim(), "", "tree is clean after the reset");
});

test("resetToDefault: refuses the in-place host checkout (would wipe the operator's tree)", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "bpm-host-"));
  const data = mkdtempSync(join(tmpdir(), "bpm-data-"));
  writeFileSync(join(hostRoot, "bpmiq.yml"), "processes: processes\n"); // now it IS the host repo
  const wm = manager(hostRoot, data);
  await assert.rejects(wm.resetToDefault(repo("Miragon/design-iq")), /in-place host checkout/);
});

// ── catch-up (#185): per-file reconcile against real repos ───────────────────

/** a bare origin + a workspace clone + a second clone that plays "everyone
 *  else" (merges, outside edits), wired like server.ts wires the hooks */
function catchUpFixture(files: Record<string, string>) {
  const bare = mkdtempSync(join(tmpdir(), "bpm-bare-"));
  git(bare, "init", "--bare", "-b", "main");
  const upstreamDir = mkdtempSync(join(tmpdir(), "bpm-upstream-"));
  git(upstreamDir, "clone", bare, ".");
  writeFiles(upstreamDir, { "bpmiq.yml": "processes: processes\n", ...files });
  git(upstreamDir, "add", "-A");
  git(upstreamDir, "commit", "-m", "initial");
  git(upstreamDir, "push", "origin", "main");

  const data = mkdtempSync(join(tmpdir(), "bpm-data-"));
  const ws = join(data, "workspaces", "acme", "models");
  mkdirSync(dirname(ws), { recursive: true });
  git(data, "clone", bare, ws);

  const wm = new WorkspaceManager({
    dataDir: data,
    hostRepo: "Miragon/design-iq",
    hostRoot: mkdtempSync(join(tmpdir(), "bpm-host-")), // no bpmiq.yml → not the host repo
    registry: { tokenFor: async () => undefined } as unknown as RepoRegistry,
    githubBaseUrl: "https://github.com",
  });
  const live: string[] = [];
  const rewritten: string[][] = [];
  wm.hooks = { livePaths: () => live, onReconciled: (_repo, paths) => rewritten.push(paths) };
  const r = repo("acme/models");

  return {
    ws,
    wm,
    repo: r,
    live,
    rewritten,
    /** "someone else" commits on main (null = delete) and pushes */
    push(changes: Record<string, string | null>, message = "upstream") {
      writeFiles(upstreamDir, changes);
      git(upstreamDir, "add", "-A");
      git(upstreamDir, "commit", "-m", message);
      git(upstreamDir, "push", "origin", "main");
    },
    /** a release as publish() makes it: a commit off origin/main on a branch,
     *  marked in the workspace — returns the branch to merge later */
    async release(changes: Record<string, string | null>, branch: string) {
      git(upstreamDir, "checkout", "-q", "-b", branch);
      writeFiles(upstreamDir, changes);
      git(upstreamDir, "add", "-A");
      git(upstreamDir, "commit", "-m", `release ${branch}`);
      git(upstreamDir, "push", "origin", branch);
      git(upstreamDir, "checkout", "-q", "main");
      git(ws, "fetch", "-q", "origin", branch);
      const commit = git(ws, "rev-parse", "FETCH_HEAD").toString().trim();
      await wm.markReleased(r, commit, Object.keys(changes));
    },
    /** the PR merges — squashed, so main gets a NEW commit with the same content */
    squashMerge(branch: string) {
      git(upstreamDir, "merge", "-q", "--squash", branch);
      git(upstreamDir, "commit", "-m", `squash ${branch}`);
      git(upstreamDir, "push", "origin", "main");
    },
    /** what provision() does after its throttled fetch */
    async catchUp() {
      git(ws, "fetch", "-q", "origin", "main");
      await wm.reconcile(r);
    },
    read: (path: string) => (existsSync(join(ws, path)) ? readFileSync(join(ws, path), "utf8") : null),
    write: (changes: Record<string, string | null>) => writeFiles(ws, changes),
    headIsOrigin: () =>
      git(ws, "rev-parse", "HEAD").toString().trim() === git(ws, "rev-parse", "origin/main").toString().trim(),
  };
}

/** a host-state file inside a clone's .git. The prefix is spelled in two halves
 *  ON PURPOSE: a search/replace of the product name rewrites the constants in
 *  workspaces.ts and every literal here in the same breath, and the suite
 *  stays green — this spelling it cannot reach. */
const hostState = (ws: string, name: string) => join(ws, ".git", "bpm" + "iq-" + name);

function writeFiles(root: string, changes: Record<string, string | null>) {
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) {
      rmSync(join(root, path), { force: true });
      continue;
    }
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

test("reconcile: a merged release is no longer a change, edits since stay one; upstream work arrives; colleagues' edits survive", async () => {
  const f = catchUpFixture({
    "processes/a.bpmn": "a0",
    "processes/b.bpmn": "b0",
    "processes/c.bpmn": "c0",
  });
  f.write({ "processes/a.bpmn": "a1", "processes/c.bpmn": "c-colleague" });
  await f.release({ "processes/a.bpmn": "a1" }, "release/a");
  f.write({ "processes/a.bpmn": "a2" }); // edited on while the PR is open
  f.squashMerge("release/a");
  f.push({ "processes/b.bpmn": "b1" }, "someone else's change");

  await f.catchUp();

  assert.ok(f.headIsOrigin(), "the workspace HEAD caught up although a and c are dirty");
  assert.equal(f.read("processes/a.bpmn"), "a2", "the edits made after the release are kept");
  assert.equal(f.read("processes/b.bpmn"), "b1", "upstream's change reached the workspace");
  assert.equal(f.read("processes/c.bpmn"), "c-colleague", "a colleague's unreleased edit survives");
  assert.deepEqual(await f.wm.conflicts(f.repo), []);
  assert.deepEqual(
    await f.wm.changedFiles(f.repo, "processes"),
    [
      { path: "processes/a.bpmn", status: "modified" },
      { path: "processes/c.bpmn", status: "modified" },
    ],
    "b is no reverse change; a is a change only for its new edits",
  );
  assert.equal(
    git(f.ws, "log", "--oneline", "HEAD..origin/main", "--", "processes/a.bpmn").toString(),
    "",
    "the release's upstream guard has nothing to object to on the next release",
  );
  assert.deepEqual(f.rewritten, [["processes/b.bpmn"]], "only the rewritten file's lineage is dropped");
});

test("reconcile: a released file merged unchanged is clean again (also a released new file)", async () => {
  const f = catchUpFixture({ "processes/a.bpmn": "a0" });
  f.write({ "processes/a.bpmn": "a1", "processes/new.bpmn": "fresh" });
  await f.release({ "processes/a.bpmn": "a1", "processes/new.bpmn": "fresh" }, "release/both");
  f.squashMerge("release/both");

  await f.catchUp();

  assert.ok(f.headIsOrigin());
  assert.deepEqual(await f.wm.changedFiles(f.repo, "processes"), [], "nothing left to release");
  assert.equal(git(f.ws, "status", "--porcelain").toString(), "", "the tree is clean");
});

test("reconcile: a file changed on both sides keeps its local version and is flagged — the rest still catches up", async () => {
  const f = catchUpFixture({
    "processes/c.bpmn": "c0",
    "processes/d.bpmn": "d0",
    "processes/gone.bpmn": "g0",
    "processes/kept.bpmn": "k0",
  });
  f.write({
    "processes/c.bpmn": "c-local",
    "processes/gone.bpmn": "g-local", // edited here, deleted upstream
    "processes/kept.bpmn": null, // deleted here, edited upstream
    "processes/twin.bpmn": "twin-local", // new here AND upstream, different content
  });
  f.push(
    {
      "processes/c.bpmn": "c-outside",
      "processes/d.bpmn": "d1",
      "processes/gone.bpmn": null,
      "processes/kept.bpmn": "k1",
      "processes/twin.bpmn": "twin-upstream",
    },
    "edited outside the platform",
  );

  await f.catchUp();

  assert.ok(f.headIsOrigin(), "one conflict no longer blocks the whole repo");
  assert.equal(f.read("processes/d.bpmn"), "d1", "the untouched file caught up");
  assert.equal(f.read("processes/c.bpmn"), "c-local", "the local version is kept");
  assert.equal(f.read("processes/gone.bpmn"), "g-local");
  assert.equal(f.read("processes/kept.bpmn"), null);
  assert.equal(f.read("processes/twin.bpmn"), "twin-local");
  assert.deepEqual(await f.wm.conflicts(f.repo), [
    "processes/c.bpmn",
    "processes/gone.bpmn",
    "processes/kept.bpmn",
    "processes/twin.bpmn",
  ]);
  assert.deepEqual(await f.wm.changedFiles(f.repo, "processes"), [
    { path: "processes/c.bpmn", status: "modified" },
    { path: "processes/gone.bpmn", status: "added" },
    { path: "processes/kept.bpmn", status: "deleted" },
    { path: "processes/twin.bpmn", status: "modified" },
  ]);
  assert.deepEqual(f.rewritten, [["processes/d.bpmn"]]);

  // a later catch-up keeps the flags (the index now holds upstream — only the list remembers)
  f.push({ "processes/d.bpmn": "d2" });
  await f.catchUp();
  assert.equal(f.read("processes/d.bpmn"), "d2");
  assert.equal((await f.wm.conflicts(f.repo)).length, 4);
});

test("reconcile: an earlier release that merges while a later one of the file is open is no conflict", async () => {
  // lines far enough apart that release two merges cleanly on top of release one
  const lines = (first: string, last: string) => `${first}\n2\n3\n4\n5\n6\n${last}\n`;
  const f = catchUpFixture({ "processes/a.bpmn": lines("1", "7") });
  f.write({ "processes/a.bpmn": lines("1-one", "7") });
  await f.release({ "processes/a.bpmn": lines("1-one", "7") }, "release/one");
  f.write({ "processes/a.bpmn": lines("1-one", "7-two") }); // edited on, released again before the merge
  await f.release({ "processes/a.bpmn": lines("1-one", "7-two") }, "release/two");

  f.squashMerge("release/one");
  await f.catchUp();
  assert.ok(f.headIsOrigin());
  assert.deepEqual(await f.wm.conflicts(f.repo), [], "release one merging is no change on both sides");
  assert.equal(f.read("processes/a.bpmn"), lines("1-one", "7-two"), "the later edits are kept");
  assert.deepEqual(
    await f.wm.changedFiles(f.repo, "processes"),
    [{ path: "processes/a.bpmn", status: "modified" }],
    "release two is still open",
  );

  f.squashMerge("release/two");
  await f.catchUp();
  assert.deepEqual(await f.wm.conflicts(f.repo), []);
  assert.deepEqual(await f.wm.changedFiles(f.repo, "processes"), [], "both merged — nothing left to release");
  assert.equal(git(f.ws, "status", "--porcelain").toString(), "", "the tree is clean");
});

test("reconcile: a released deletion re-created before the merge does not block the catch-up", async () => {
  const f = catchUpFixture({ "processes/a.bpmn": "a0", "processes/b.bpmn": "b0" });
  f.write({ "processes/a.bpmn": null });
  await f.release({ "processes/a.bpmn": null }, "release/delete-a");
  f.write({ "processes/a.bpmn": "a-again" }); // re-created while the PR is open
  f.squashMerge("release/delete-a");
  f.push({ "processes/b.bpmn": "b1" });

  await f.catchUp();

  assert.ok(f.headIsOrigin(), "not stuck on the then-untracked file");
  assert.equal(f.read("processes/a.bpmn"), "a-again");
  assert.equal(f.read("processes/b.bpmn"), "b1");
  assert.deepEqual(await f.wm.conflicts(f.repo), []);
  assert.deepEqual(await f.wm.changedFiles(f.repo, "processes"), [{ path: "processes/a.bpmn", status: "added" }]);
});

test("reconcile: a failed fast-forward is retried without getting stuck (edited here, deleted upstream)", async () => {
  const f = catchUpFixture({ "processes/g.bpmn": "g0", "processes/b.bpmn": "b0" });
  f.write({ "processes/g.bpmn": "g-local" });
  f.push({ "processes/g.bpmn": null, "processes/b.bpmn": "b1" });
  // a stale lock fails the merge after the index was prepared (entry of g removed)
  const lock = join(f.ws, ".git", "ORIG_HEAD.lock");
  writeFileSync(lock, "");
  await f.catchUp();
  assert.equal(f.headIsOrigin(), false);
  assert.equal(f.read("processes/g.bpmn"), "g-local", "the parked file is back");
  rmSync(lock);

  await f.catchUp();

  assert.ok(f.headIsOrigin(), "the retry passes");
  assert.equal(f.read("processes/g.bpmn"), "g-local");
  assert.equal(f.read("processes/b.bpmn"), "b1");
  assert.deepEqual(await f.wm.conflicts(f.repo), ["processes/g.bpmn"], "still flagged from the first attempt");
});

test("resetToDefault ends the open releases — one that merges later is plain upstream work", async () => {
  const f = catchUpFixture({ "processes/a.bpmn": "a0" });
  f.write({ "processes/a.bpmn": "a1" });
  await f.release({ "processes/a.bpmn": "a1" }, "release/a");
  await f.wm.resetToDefault(f.repo);
  assert.equal(f.read("processes/a.bpmn"), "a0", "load-latest discarded the released edit");

  f.squashMerge("release/a");
  await f.catchUp();
  assert.equal(f.read("processes/a.bpmn"), "a1", "the merged release arrives like anyone's change");
  assert.deepEqual(await f.wm.changedFiles(f.repo, "processes"), []);
});

test("reconcile: defers while a file it would rewrite is open live — a live CONFLICT file does not block", async () => {
  const f = catchUpFixture({ "processes/a.bpmn": "a0", "processes/b.bpmn": "b0" });
  f.write({ "processes/b.bpmn": "b-local" });
  f.push({ "processes/a.bpmn": "a1", "processes/b.bpmn": "b-outside" });

  f.live.push("processes/a.bpmn"); // untouched locally, would be rewritten under the editor
  await f.catchUp();
  assert.equal(f.headIsOrigin(), false, "deferred");
  assert.equal(f.read("processes/a.bpmn"), "a0", "the open file was not rewritten");
  assert.deepEqual(await f.wm.conflicts(f.repo), [], "nothing flagged while deferred");

  f.live.splice(0, 1, "processes/b.bpmn"); // only the conflict file is open — its content is never rewritten
  await f.catchUp();
  assert.ok(f.headIsOrigin());
  assert.equal(f.read("processes/a.bpmn"), "a1");
  assert.equal(f.read("processes/b.bpmn"), "b-local");
  assert.deepEqual(await f.wm.conflicts(f.repo), ["processes/b.bpmn"]);
});

test("conflicts: take main's version, keep the workspace's, or heal by converging; a reset clears them all", async () => {
  const f = catchUpFixture({ "processes/x.bpmn": "x0", "processes/y.bpmn": "y0", "processes/z.bpmn": "z0" });
  f.write({ "processes/x.bpmn": "x-local", "processes/y.bpmn": "y-local", "processes/z.bpmn": "z-local" });
  f.push({ "processes/x.bpmn": "x1", "processes/y.bpmn": "y1", "processes/z.bpmn": "z1" });
  await f.catchUp();
  assert.deepEqual(await f.wm.conflicts(f.repo), ["processes/x.bpmn", "processes/y.bpmn", "processes/z.bpmn"]);

  await f.wm.takeUpstream(f.repo, "processes/x.bpmn");
  assert.equal(f.read("processes/x.bpmn"), "x1", "main's version, only for this file");
  assert.equal(f.read("processes/y.bpmn"), "y-local");

  await f.wm.keepWorkspace(f.repo, "processes/y.bpmn");
  assert.equal(f.read("processes/y.bpmn"), "y-local", "the local version stays — now releasable");
  assert.deepEqual(await f.wm.conflicts(f.repo), ["processes/z.bpmn"]);

  f.write({ "processes/z.bpmn": "z1" }); // someone re-did main's change by hand
  await f.catchUp();
  assert.deepEqual(await f.wm.conflicts(f.repo), [], "a converged file heals by itself");
  assert.deepEqual(await f.wm.changedFiles(f.repo, "processes"), [{ path: "processes/y.bpmn", status: "modified" }]);

  f.write({ "processes/y.bpmn": "y-again" });
  f.push({ "processes/y.bpmn": "y2" });
  await f.catchUp();
  assert.deepEqual(
    await f.wm.conflicts(f.repo),
    ["processes/y.bpmn"],
    "a kept file conflicts again on the next outside change",
  );
  await f.wm.resetToDefault(f.repo);
  assert.deepEqual(await f.wm.conflicts(f.repo), [], "load-latest leaves nothing to conflict");
});

test("reconcile / markReleased: never touch the in-place host checkout", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "bpm-host-"));
  writeFileSync(join(hostRoot, "bpmiq.yml"), "processes: processes\n"); // not even a git repo
  const wm = manager(hostRoot, mkdtempSync(join(tmpdir(), "bpm-data-")));
  await wm.reconcile(repo("Miragon/design-iq")); // would throw on any git call
  await wm.markReleased(repo("Miragon/design-iq"), "deadbeef", ["processes/a.bpmn"]);
  assert.deepEqual(await wm.conflicts(repo("Miragon/design-iq")), []);
  await assert.rejects(wm.takeUpstream(repo("Miragon/design-iq"), "processes/a.bpmn"), /in-place host checkout/);
});

// ── the rename journal (#208) ───────────────────────────────────────────────

test("recordRenames: a platform rename pairs its delete + add in changedFiles; chains collapse, a way back ends it", async () => {
  const f = catchUpFixture({ "processes/a.bpmn": "a0", "processes/c.dmn": "c0", "processes/c.tests.yaml": "t0" });
  const mv = (from: string, to: string) => {
    f.write({ [to]: f.read(from), [from]: null });
    return { from, to };
  };
  await f.wm.recordRenames(f.repo, [mv("processes/a.bpmn", "processes/b.bpmn")]);
  await f.wm.recordRenames(f.repo, [
    mv("processes/c.dmn", "processes/d.dmn"),
    mv("processes/c.tests.yaml", "processes/d.tests.yaml"),
  ]);
  // a → b, then b → sub/b (a move): still ONE pair from the released path
  await f.wm.recordRenames(f.repo, [mv("processes/b.bpmn", "processes/sub/b.bpmn")]);
  assert.deepEqual(await f.wm.changedFiles(f.repo, "processes"), [
    { path: "processes/a.bpmn", status: "deleted" },
    { path: "processes/c.dmn", status: "deleted" },
    { path: "processes/c.tests.yaml", status: "deleted" },
    { path: "processes/d.dmn", status: "added", renamedFrom: "processes/c.dmn" },
    { path: "processes/d.tests.yaml", status: "added", renamedFrom: "processes/c.tests.yaml" },
    { path: "processes/sub/b.bpmn", status: "added", renamedFrom: "processes/a.bpmn" },
  ]);
  // renamed back to where it started: no change, no pair
  await f.wm.recordRenames(f.repo, [mv("processes/sub/b.bpmn", "processes/a.bpmn")]);
  // a released path re-created (the old name is taken again) pairs nothing
  f.write({ "processes/c.dmn": "brand new" });
  assert.deepEqual(await f.wm.changedFiles(f.repo, "processes"), [
    { path: "processes/c.dmn", status: "modified" },
    { path: "processes/c.tests.yaml", status: "deleted" },
    { path: "processes/d.dmn", status: "added" },
    { path: "processes/d.tests.yaml", status: "added", renamedFrom: "processes/c.tests.yaml" },
  ]);
  assert.ok(existsSync(hostState(f.ws, "renames.json")), "the journal is on disk while a rename is pending");
  await f.wm.resetToDefault(f.repo);
  assert.ok(!existsSync(hostState(f.ws, "renames.json")), "load-latest ends every pending rename");
});

test("host state names are frozen: what an older host left in .git is still read", async () => {
  const f = catchUpFixture({ "processes/a.bpmn": "a0" });
  // exactly the files an installation's clones already carry — a renamed state
  // file reads as "no state", and a lost conflict list lets a release revert
  // upstream work
  writeFileSync(hostState(f.ws, "conflicts.json"), JSON.stringify(["processes/a.bpmn"]));
  writeFileSync(
    hostState(f.ws, "renames.json"),
    JSON.stringify([{ from: "processes/a.bpmn", to: "processes/b.bpmn" }]),
  );
  assert.deepEqual(await f.wm.conflicts(f.repo), ["processes/a.bpmn"]);
  assert.deepEqual(await f.wm.renames(f.repo), [{ from: "processes/a.bpmn", to: "processes/b.bpmn" }]);
  // and the open-release list is written under its historical name
  await f.release({ "processes/a.bpmn": "a1" }, "rel-a");
  assert.ok(existsSync(hostState(f.ws, "released.json")));
});

test("recordRenames: a rename released and merged ends its pair — renaming the new name again pairs on its own", async () => {
  const f = catchUpFixture({ "processes/a.bpmn": "a0" });
  f.write({ "processes/b.bpmn": "a0", "processes/a.bpmn": null });
  await f.wm.recordRenames(f.repo, [{ from: "processes/a.bpmn", to: "processes/b.bpmn" }]);
  await f.release({ "processes/b.bpmn": "a0", "processes/a.bpmn": null }, "rename-a-b");
  f.squashMerge("rename-a-b");
  await f.catchUp();
  assert.deepEqual(await f.wm.changedFiles(f.repo, "processes"), [], "the merged rename is no change any more");
  // b → c must NOT chain onto the merged a → b (that would record a → c, and
  // a is no deletion — b → c would ship as two unrelated halves)
  f.write({ "processes/c.bpmn": "a0", "processes/b.bpmn": null });
  await f.wm.recordRenames(f.repo, [{ from: "processes/b.bpmn", to: "processes/c.bpmn" }]);
  assert.deepEqual(await f.wm.renames(f.repo), [{ from: "processes/b.bpmn", to: "processes/c.bpmn" }]);
  assert.deepEqual(await f.wm.changedFiles(f.repo, "processes"), [
    { path: "processes/b.bpmn", status: "deleted" },
    { path: "processes/c.bpmn", status: "added", renamedFrom: "processes/b.bpmn" },
  ]);
});
