/**
 * Content use-case (src/application/content.ts) against a REAL Hocuspocus
 * server (no listen(), no websocket): openDoc is a genuine direct connection,
 * so the tests exercise the actual load/store hook lifecycle — seed from disk,
 * CAS in one transact, disconnect-forced write-through, liveDocs symmetry.
 *
 * The heart of it: the content-derived baseVersion. A DELETE-ONLY remote edit
 * leaves the Yjs state vector byte-identical (deletions live in the DeleteSet),
 * so a state-vector token would silently resurrect deleted content — the exact
 * lost-update class the CAS exists to prevent. The content hash catches it, and
 * unlike the vector it survives doc unload/reseed cycles between read and save.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { CONTENT_KEY } from "@bpmiq/contracts/live";
import { type AppError } from "@bpmiq/http-kit";
import { Server } from "@hocuspocus/server";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { type ContentDeps, getContent, putContent } from "../src/application/content.ts";
import { newBpmnXml } from "../src/domain/bpmn-template.ts";
import { newDmnXml } from "../src/domain/dmn-template.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import { loadContentConfig } from "../src/repos/content.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};
const PATH = "processes/order.bpmn";
const ROOM = `${REPO.fullName}/${PATH}`;

// Hocuspocus keeps event-loop handles until destroyed — without this teardown
// the suite passes but the node:test process never exits
const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.destroy()));
  // WATCHDOG: Hocuspocus can leave a poisoned debounce/save-mutex handle behind
  // after its async-unload race (docs: content.ts roomQueues) — a PASSED suite
  // must never hang the runner on it. unref'd: a clean exit ignores it.
  setTimeout(() => process.exit(), 2000).unref();
});

/** tmpdir content repo + real Hocuspocus (hooks wired like server.ts) */
function setup(over: { contentRepo?: boolean; maxDocBytes?: number } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "bpm-content-"));
  mkdirSync(join(ws, "processes"), { recursive: true });
  if (over.contentRepo !== false) writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
  const liveDocs = new Set<string>();
  const lineage = new LineageStore(new DatabaseSync(":memory:"), REPO.fullName);
  const registry = { get: (n: string) => (n.toLowerCase() === REPO.fullName ? REPO : undefined) };
  const workspaces = { ensure: async () => ws };
  const hp = new Server({
    ...makeCollabHooks({
      lineage,
      docGuard: new DocSizeGuard(8_000_000),
      maxDocBytes: 8_000_000,
      sessions: { get: () => undefined },
      access: { canWrite: async () => true },
      registry,
      workspaces,
      contentConfig: loadContentConfig,
      devToken: () => undefined,
      liveDocs,
    }),
  });
  servers.push(hp);
  const deps: ContentDeps = {
    registry,
    workspaces,
    openDoc: (room) => hp.hocuspocus.openDirectConnection(room),
    maxDocBytes: over.maxDocBytes ?? 8_000_000,
  };
  return { ws, deps, hp, liveDocs, lineage };
}

const VALID = newBpmnXml("order", "Order");
const VALID_V2 = newBpmnXml("order", "Order v2");
/** the blank-decision template — validator-clean, like its BPMN sibling */
const VALID_DMN = newDmnXml("price", "Price");

/** peer-open with the same open-during-unload retry the use-case applies —
 *  Hocuspocus can hand out a doc whose async unload is still in flight */
async function openPeer(hp: Server, room: string) {
  for (let i = 0; ; i++) {
    const conn = await hp.hocuspocus.openDirectConnection(room);
    if (!conn.document?.isDestroyed) return conn;
    await conn.disconnect().catch(() => undefined);
    if (i >= 3) throw new Error(`room is stuck unloading: ${room}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── GET ─────────────────────────────────────────────────────────────────────

test("getContent seeds from disk, returns a stable token, and unloads the doc (liveDocs symmetry)", async () => {
  const { ws, deps, liveDocs } = setup();
  writeFileSync(join(ws, PATH), VALID);

  const a = await getContent(deps, REPO, PATH);
  assert.equal(a.xml, VALID);
  assert.equal(a.repo, REPO.fullName);
  assert.equal(a.path, PATH);
  assert.ok(a.baseVersion.length > 20, "opaque content-derived token");

  const b = await getContent(deps, REPO, PATH);
  assert.equal(b.baseVersion, a.baseVersion, "no edit → same token");
  assert.equal(liveDocs.size, 0, "direct connection released the room");
});

test("getContent: missing file → 404, bad extension → 400, no bpmiq.yml → 422", async () => {
  const { deps } = setup();
  await assert.rejects(
    () => getContent(deps, REPO, "processes/ghost.bpmn"),
    (e: AppError) => e.code === "content/not-found" && e.status === 404,
  );
  await assert.rejects(
    () => getContent(deps, REPO, "processes/evil.exe"),
    (e: AppError) => e.code === "content/invalid-path" && e.status === 400,
  );
  const bare = setup({ contentRepo: false });
  writeFileSync(join(bare.ws, PATH), VALID);
  await assert.rejects(
    () => getContent(bare.deps, REPO, PATH),
    (e: AppError) => e.code === "content/not-a-content-repo" && e.status === 422,
  );
});

// ── PUT: happy path + CAS ───────────────────────────────────────────────────

test("putContent with a fresh token writes through to disk BEFORE returning (disconnect-forced store)", async () => {
  const { ws, deps, lineage } = setup();
  writeFileSync(join(ws, PATH), VALID);

  const got = await getContent(deps, REPO, PATH);
  const out = await putContent(deps, REPO, PATH, { xml: VALID_V2, baseVersion: got.baseVersion });
  assert.ok(out.ok);
  assert.notEqual(out.result.baseVersion, got.baseVersion, "token moved");
  assert.deepEqual(out.result.warnings, []);
  // the write-through is complete when the PUT returns — no debounce window
  assert.equal(await readFile(join(ws, PATH), "utf8"), VALID_V2);
  assert.ok(lineage.load(ROOM), "lineage persisted");
});

test("putContent with a stale token conflicts and writes NOTHING", async () => {
  const { ws, deps } = setup();
  writeFileSync(join(ws, PATH), VALID);

  const got = await getContent(deps, REPO, PATH);
  const first = await putContent(deps, REPO, PATH, { xml: VALID_V2, baseVersion: got.baseVersion });
  assert.ok(first.ok);

  // retry with the CONSUMED token → conflict carrying the current content
  const stale = await putContent(deps, REPO, PATH, { xml: VALID, baseVersion: got.baseVersion });
  assert.ok(!stale.ok);
  assert.equal(stale.conflict.code, "content/conflict");
  assert.equal(stale.conflict.currentXml, VALID_V2);
  assert.equal(await readFile(join(ws, PATH), "utf8"), VALID_V2, "no write on conflict");
});

test("REGRESSION: a DELETE-ONLY remote edit invalidates the token (a state-vector token would be blind to it)", async () => {
  const { ws, deps, hp } = setup();
  writeFileSync(join(ws, PATH), VALID);
  const got = await getContent(deps, REPO, PATH);

  // a co-editor deletes characters — nothing inserted, so a state-vector token
  // would not move; only a content-derived token can catch this
  const peer = await openPeer(hp, ROOM);
  await peer.transact((doc) => {
    doc.getText(CONTENT_KEY).delete(0, 10);
  });
  await peer.disconnect();

  const put = await putContent(deps, REPO, PATH, { xml: VALID_V2, baseVersion: got.baseVersion });
  assert.ok(!put.ok, "stale read must NOT overwrite the deletion");
  assert.equal(put.conflict.currentXml, VALID.slice(10));
});

test("putContent broadcasts into a shared live doc and keeps a co-holder's room alive", async () => {
  const { ws, deps, hp, liveDocs } = setup();
  writeFileSync(join(ws, PATH), VALID);

  // the co-editor holds the room FIRST (like a ws client would) — it pins the
  // doc, so every subsequent REST/MCP op joins the SAME live instance. (Holding
  // a raw direct connection ACROSS op open/close boundaries instead would race
  // Hocuspocus' async unload — a lifecycle the product paths never enter.)
  const peer = await openPeer(hp, ROOM);
  const got = await getContent(deps, REPO, PATH);
  const out = await putContent(deps, REPO, PATH, { xml: VALID_V2, baseVersion: got.baseVersion });
  assert.ok(out.ok);
  // the peer sees the edit in the SAME doc, and its hold keeps the room live
  let seen = "";
  await peer.transact((doc) => {
    seen = doc.getText(CONTENT_KEY).toString();
  });
  assert.equal(seen, VALID_V2);
  assert.ok(liveDocs.has(ROOM), "room stays live while a peer holds it");
  await peer.disconnect();
  assert.ok(!liveDocs.has(ROOM), "released after the last holder");
});

// ── PUT: gates ──────────────────────────────────────────────────────────────

test("putContent gates: baseVersion required, validation 422 (BPMN and DMN), size cap 413", async () => {
  const { ws, deps } = setup();
  writeFileSync(join(ws, PATH), VALID);
  const got = await getContent(deps, REPO, PATH);

  await assert.rejects(
    () => putContent(deps, REPO, PATH, { xml: VALID_V2 } as never),
    (e: AppError) => e.code === "content/base-version-required" && e.status === 400,
  );
  await assert.rejects(
    () => putContent(deps, REPO, PATH, { xml: "<not-bpmn/>", baseVersion: got.baseVersion }),
    (e: AppError) => e.code === "content/invalid-model" && e.status === 422 && /validation failed/.test(e.message),
  );
  assert.equal(await readFile(join(ws, PATH), "utf8"), VALID, "rejected writes never touch the doc");

  const capped = { ...deps, maxDocBytes: 50 };
  await assert.rejects(
    () => putContent(capped, REPO, PATH, { xml: VALID_V2, baseVersion: got.baseVersion }),
    (e: AppError) => e.code === "content/too-large" && e.status === 413,
  );

  // .dmn goes through the DMN validator on the same write path as BPMN
  writeFileSync(join(ws, "processes", "price.dmn"), VALID_DMN);
  const dmn = await getContent(deps, REPO, "processes/price.dmn");
  await assert.rejects(
    () => putContent(deps, REPO, "processes/price.dmn", { xml: "<definitions/>", baseVersion: dmn.baseVersion }),
    (e: AppError) => e.code === "content/invalid-model" && /no <decision> element/.test(e.message),
  );
  const saved = await putContent(deps, REPO, "processes/price.dmn", {
    xml: VALID_DMN.replace('name="Price"', 'name="Price v2"'),
    baseVersion: dmn.baseVersion,
  });
  assert.ok(saved.ok);
  assert.deepEqual(saved.result.warnings, []);

  // markdown IS a registered notation, but one without a check — checkModel
  // returns [] and the save passes through untouched
  writeFileSync(join(ws, "processes", "notes.md"), "# notes");
  const md = await getContent(deps, REPO, "processes/notes.md");
  const note = await putContent(deps, REPO, "processes/notes.md", { xml: "# more", baseVersion: md.baseVersion });
  assert.ok(note.ok);
});

test("putContent gates EVERY notation through checkModel — the save path and `pnpm validate` agree", async () => {
  const { ws, deps } = setup();
  // (a) a broken .tt is refused exactly like the CLI errors it (baseline gate)
  writeFileSync(join(ws, "processes", "teams.tt"), "{}");
  const tt = await getContent(deps, REPO, "processes/teams.tt");
  await assert.rejects(
    () => putContent(deps, REPO, "processes/teams.tt", { xml: "{ broken", baseVersion: tt.baseVersion }),
    (e: AppError) => e.code === "content/invalid-model" && /not parseable as JSON/.test(e.message),
  );
  const ttOk = await putContent(deps, REPO, "processes/teams.tt", {
    xml: '{"nodes": []}',
    baseVersion: tt.baseVersion,
  });
  assert.ok(ttOk.ok);

  // (b) the BPMN link warnings ride the repo-wide id scan: a callActivity
  // calling a process that EXISTS stays clean, a dangling one warns — the
  // lintModel modelIds aggregation is observed end-to-end, not implied
  const CALLER = VALID.replace(
    /<bpmn:process id="order"([^>]*)>/,
    '<bpmn:process id="order"$1><bpmn:callActivity id="Call_1" calledElement="no-such-process"><bpmn:incoming>Flow_1b</bpmn:incoming><bpmn:outgoing>Flow_1c</bpmn:outgoing></bpmn:callActivity>',
  );
  writeFileSync(join(ws, PATH), VALID);
  const got = await getContent(deps, REPO, PATH);
  const saved = await putContent(deps, REPO, PATH, { xml: CALLER, baseVersion: got.baseVersion, lint: "warn" });
  assert.ok(saved.ok);
  assert.ok(
    saved.result.errors?.some((m) => /calls 'no-such-process'/.test(m)) ||
      saved.result.warnings.some((m) => /calls 'no-such-process'/.test(m)),
    `expected the dangling-callActivity warning, got: ${JSON.stringify(saved.result)}`,
  );
});

test("putContent lint:'warn' saves an invalid model and reports the errors instead of refusing", async () => {
  const { ws, deps } = setup();
  writeFileSync(join(ws, PATH), VALID);
  const got = await getContent(deps, REPO, PATH);

  // the same XML the strict gate refuses with 422 saves under lint:"warn" —
  // the widget-autosave trust level equals the ws rooms, which never gated
  const saved = await putContent(deps, REPO, PATH, {
    xml: "<not-bpmn/>",
    baseVersion: got.baseVersion,
    lint: "warn",
  });
  assert.ok(saved.ok, "warn mode must not refuse");
  assert.ok((saved.result.errors?.length ?? 0) > 0, "errors are reported on the result");

  // the write really landed (and minted a new token)
  const after = await getContent(deps, REPO, PATH);
  assert.equal(after.xml, "<not-bpmn/>");
  assert.notEqual(after.baseVersion, got.baseVersion);
});
