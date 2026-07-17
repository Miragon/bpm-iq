/**
 * WorkspaceManager (src/repos/workspaces.ts) — the pure, no-git path resolution
 * (which checkout a repo maps to, whether the host repo is served in place),
 * plus resetToDefault against real local repos (a bare "origin" + a workspace
 * clone — no network, no GitHub). The clone/fetch/reconcile orchestration stays
 * covered by release-e2e.sh.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    hostRepo: "Miragon/bpm-iq",
    hostRoot,
    registry: {} as RepoRegistry, // isHostRepo/dir never touch the registry
    githubBaseUrl: "https://github.com",
  });
}

test("isHostRepo: true only for the host repo WITH a root bpmiq.yml", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "bpm-host-"));
  const data = mkdtempSync(join(tmpdir(), "bpm-data-"));
  const wm = manager(hostRoot, data);
  // no bpmiq.yml yet → the host checkout is NOT served in place (cloned like any repo)
  assert.equal(wm.isHostRepo("Miragon/bpm-iq"), false);
  writeFileSync(join(hostRoot, "bpmiq.yml"), "processes: processes\n");
  assert.equal(wm.isHostRepo("Miragon/bpm-iq"), true);
  assert.equal(wm.isHostRepo("miragon/BPM-IQ"), true, "host match is case-insensitive");
  assert.equal(wm.isHostRepo("acme/other"), false, "a different repo is never the host");
});

test("dir: host repo → its checkout in place; other repos → dataDir/workspaces/<owner>/<name>", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "bpm-host-"));
  const data = mkdtempSync(join(tmpdir(), "bpm-data-"));
  writeFileSync(join(hostRoot, "bpmiq.yml"), "processes: processes\n");
  const wm = manager(hostRoot, data);
  // the checkout root, NOT a content subdirectory — the bpmiq.yml folder is the
  // content config's business, so dir() no longer probes for processes/
  assert.equal(wm.dir(repo("Miragon/bpm-iq")), hostRoot);
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
    hostRepo: "Miragon/bpm-iq",
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
  await assert.rejects(wm.resetToDefault(repo("Miragon/bpm-iq")), /in-place host checkout/);
});
