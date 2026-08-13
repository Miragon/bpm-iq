/**
 * decisionImpact — the release PR's decision commentary. The claim under test
 * is the one that matters for a reviewer: a DMN edit that changes what the
 * decision ANSWERS shows up as a before/after table, and one that does not
 * says so.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decisionImpact } from "../src/application/decision-impact.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};

const DMN_PATH = "processes/rabatt.dmn";
const dmn = (threshold: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_rabatt" name="Rabatt" namespace="http://bpmiq.dev/dmn/rabatt">
  <decision id="rabatt" name="Rabatt">
    <decisionTable id="DT_rabatt" hitPolicy="FIRST">
      <input id="Input_1" label="Bestellwert">
        <inputExpression id="IE_1" typeRef="number"><text>bestellwert</text></inputExpression>
      </input>
      <output id="Output_1" name="rabatt" typeRef="number" />
      <rule id="Rule_gross">
        <inputEntry id="e1"><text>&gt;= ${threshold}</text></inputEntry>
        <outputEntry id="e2"><text>10</text></outputEntry>
      </rule>
      <rule id="Rule_klein">
        <inputEntry id="e3"><text>-</text></inputEntry>
        <outputEntry id="e4"><text>0</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
</definitions>`;

const SUITE = `decision: rabatt
cases:
  - name: Grosser Auftrag
    given: { bestellwert: 500 }
    expect: { value: 10 }
  - name: Kleiner Auftrag
    given: { bestellwert: 50 }
    expect: { value: 0 }
`;

/** a workspace holding the NEW version, plus a fake git for the old one */
// `null` = no suite at all; an explicit `undefined` would re-trigger the default
function setup(current: string, previous?: string, suite: string | null = SUITE) {
  const ws = mkdtempSync(join(tmpdir(), "bpm-impact-"));
  mkdirSync(join(ws, "processes"), { recursive: true });
  writeFileSync(join(ws, DMN_PATH), current);
  if (suite !== null) writeFileSync(join(ws, "processes", "rabatt.tests.yaml"), suite);
  const deps = {
    workspaces: {
      fileAtCommit: async (_repo: ConnectedRepo, path: string, sha: string) => {
        assert.equal(sha, "origin/main", "the comparison base is the default branch");
        return path === DMN_PATH ? (previous ?? null) : null;
      },
    },
  };
  return { ws, deps };
}

test("a threshold change comes back as a before/after table", async () => {
  const { ws, deps } = setup(dmn("100"), dmn("1000"));
  const body = await decisionImpact(deps, REPO, ws, [DMN_PATH]);

  assert.match(body, /## Decision impact/);
  assert.match(body, /2 test case\(s\): 2 pass/);
  assert.match(body, /1 case\(s\) decide differently than on `main`/);
  assert.match(body, /\| Grosser Auftrag \| `0` \| `10` \|/, "the case that moved, with both answers");
  assert.doesNotMatch(body, /Kleiner Auftrag/, "cases that did not move stay out of the table");
});

test("a cosmetic change reports that nothing decides differently", async () => {
  const renamed = dmn("100").replace('name="Rabatt"', 'name="Rabattermittlung"');
  const { ws, deps } = setup(renamed, dmn("100"));
  const body = await decisionImpact(deps, REPO, ws, [DMN_PATH]);
  assert.match(body, /every existing case decides exactly as before/);
});

test("a failing suite is called out — the release ships a decision its own tests reject", async () => {
  const { ws, deps } = setup(dmn("1000"), dmn("1000"));
  const body = await decisionImpact(deps, REPO, ws, [DMN_PATH]);
  assert.match(body, /\*\*1 FAILING\*\*/);
});

test("no tests, a new decision, and broken FEEL each get their own line", async () => {
  const noTests = setup(dmn("100"), dmn("100"), null);
  assert.match(await decisionImpact(noTests.deps, REPO, noTests.ws, [DMN_PATH]), /no test cases .*nothing pins/);

  const brandNew = setup(dmn("100"), undefined);
  assert.match(await decisionImpact(brandNew.deps, REPO, brandNew.ws, [DMN_PATH]), /new decision — no previous/);

  const broken = setup(dmn("100").replace("<text>&gt;= 100</text>", "<text>&gt;= </text>"), dmn("100"));
  assert.match(await decisionImpact(broken.deps, REPO, broken.ws, [DMN_PATH]), /❌ .*not a valid FEEL unary test/);
});

test("only decisions produce a section — and a changed suite alone counts as one", async () => {
  const { ws, deps } = setup(dmn("100"), dmn("100"));
  assert.equal(await decisionImpact(deps, REPO, ws, ["processes/order.bpmn"]), "", "a BPMN-only release says nothing");
  assert.match(
    await decisionImpact(deps, REPO, ws, ["processes/rabatt.tests.yaml"]),
    /`processes\/rabatt.dmn`/,
    "a test-only change is reported against its model",
  );
  // without fileAtCommit (an injected fake that cannot read git) the section
  // degrades instead of failing the release
  const blind = await decisionImpact({ workspaces: {} }, REPO, ws, [DMN_PATH]);
  assert.match(blind, /2 test case\(s\): 2 pass/);
  assert.match(blind, /new decision — no previous version/);
});
