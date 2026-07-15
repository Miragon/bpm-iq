/**
 * Release pure sub-logic (src/release.ts) — the governance + security decisions
 * that used to be buried inside the release() orchestration and were only covered
 * by the release-e2e.sh integration test. The git/network orchestration stays
 * e2e-tested; these cover the branch points a wrong edit could silently break.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasModelChange,
  needsVersionBump,
  noreplyEmail,
  parseStagedFiles,
  redactToken,
  releaseBranch,
  releaseCommitMessage,
  releasePrBody,
  validatorFindings,
} from "../src/release.ts";

test("releaseBranch: stamps the branch to the minute (UTC)", () => {
  assert.equal(
    releaseBranch("order-flow", new Date("2026-07-14T08:45:30.123Z")),
    "release/order-flow-2026-07-14-08-45",
  );
});

test("parseStagedFiles: trims, drops blanks", () => {
  assert.deepEqual(parseStagedFiles("a.bpmn\n  processes/x/b.yaml \n\n"), ["a.bpmn", "processes/x/b.yaml"]);
  assert.deepEqual(parseStagedFiles(""), []);
});

test("hasModelChange: true only for model extensions", () => {
  for (const f of ["processes/x/x.bpmn", "d.dmn", "m.owm", "t.tt", "chain.vc.json"]) {
    assert.equal(hasModelChange([f]), true, f);
  }
  for (const f of ["process.yaml", "docs/readme.md", "data.json"]) {
    assert.equal(hasModelChange([f]), false, f);
  }
  assert.equal(hasModelChange(["docs/readme.md", "x.bpmn"]), true, "any model file counts");
});

test("needsVersionBump: blocks a model change that kept the same version (Hard Rule 5)", () => {
  assert.equal(needsVersionBump(true, "1.0.0", "1.0.0"), true); // model changed, version unchanged → block
  assert.equal(needsVersionBump(true, "1.0.0", "1.1.0"), false); // bumped → allowed
  assert.equal(needsVersionBump(false, "1.0.0", "1.0.0"), false); // only docs changed → no bump needed
  assert.equal(needsVersionBump(true, undefined, "1.0.0"), false); // brand-new process (no base) → allowed
  assert.equal(needsVersionBump(true, 1, "1"), true); // number vs string are compared as strings
});

test("redactToken: strips the push token a git error might echo", () => {
  const msg = "fatal: unable to access 'https://x-access-token:ghp_SECRET@github.com/acme/r': 403";
  const red = redactToken(msg, "ghp_SECRET");
  assert.ok(!red.includes("ghp_SECRET"));
  assert.ok(red.includes("«redacted»"));
  assert.equal(redactToken(msg, undefined), msg); // nothing to redact
});

test("validatorFindings: keeps only the [..] finding lines", () => {
  assert.equal(
    validatorFindings("running\n[error] link broken\nok\n[warn] stale export"),
    "[error] link broken\n[warn] stale export",
  );
});

test("noreplyEmail: provider-scoped noreply address", () => {
  assert.equal(noreplyEmail("octocat", "github"), "octocat@users.noreply.github.com");
});

test("releaseCommitMessage: subject + human attribution + Co-authored-by trailer", () => {
  const msg = releaseCommitMessage("order-flow", "Ada Lovelace", "ada", "ada@users.noreply.github.com");
  assert.ok(msg.startsWith("release(order-flow): publish live model state"));
  assert.ok(msg.includes("Released by Ada Lovelace (@ada)"));
  assert.ok(msg.includes("Co-authored-by: Ada Lovelace <ada@users.noreply.github.com>"));
});

test("releasePrBody: bot-authored PRs advertise self-approval, user-token PRs do not", () => {
  const bot = releasePrBody("order-flow", "acme/models", "ada", true);
  assert.ok(bot.includes("you can approve this PR yourself"));
  const user = releasePrBody("order-flow", "acme/models", "ada", false);
  assert.ok(!user.includes("you can approve this PR yourself"));
  assert.ok(user.includes("merge = approval (CODEOWNERS)"));
  for (const body of [bot, user]) {
    assert.ok(body.includes("validated with the platform validator"));
    assert.ok(body.includes("redeploys portal + MCP"));
  }
});
