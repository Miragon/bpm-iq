/**
 * The shared CLI error line for a root that is not a content repo — printed
 * by the validator AND the decisions gate, so `pnpm validate` says the same
 * thing twice or not at all. It must name the file that is actually broken,
 * never call a file missing that the reader just wrote.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { notContentRepoError } from "../cli.ts";

const ws = (): string => mkdtempSync(join(tmpdir(), "notations-cli-"));

test("notContentRepoError: no contract file at all names both accepted names", () => {
  const w = ws();
  assert.equal(
    notContentRepoError(w),
    `[ERROR] ${w}: no designiq.yml (or legacy bpmiq.yml) at the root — not a content repo (or wrong --root)`, // legacy-name-ok: pins the legacy wording
  );
});

test("notContentRepoError: an unusable designiq.yml is named as the problem", () => {
  const w = ws();
  writeFileSync(join(w, "designiq.yml"), "models: [unclosed\n");
  // the valid legacy file beside it is never consulted — and never blamed
  writeFileSync(join(w, "bpmiq.yml"), "processes: processes\n"); // legacy-name-ok: pins the legacy path
  assert.equal(
    notContentRepoError(w),
    `[ERROR] ${w}: designiq.yml at the root names no models folder — not a content repo (or wrong --root)`,
  );
});

test("notContentRepoError: an unusable legacy file is named as the problem too", () => {
  const w = ws();
  writeFileSync(join(w, "bpmiq.yml"), "processes: [1,2]\n"); // legacy-name-ok: pins the legacy path
  assert.equal(
    notContentRepoError(w),
    `[ERROR] ${w}: bpmiq.yml at the root names no models folder — not a content repo (or wrong --root)`, // legacy-name-ok: pins the legacy path
  );
});
