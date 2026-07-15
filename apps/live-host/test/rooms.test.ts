/**
 * Room parsing + on-disk resolution (src/repos/rooms.ts) — the WebSocket
 * authorization + path-safety gate. These run without booting the server: a fake
 * registry (mirroring RepoRegistry.get's case-insensitive lookup) and a fake
 * workspace stand in for the singletons.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { splitRoom, toDiskPath } from "../src/domain/rooms.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

function repo(fullName: string, extra: Partial<ConnectedRepo> = {}): ConnectedRepo {
  return {
    fullName,
    defaultBranch: "main",
    private: false,
    avatarUrl: null,
    installationId: 1,
    suspended: false,
    ...extra,
  };
}

/** a registry whose get() mirrors RepoRegistry.get: case-insensitive, canonical repo */
function fakeRegistry(...repos: ConnectedRepo[]) {
  return { get: (fullName: string) => repos.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase()) };
}

// ── splitRoom: happy paths ──────────────────────────────────────────────────

test("splitRoom: GitHub owner/name room → repo + relative path", () => {
  const { repo: r, path } = splitRoom("acme/models/processes/order.bpmn", fakeRegistry(repo("acme/models")));
  assert.equal(r.fullName, "acme/models");
  assert.equal(path, "processes/order.bpmn");
});

test("splitRoom: a nested file path is preserved", () => {
  assert.equal(splitRoom("acme/models/a/b/c.dmn", fakeRegistry(repo("acme/models"))).path, "a/b/c.dmn");
});

test("splitRoom: GitLab subgroup — the LONGEST registry prefix wins", () => {
  // both group/sub and group/sub/project are connected; the longer must win so a
  // file in the nested project isn't mis-attributed to the parent group's repo
  const reg = fakeRegistry(repo("group/sub"), repo("group/sub/project"));
  const nested = splitRoom("group/sub/project/model.bpmn", reg);
  assert.equal(nested.repo.fullName, "group/sub/project");
  assert.equal(nested.path, "model.bpmn");
  const shallow = splitRoom("group/sub/model.bpmn", reg);
  assert.equal(shallow.repo.fullName, "group/sub");
  assert.equal(shallow.path, "model.bpmn");
});

// ── splitRoom: rejections ───────────────────────────────────────────────────

test("splitRoom: rejects a room with no file path", () => {
  assert.throws(() => splitRoom("acme/models", fakeRegistry(repo("acme/models"))), /room must be <repo-full-name>/);
});

test("splitRoom: rejects an unconnected repository", () => {
  assert.throws(
    () => splitRoom("stranger/repo/x.bpmn", fakeRegistry(repo("acme/models"))),
    /not a connected repository/,
  );
});

test("splitRoom: rejects a mis-cased repo prefix (would fork the CRDT doc)", () => {
  // registry.get matches case-insensitively, so this resolves a repo — but the raw
  // room casing differs from the canonical fullName and must be rejected
  assert.throws(() => splitRoom("Acme/Models/order.bpmn", fakeRegistry(repo("acme/models"))), /canonical repo casing/);
});

test("splitRoom: rejects a suspended installation", () => {
  const reg = fakeRegistry(repo("acme/models", { suspended: true }));
  assert.throws(() => splitRoom("acme/models/order.bpmn", reg), /installation suspended/);
});

test("splitRoom: rejects path traversal via ..", () => {
  assert.throws(() => splitRoom("acme/models/../secrets.bpmn", fakeRegistry(repo("acme/models"))), /not shareable/);
});

test("splitRoom: rejects dotfiles and .git / node_modules segments", () => {
  const reg = fakeRegistry(repo("acme/models"));
  assert.throws(() => splitRoom("acme/models/.git/config.bpmn", reg), /not shareable/);
  assert.throws(() => splitRoom("acme/models/node_modules/pkg/x.bpmn", reg), /not shareable/);
  assert.throws(() => splitRoom("acme/models/.hidden.bpmn", reg), /not shareable/);
});

test("splitRoom: rejects a non-editable extension", () => {
  assert.throws(
    () => splitRoom("acme/models/notes.txt", fakeRegistry(repo("acme/models"))),
    /not an editable model\/doc/,
  );
});

// ── toDiskPath ──────────────────────────────────────────────────────────────

test("toDiskPath: resolves a valid room inside the repo workspace", async () => {
  const workspaces = { ensure: async () => "/srv/ws/acme-models" };
  const disk = await toDiskPath("acme/models/processes/order.bpmn", fakeRegistry(repo("acme/models")), workspaces);
  assert.equal(disk, resolve("/srv/ws/acme-models", "processes/order.bpmn"));
  assert.ok(disk.startsWith("/srv/ws/acme-models/")); // stays inside the workspace
});

test("toDiskPath: propagates splitRoom rejections before touching the disk", async () => {
  const reg = fakeRegistry(repo("acme/models", { suspended: true }));
  const workspaces = { ensure: async () => "/srv/ws/acme-models" };
  await assert.rejects(() => toDiskPath("acme/models/order.bpmn", reg, workspaces), /installation suspended/);
});
