/**
 * Release pure sub-logic (src/release.ts) — the security/attribution decisions
 * that used to be buried inside the release() orchestration and were only covered
 * by the release-e2e.sh integration test. The git/network orchestration stays
 * e2e-tested; these cover the branch points a wrong edit could silently break.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  noreplyEmail,
  parseStagedFiles,
  redactToken,
  releaseBranch,
  releaseCommitMessage,
  releaseFilesBranch,
  releaseFilesPrBody,
  releaseFilesSlug,
  releaseFilesSubject,
  releasePrBody,
} from "../src/release.ts";

test("releaseBranch: stamps the branch to the minute (UTC)", () => {
  assert.equal(
    releaseBranch("order-flow", new Date("2026-07-14T08:45:30.123Z")),
    "release/order-flow-2026-07-14-08-45",
  );
});

test("parseStagedFiles: trims, drops blanks", () => {
  assert.deepEqual(parseStagedFiles("a.bpmn\n  processes/b.bpmn \n\n"), ["a.bpmn", "processes/b.bpmn"]);
  assert.deepEqual(parseStagedFiles(""), []);
});

test("redactToken: strips the push token a git error might echo", () => {
  const msg = "fatal: unable to access 'https://x-access-token:ghp_SECRET@github.com/acme/r': 403";
  const red = redactToken(msg, "ghp_SECRET");
  assert.ok(!red.includes("ghp_SECRET"));
  assert.ok(red.includes("«redacted»"));
  assert.equal(redactToken(msg, undefined), msg); // nothing to redact
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
});

test("releaseFilesSlug: title wins, else lone file stem, else 'changes'", () => {
  assert.equal(releaseFilesSlug(["a.bpmn"], "Q3 Credit Rules!"), "q3-credit-rules");
  assert.equal(releaseFilesSlug(["processes/orders/credit-check.dmn"]), "credit-check");
  assert.equal(releaseFilesSlug(["a.bpmn", "b.dmn"]), "changes");
  assert.equal(releaseFilesSlug(["..."], "!!!"), "changes"); // nothing slug-able anywhere
});

test("releaseFilesSlug: caps runaway titles so the git ref stays well under NAME_MAX", () => {
  const slug = releaseFilesSlug(["a.bpmn"], "x".repeat(400));
  assert.ok(slug.length <= 60, `slug too long: ${slug.length}`);
  assert.ok(!slug.endsWith("-"), "no dangling separator after the cut");
});

test("releaseFilesBranch: stamps to the SECOND (untitled selections share one slug)", () => {
  assert.equal(
    releaseFilesBranch("changes", new Date("2026-07-14T08:45:30.123Z")),
    "release/changes-2026-07-14-08-45-30",
  );
});

test("releaseFilesSubject: optional title becomes the headline", () => {
  assert.equal(releaseFilesSubject("Q3 credit rules"), "release: Q3 credit rules");
  assert.equal(releaseFilesSubject("   "), "release: publish live model state");
  assert.equal(releaseFilesSubject(undefined), "release: publish live model state");
});

test("releaseFilesPrBody: lists every shipped file, marks deletions", () => {
  const body = releaseFilesPrBody(
    [
      { path: "processes/a.bpmn", deleted: false },
      { path: "processes/old.dmn", deleted: true },
    ],
    "acme/models",
    "ada",
    true,
  );
  assert.ok(body.includes("- `processes/a.bpmn`"));
  assert.ok(body.includes("- `processes/old.dmn` (deleted)"));
  assert.ok(body.includes("you can approve this PR yourself"));
});
