/**
 * WorkspaceManager path resolution (src/repos/workspaces.ts) — the pure,
 * no-git parts: which checkout a repo maps to, and whether the host repo is
 * served in place. The clone/fetch/reconcile git orchestration stays covered
 * by release-e2e.sh; these pin the branch points the bpmiq.yml refactor moved.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
