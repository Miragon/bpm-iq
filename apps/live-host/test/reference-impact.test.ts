/**
 * The release PR's reference section (application/reference-impact.ts) — the
 * notation-agnostic sibling of decision-impact. Pinned: incoming references
 * of shipped files render, a shipped DELETE flags the referrers it leaves
 * dangling, and everything degrades to "" instead of failing a release.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { referenceImpact } from "../src/application/reference-impact.ts";

const CALLER = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="P">
    <businessRuleTask id="Rule_1" calledDecision="credit-check"/>
  </process>
</definitions>`;

function repo(): string {
  const ws = mkdtempSync(join(tmpdir(), "bpm-refimpact-"));
  writeFileSync(join(ws, "bpmiq.yml"), "processes: processes\n");
  mkdirSync(join(ws, "processes"), { recursive: true });
  writeFileSync(join(ws, "processes", "order.bpmn"), CALLER);
  writeFileSync(join(ws, "processes", "credit-check.dmn"), "<definitions/>");
  return ws;
}

test("referenceImpact: incoming references of a shipped model render as a section", async () => {
  const ws = repo();
  const section = await referenceImpact(ws, ["processes/credit-check.dmn"]);
  assert.match(section, /### Referenced by/);
  assert.match(section, /`processes\/credit-check\.dmn` is referenced by `processes\/order\.bpmn` \(Rule_1 decides\)/);
  assert.doesNotMatch(section, /dangling/);
});

test("referenceImpact: a shipped DELETE flags the referrers it leaves dangling", async () => {
  const ws = repo();
  rmSync(join(ws, "processes", "credit-check.dmn")); // the release ships this delete
  const section = await referenceImpact(ws, ["processes/credit-check.dmn"]);
  assert.match(section, /left dangling by this release/);
  assert.match(section, /`processes\/order\.bpmn`/);
});

test("referenceImpact: unreferenced files and non-content repos degrade to ''", async () => {
  const ws = repo();
  assert.equal(await referenceImpact(ws, ["processes/order.bpmn"]), "", "order.bpmn has no incoming refs");
  const bare = mkdtempSync(join(tmpdir(), "bpm-refimpact-bare-"));
  assert.equal(await referenceImpact(bare, ["anything.bpmn"]), "");
});
