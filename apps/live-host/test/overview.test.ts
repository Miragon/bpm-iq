/**
 * Overview read-models (src/application/overview.ts) — listProcesses/listRepos
 * assembly against a tmpdir workspace with injected fakes (registry, access,
 * changedPaths). Previously untested inline code in http/api.ts; the asserted
 * object shapes ARE the wire format the web client consumes.
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

const ORDER_YAML = `name: Order to Cash
classification: core
status: as-is
version: 1.2.0
owner:
  team: sales
models:
  bpmn: order.bpmn
  wardley: strategy.owm
subprocesses:
  - file: subprocesses/check-credit.bpmn
decisions:
  - file: decisions/pricing.dmn
  - note: no file key on this one
docs:
  - notes.txt
`;

/** a workspace with one healthy process, one invalid-yaml process, and noise */
function setup(over: Partial<OverviewDeps> = {}) {
  const ws = mkdtempSync(join(tmpdir(), "bpm-overview-"));
  mkdirSync(join(ws, "processes", "order"), { recursive: true });
  writeFileSync(join(ws, "processes", "order", "process.yaml"), ORDER_YAML);
  mkdirSync(join(ws, "processes", "broken"), { recursive: true });
  writeFileSync(join(ws, "processes", "broken", "process.yaml"), "name: [unclosed\nflow: sequence");
  mkdirSync(join(ws, "processes", "no-yaml-here")); // no process.yaml → skipped
  writeFileSync(join(ws, "processes", "stray-file.txt"), "not a directory"); // skipped

  const changedPathsCalls: string[] = [];
  const deps: OverviewDeps = {
    registry: { list: () => [REPO] },
    workspaces: {
      dir: () => ws,
      changedPaths: async (_repo, pathspec) => {
        changedPathsCalls.push(pathspec);
        return pathspec === "processes/order" ? ["processes/order/order.bpmn"] : [];
      },
    },
    access: { canWrite: async () => true },
    liveDocs: () => [
      "acme/models/processes/order/order.bpmn",
      "acme/models/processes/order/process.yaml",
      "acme/models/landscape/value-chain.vc.json",
      "other/repo/processes/order/order.bpmn", // foreign repo — never counted here
    ],
    ...over,
  };
  return { ws, deps, changedPathsCalls };
}

// ── listProcesses ───────────────────────────────────────────────────────────

test("listProcesses: metadata row with models resolved via the notation registry", async () => {
  const { ws, deps, changedPathsCalls } = setup();
  const rows = await listProcesses(deps, REPO, ws);
  assert.equal(rows.length, 2, "only real process dirs with a process.yaml are listed");

  const order = rows.find((r) => r.id === "order");
  assert.ok(order);
  assert.equal(order.repo, "acme/models");
  assert.equal(order.name, "Order to Cash");
  assert.equal(order.classification, "core");
  assert.equal(order.status, "as-is");
  assert.equal(order.version, "1.2.0");
  assert.equal(order.owner, "sales");
  assert.equal(order.bpmn, "processes/order/order.bpmn");
  // declared models + subprocesses + decisions, notation from @bpmiq/notations;
  // a decisions entry without `file` is skipped, unknown extensions fall back to "text"
  assert.deepEqual(order.models, [
    { notation: "bpmn", path: "processes/order/order.bpmn" },
    { notation: "wardley", path: "processes/order/strategy.owm" },
    { notation: "bpmn", path: "processes/order/subprocesses/check-credit.bpmn" },
    { notation: "dmn", path: "processes/order/decisions/pricing.dmn" },
  ]);
  // dirty flag comes from the injected changedPaths (git stays behind the seam)
  assert.equal(order.dirty, true);
  assert.deepEqual(changedPathsCalls.filter((c) => c === "processes/order").length, 1);
  // live sessions: only rooms under THIS repo's processes/order/ count
  assert.equal(order.liveSessions, 2);
});

test("listProcesses: invalid process.yaml degrades to a fallback row, not a failure", async () => {
  const { ws, deps } = setup();
  const rows = await listProcesses(deps, REPO, ws);
  const broken = rows.find((r) => r.id === "broken");
  assert.deepEqual(broken, {
    repo: "acme/models",
    id: "broken",
    name: "broken",
    classification: null,
    status: "invalid-yaml",
    version: null,
    owner: null,
    bpmn: null,
    models: [],
    dirty: false,
    liveSessions: 0,
  });
});

test("listProcesses: a workspace without processes/ lists nothing", async () => {
  const { deps } = setup();
  const empty = mkdtempSync(join(tmpdir(), "bpm-overview-empty-"));
  assert.deepEqual(await listProcesses(deps, REPO, empty), []);
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

test("listRepos: no local workspace → null counts (the overview must not clone)", async () => {
  const empty = mkdtempSync(join(tmpdir(), "bpm-overview-nows-"));
  const { deps } = setup({ workspaces: { dir: () => empty, changedPaths: async () => [] } });
  const repos = await listRepos(deps, session("sess-petra"));
  assert.equal(repos.length, 1);
  assert.equal(repos[0]?.processCount, null);
  assert.equal(repos[0]?.dirtyCount, null);
});
