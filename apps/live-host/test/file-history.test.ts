/**
 * File-history read-models (src/application/history.ts), git-log parsing
 * (src/domain/file-history.ts), and the WorkspaceManager git plumbing against
 * a REAL throwaway repo — Compare/Restore in the editor is only as
 * trustworthy as these seams. The asserted shapes ARE the wire format
 * (FileCommitWire/FileAtCommitWire).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { FileCommitWire } from "@bpmiq/contracts/live-host";
import { AppError } from "@bpmiq/http-kit";

import { runGit } from "../src/adapters/git/run.ts";
import { fileAtCommit, fileHistory, type HistoryDeps } from "../src/application/history.ts";
import { isCommitSha, parseFileLog } from "../src/domain/file-history.ts";
import type { ConnectedRepo, RepoRegistry } from "../src/repos/registry.ts";
import { WorkspaceManager } from "../src/repos/workspaces.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};

/* ── domain: parseFileLog ────────────────────────────────────────────── */

test("parseFileLog: records with multiline bodies, newest first", () => {
  const raw =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1fPetra\x1f2026-07-01T10:00:00+02:00\x1ffeat: add lane\x1fwhy:\nbecause\n\x1e\n" +
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x1fKai\x1f2026-06-01T09:00:00+02:00\x1finitial\x1f\x1e\n";
  const log = parseFileLog(raw);
  assert.equal(log.length, 2);
  assert.deepEqual(log[0], {
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    author: "Petra",
    authoredAt: "2026-07-01T10:00:00+02:00",
    subject: "feat: add lane",
    body: "why:\nbecause",
  });
  assert.equal(log[1]?.body, "");
});

test("parseFileLog: empty output and malformed records are dropped", () => {
  assert.deepEqual(parseFileLog(""), []);
  assert.deepEqual(parseFileLog("\n"), []);
  // a record whose sha field is garbage must not corrupt the listing
  const raw = "not-a-sha\x1fX\x1fY\x1fZ\x1fB\x1e\ncccccccccccccccccccccccccccccccccccccccc\x1fA\x1fD\x1fS\x1f\x1e";
  const log = parseFileLog(raw);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.sha, "cccccccccccccccccccccccccccccccccccccccc");
});

test("isCommitSha: hex 7..64 only", () => {
  assert.equal(isCommitSha("abc1234"), true);
  assert.equal(isCommitSha("a".repeat(40)), true);
  assert.equal(isCommitSha("abc123"), false); // too short
  assert.equal(isCommitSha("gggggggg"), false); // not hex
  assert.equal(isCommitSha("--max-count=1"), false); // argv smuggling
});

/* ── application: validation + orchestration over fakes ─────────────── */

const COMMIT: FileCommitWire = {
  sha: "a".repeat(40),
  subject: "s",
  body: "",
  author: "p",
  authoredAt: "2026-07-01T10:00:00+02:00",
};

function fakeDeps(over: Partial<HistoryDeps["workspaces"]> = {}) {
  const calls: { ensured: number; limits: number[] } = { ensured: 0, limits: [] };
  const deps: HistoryDeps = {
    registry: { get: (fullName) => (fullName.toLowerCase() === REPO.fullName ? REPO : undefined) },
    workspaces: {
      ensure: async () => {
        calls.ensured++;
        return "/ws";
      },
      fileHistory: async (_repo, _path, limit) => {
        calls.limits.push(limit);
        return [COMMIT];
      },
      fileAtCommit: async (_repo, _path, sha) => (sha === COMMIT.sha ? "<xml/>" : null),
      ...over,
    },
  };
  return { deps, calls };
}

test("fileHistory: ensures the workspace, clamps ?limit", async () => {
  const { deps, calls } = fakeDeps();
  assert.deepEqual(await fileHistory(deps, REPO, "processes/order/order.bpmn", null), [COMMIT]);
  await fileHistory(deps, REPO, "processes/order/order.bpmn", "3");
  await fileHistory(deps, REPO, "processes/order/order.bpmn", "99999");
  await fileHistory(deps, REPO, "processes/order/order.bpmn", "-2");
  await fileHistory(deps, REPO, "processes/order/order.bpmn", "nonsense");
  assert.equal(calls.ensured, 5);
  assert.deepEqual(calls.limits, [50, 3, 200, 1, 50]);
});

test("fileHistory: rejects non-model and escaping paths through the room gate", async () => {
  const { deps } = fakeDeps();
  for (const bad of ["../../etc/passwd", ".git/config", "processes/x/run.exe", "processes/.hidden/x.bpmn", ""]) {
    await assert.rejects(
      () => fileHistory(deps, REPO, bad, null),
      (e: unknown) => e instanceof AppError && e.code === "history/invalid-path" && e.status === 400,
      `expected 400 for ${JSON.stringify(bad)}`,
    );
  }
});

test("fileAtCommit: rejects a malformed sha, 404s an unknown one", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(
    () => fileAtCommit(deps, REPO, "processes/order/order.bpmn", "--max-count=1"),
    (e: unknown) => e instanceof AppError && e.code === "history/invalid-sha" && e.status === 400,
  );
  await assert.rejects(
    () => fileAtCommit(deps, REPO, "processes/order/order.bpmn", "b".repeat(40)),
    (e: unknown) => e instanceof AppError && e.code === "history/unknown-commit" && e.status === 404,
  );
  const file = await fileAtCommit(deps, REPO, "processes/order/order.bpmn", COMMIT.sha);
  assert.deepEqual(file, { sha: COMMIT.sha, path: "processes/order/order.bpmn", content: "<xml/>" });
});

/* ── repos: WorkspaceManager against a real git repo ────────────────── */

const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@test"];

/** a checkout at the manager's expected location with two commits on main */
async function gitWorkspace() {
  const dataDir = mkdtempSync(join(tmpdir(), "bpm-history-"));
  const checkout = join(dataDir, "workspaces", "acme", "models");
  const rel = "processes/order/order.bpmn";
  mkdirSync(join(checkout, "processes", "order"), { recursive: true });
  await runGit(["init", "-b", "main", checkout]);
  writeFileSync(join(checkout, rel), "<v1/>");
  await runGit(["-C", checkout, "add", "--all"]);
  await runGit(["-C", checkout, ...GIT_ID, "commit", "-m", "initial"]);
  writeFileSync(join(checkout, rel), "<v2/>");
  await runGit(["-C", checkout, "add", "--all"]);
  await runGit(["-C", checkout, ...GIT_ID, "commit", "-m", "feat: v2", "-m", "details here"]);
  const workspaces = new WorkspaceManager({
    dataDir,
    hostRepo: "other/host",
    hostRoot: mkdtempSync(join(tmpdir(), "bpm-hostroot-")),
    registry: { tokenFor: async () => undefined } as unknown as RepoRegistry,
    githubBaseUrl: "https://github.example",
  });
  return { workspaces, rel };
}

test("fileHistory/fileAtCommit against a real repo", async () => {
  const { workspaces, rel } = await gitWorkspace();
  const log = await workspaces.fileHistory(REPO, rel, 50);
  assert.equal(log.length, 2);
  assert.equal(log[0]?.subject, "feat: v2");
  assert.equal(log[0]?.body, "details here");
  assert.equal(log[0]?.author, "t");
  assert.equal(log[1]?.subject, "initial");
  assert.ok(log.every((c) => isCommitSha(c.sha)));
  assert.ok(log.every((c) => !Number.isNaN(Date.parse(c.authoredAt))));

  // content at each commit — the Restore source
  assert.equal(await workspaces.fileAtCommit(REPO, rel, log[1]!.sha), "<v1/>");
  assert.equal(await workspaces.fileAtCommit(REPO, rel, log[0]!.sha), "<v2/>");
  // unknown commit / path → null (the use-case maps this to 404)
  assert.equal(await workspaces.fileAtCommit(REPO, rel, "d".repeat(40)), null);
  assert.equal(await workspaces.fileAtCommit(REPO, "processes/nope.bpmn", log[0]!.sha), null);

  // limit + untouched file
  assert.equal((await workspaces.fileHistory(REPO, rel, 1)).length, 1);
  assert.deepEqual(await workspaces.fileHistory(REPO, "processes/other.bpmn", 50), []);
});

test("fileHistory: a renamed file lists only fetchable commits (no --follow dead rows)", async () => {
  const { workspaces, rel } = await gitWorkspace();
  const checkout = join(workspaces.dir(REPO));
  const renamed = "processes/order/order-v2.bpmn";
  await runGit(["-C", checkout, "mv", rel, renamed]);
  await runGit(["-C", checkout, ...GIT_ID, "commit", "-m", "rename model"]);
  const log = await workspaces.fileHistory(REPO, renamed, 50);
  // pre-rename commits are NOT listed — every listed row must be restorable
  assert.equal(log.length, 1);
  assert.equal(log[0]?.subject, "rename model");
  assert.equal(await workspaces.fileAtCommit(REPO, renamed, log[0]!.sha), "<v2/>");
});

test("fileHistory: a directory without git yields an empty history", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bpm-history-nogit-"));
  mkdirSync(join(dataDir, "workspaces", "acme", "models"), { recursive: true });
  const workspaces = new WorkspaceManager({
    dataDir,
    hostRepo: "other/host",
    hostRoot: dataDir,
    registry: { tokenFor: async () => undefined } as unknown as RepoRegistry,
    githubBaseUrl: "https://github.example",
  });
  assert.deepEqual(await workspaces.fileHistory(REPO, "processes/x.bpmn", 50), []);
});
