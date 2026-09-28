/**
 * The per-file catch-up decision (src/domain/catch-up.ts, #185) — pure, no
 * git. The git mechanics around it (index writes, the fast-forward, the
 * conflict list) are covered against real repos in workspaces.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  catchUpAction,
  indexTarget,
  parks,
  parseIndex,
  parseRawDiff,
  releasedAfter,
  type UpstreamChange,
} from "../src/domain/catch-up.ts";

const [H, M, R, W] = ["h".repeat(40), "m".repeat(40), "r".repeat(40), "w".repeat(40)];

/** a file upstream changed from H to M, no local activity */
const change = (over: Partial<UpstreamChange>): UpstreamChange => ({
  path: "processes/order.bpmn",
  head: H,
  upstream: M,
  upstreamMode: "100644",
  index: H,
  tree: H,
  released: [],
  ...over,
});

test("catchUpAction: untouched locally → take upstream's version", () => {
  assert.equal(catchUpAction(change({})), "take");
  // brand-new upstream file, nothing local in the way
  assert.equal(catchUpAction(change({ head: null, index: null, tree: null })), "take");
  // deleted upstream, untouched locally
  assert.equal(catchUpAction(change({ upstream: null, upstreamMode: null })), "take");
});

test("catchUpAction: the working tree already holds upstream → converged (the merged release)", () => {
  assert.equal(catchUpAction(change({ tree: M })), "converged", "released unmarked, merged unchanged");
  assert.equal(catchUpAction(change({ index: M, tree: M })), "converged", "released + marked, merged");
  assert.equal(
    catchUpAction(change({ upstream: null, upstreamMode: null, tree: null })),
    "converged",
    "a released deletion, merged",
  );
});

test("catchUpAction: released, merged, edited on → keep (only the new edits stay a change)", () => {
  assert.equal(catchUpAction(change({ index: M, tree: W, released: [M] })), "keep");
});

test("catchUpAction: an earlier release merged while a later one is open → keep, not conflict", () => {
  assert.equal(catchUpAction(change({ index: R, tree: R, released: [M, R] })), "keep", "released twice, first merged");
  assert.equal(catchUpAction(change({ index: R, tree: W, released: [M, R] })), "keep", "…and edited on since");
  assert.equal(
    catchUpAction(change({ head: null, index: null, tree: null, released: [M, null] })),
    "keep",
    "a new file released, then its deletion released — it must not come back",
  );
  assert.equal(
    catchUpAction(change({ upstream: null, upstreamMode: null, index: W, tree: W, released: [null, W] })),
    "keep",
    "a deletion released, then the file re-created and released",
  );
});

test("catchUpAction: changed on both sides → conflict", () => {
  assert.equal(catchUpAction(change({ tree: W })), "conflict", "unreleased edit, upstream changed it too");
  assert.equal(catchUpAction(change({ tree: null })), "conflict", "deleted locally, changed upstream");
  assert.equal(
    catchUpAction(change({ upstream: null, upstreamMode: null, tree: W })),
    "conflict",
    "edited locally, deleted upstream",
  );
  assert.equal(
    catchUpAction(change({ head: null, index: null, tree: W })),
    "conflict",
    "a local new file and a different upstream file of the same name",
  );
  assert.equal(
    catchUpAction(change({ index: R, tree: R, released: [R] })),
    "conflict",
    "released, but the PR was changed before the merge (or main moved meanwhile)",
  );
  assert.equal(
    catchUpAction(change({ index: R, tree: H, released: [R] })),
    "conflict",
    "reverted after the release — the release mark is the base, not HEAD",
  );
});

test("indexTarget: every non-take file ends on upstream's entry, removal when upstream deleted", () => {
  assert.equal(indexTarget(change({}), "take"), undefined, "the fast-forward writes it");
  assert.equal(indexTarget(change({ index: M, tree: W }), "keep"), undefined, "already there");
  assert.deepEqual(
    indexTarget(change({ index: R, tree: W, released: [M, R] }), "keep"),
    { mode: "100644", blob: M },
    "an earlier release merged — its blob becomes the base again",
  );
  assert.deepEqual(indexTarget(change({ tree: M }), "converged"), { mode: "100644", blob: M });
  assert.equal(indexTarget(change({ index: M, tree: M }), "converged"), undefined, "already there");
  assert.deepEqual(indexTarget(change({ tree: W }), "conflict"), { mode: "100644", blob: M });
  assert.equal(
    indexTarget(change({ upstream: null, upstreamMode: null, tree: W }), "conflict"),
    null,
    "upstream deleted it — the entry goes, the local file stays (untracked)",
  );
});

test("parks: a local file at a path upstream deletes — by state, whatever the action", () => {
  const deleted = { upstream: null, upstreamMode: null };
  const edited = change({ ...deleted, tree: W });
  assert.equal(parks(edited, catchUpAction(edited)), true, "edited here, deleted upstream (conflict)");
  const retried = change({ ...deleted, index: null, tree: W });
  assert.equal(catchUpAction(retried), "keep", "a retry after a failed fast-forward: the entry is gone already");
  assert.equal(parks(retried, "keep"), true);
  const recreated = change({ ...deleted, index: null, tree: W, released: [null] });
  assert.equal(parks(recreated, catchUpAction(recreated)), true, "a released deletion, re-created before the merge");
  assert.equal(parks(change(deleted), "take"), false, "untouched: git deletes it itself");
  assert.equal(parks(change({ ...deleted, tree: null }), "converged"), false, "gone here too");
  assert.equal(parks(change({ tree: W }), "conflict"), false, "upstream keeps the file — no untracked collision");
});

test("releasedAfter: a reached release drains itself and every older one; anything else ends the list", () => {
  assert.deepEqual(releasedAfter(change({ released: [M] })), [], "the only release merged");
  assert.deepEqual(releasedAfter(change({ released: [M, R] })), [R], "the later release is still open");
  assert.deepEqual(
    releasedAfter(change({ released: [R, M] })),
    [],
    "the later one merged — the older can no longer be the base",
  );
  assert.deepEqual(releasedAfter(change({ released: [R] })), [], "upstream changed it otherwise");
  assert.deepEqual(releasedAfter(change({ upstream: null, released: [M, null] })), [], "a shipped deletion merged");
  assert.deepEqual(releasedAfter(change({})), []);
});

test("parseRawDiff: diff-tree -z records, all-zero ids/modes are absent sides", () => {
  const zero = "0".repeat(40);
  const raw =
    `:100644 100644 ${H} ${M} M\x00processes/a b.bpmn\x00` +
    `:000000 100644 ${zero} ${M} A\x00processes/new.dmn\x00` +
    `:100644 000000 ${H} ${zero} D\x00processes/gone.bpmn\x00`;
  assert.deepEqual(parseRawDiff(raw), [
    { path: "processes/a b.bpmn", head: H, upstream: M, upstreamMode: "100644" },
    { path: "processes/new.dmn", head: null, upstream: M, upstreamMode: "100644" },
    { path: "processes/gone.bpmn", head: H, upstream: null, upstreamMode: null },
  ]);
  assert.deepEqual(parseRawDiff(""), []);
});

test("parseIndex: ls-files -s -z → path → stage-0 id (unmerged stages ignored)", () => {
  const raw = `100644 ${H} 0\tprocesses/prüfung.dmn\x00100644 ${R} 1\tprocesses/x.bpmn\x00100644 ${M} 0\tbpmiq.yml\x00`;
  assert.deepEqual(
    parseIndex(raw),
    new Map([
      ["processes/prüfung.dmn", H],
      ["bpmiq.yml", M],
    ]),
  );
});
