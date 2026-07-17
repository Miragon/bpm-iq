/**
 * Overview read-models (src/application/overview.ts) — listProcesses/listRepos
 * assembly against a tmpdir workspace with injected fakes (registry, access,
 * changedPaths). A process is a .bpmn file under the bpmiq.yml processes
 * folder; the asserted object shapes ARE the wire format the web client
 * consumes.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Session } from "../src/adapters/sqlite/sessions.ts";
import { listProcesses, listRepos, type OverviewDeps } from "../src/application/overview.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: "https://example.test/a.png",
  installationId: 1,
  suspended: false,
};

const session = (id: string, login = "petra"): Session => ({
  id,
  user: { login, name: login, avatarUrl: null, provider: "github" },
  providerToken: "",
  createdAt: Date.now(),
});

/** a workspace with a bpmiq.yml, two processes (one nested) and noise */
function setup(over: Partial<OverviewDeps> = {}) {
  const ws = mkdtempSync(join(tmpdir(), "bpm-overview-"));
  writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
  mkdirSync(join(ws, "processes", "sub"), { recursive: true });
  writeFileSync(join(ws, "processes", "order.bpmn"), "<bpmn/>");
  writeFileSync(join(ws, "processes", "sub", "check-credit.bpmn"), "<bpmn/>");
  writeFileSync(join(ws, "processes", "notes.md"), "not a process"); // wrong extension → skipped
  mkdirSync(join(ws, "docs"));
  writeFileSync(join(ws, "docs", "stray.bpmn"), "<bpmn/>"); // outside the folder → skipped

  const changedPathsCalls: string[] = [];
  const deps: OverviewDeps = {
    registry: { list: () => [REPO] },
    workspaces: {
      dir: () => ws,
      changedPaths: async (_repo, pathspec) => {
        changedPathsCalls.push(pathspec);
        return pathspec === "processes/order.bpmn" ? ["processes/order.bpmn"] : [];
      },
    },
    access: { canWrite: async () => true },
    liveDocs: () => [
      "acme/models/processes/order.bpmn",
      "acme/models/processes/order.bpmn", // second session on the same room
      "acme/models/processes/sub/check-credit.bpmn",
      "other/repo/processes/order.bpmn", // foreign repo — never counted here
    ],
    ...over,
  };
  return { ws, deps, changedPathsCalls };
}

// ── listProcesses ───────────────────────────────────────────────────────────

test("listProcesses: one row per .bpmn under the configured folder (recursive)", async () => {
  const { ws, deps, changedPathsCalls } = setup();
  const rows = await listProcesses(deps, REPO, ws);
  assert.deepEqual(
    rows.map((r) => r.id).sort(),
    ["check-credit", "order"],
    "only .bpmn files under the configured folder are processes",
  );

  const order = rows.find((r) => r.id === "order");
  assert.deepEqual(order, {
    repo: "acme/models",
    id: "order",
    name: "order",
    bpmn: "processes/order.bpmn",
    models: [{ notation: "bpmn", path: "processes/order.bpmn" }],
    folder: "", // directly inside the processes root
    dirty: true, // from the injected changedPaths (git stays behind the seam)
    liveSessions: 2, // exact room match, foreign repos never counted
  });
  assert.equal(changedPathsCalls.filter((c) => c === "processes/order.bpmn").length, 1);

  const nested = rows.find((r) => r.id === "check-credit");
  assert.equal(nested?.bpmn, "processes/sub/check-credit.bpmn");
  assert.equal(nested?.folder, "sub", "the folder is processes-root-relative");
  assert.equal(nested?.dirty, false);
  assert.equal(nested?.liveSessions, 1);
});

test("listProcesses: a workspace without bpmiq.yml lists nothing", async () => {
  const { deps } = setup();
  const empty = mkdtempSync(join(tmpdir(), "bpm-overview-empty-"));
  assert.deepEqual(await listProcesses(deps, REPO, empty), []);
});

test("listProcesses: a config pointing at a missing folder lists nothing", async () => {
  const { deps } = setup();
  const ws = mkdtempSync(join(tmpdir(), "bpm-overview-missing-"));
  writeFileSync(join(ws, "bpmiq.yml"), "processes: not-there\n");
  assert.deepEqual(await listProcesses(deps, REPO, ws), []);
});

test("listProcesses: an invalid bpmiq.yml degrades to an empty listing, not a failure", async () => {
  const { deps } = setup();
  const ws = mkdtempSync(join(tmpdir(), "bpm-overview-invalid-"));
  writeFileSync(join(ws, "bpmiq.yml"), "processes: [unclosed\n");
  assert.deepEqual(await listProcesses(deps, REPO, ws), []);
  writeFileSync(join(ws, "bpmiq.yml"), "processes: ../outside\n");
  assert.deepEqual(await listProcesses(deps, REPO, ws), [], "traversal in the config is refused");
});

test("listProcesses: duplicate file names — the first (sorted) wins, the shadow is skipped", async () => {
  const { deps } = setup();
  const ws = mkdtempSync(join(tmpdir(), "bpm-overview-dup-"));
  writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
  mkdirSync(join(ws, "processes", "a"), { recursive: true });
  mkdirSync(join(ws, "processes", "b"), { recursive: true });
  writeFileSync(join(ws, "processes", "a", "order.bpmn"), "<bpmn/>");
  writeFileSync(join(ws, "processes", "b", "order.bpmn"), "<bpmn/>");
  const rows = await listProcesses(deps, REPO, ws);
  assert.equal(rows.length, 1, "an id must stay unique");
  assert.equal(rows[0]?.bpmn, "processes/a/order.bpmn");
});

// ── listRepos ───────────────────────────────────────────────────────────────

test("listRepos: dev session sees every repo with write permission + counts", async () => {
  const { deps } = setup();
  const repos = await listRepos(deps, session("dev", "dev-token"));
  assert.equal(repos.length, 1);
  const r = repos[0];
  assert.ok(r);
  assert.equal(r.fullName, "acme/models");
  assert.equal(r.owner, "acme");
  assert.equal(r.name, "models");
  assert.equal(r.defaultBranch, "main");
  assert.equal(r.permission, "write");
  assert.equal(r.processCount, 2);
  assert.equal(r.dirtyCount, 1, "only the order process differs from origin");
  assert.equal(r.liveSessions, 3, "every live room of the repo counts, foreign repos never");
});

test("listRepos: a repo the user cannot write is invisible (private by default)", async () => {
  const { deps } = setup({ access: { canWrite: async () => false } });
  assert.deepEqual(await listRepos(deps, session("sess-petra")), []);
});

test("listRepos: no bpmiq.yml (workspace absent or plain repo) → null counts", async () => {
  const empty = mkdtempSync(join(tmpdir(), "bpm-overview-nows-"));
  const { deps } = setup({ workspaces: { dir: () => empty, changedPaths: async () => [] } });
  const repos = await listRepos(deps, session("sess-petra"));
  assert.equal(repos.length, 1);
  assert.equal(repos[0]?.processCount, null);
  assert.equal(repos[0]?.dirtyCount, null);
});
