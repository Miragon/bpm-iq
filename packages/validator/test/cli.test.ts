/**
 * Regression: the published bin must actually validate when invoked through a
 * SYMLINK (npx / pnpm bin shims). The old entry guard compared import.meta.url
 * (realpathed by Node) against argv[1] (the symlink path) and silently exited 0
 * without checking anything — a false green on a quality gate.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const FIXTURE = resolve(import.meta.dirname, "fixtures/content-repo");

test("bin run through a symlink validates for real (exit 0 AND real output)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bpmiq-validate-"));
  const link = join(dir, "bpmiq-validate");
  symlinkSync(CLI, link);
  const r = spawnSync(process.execPath, [link, "--root", FIXTURE], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // the actual regression guard: the old bug exited 0 with EMPTY output
  assert.match(r.stdout, /\d+ process\(es\)/);
  assert.doesNotMatch(r.stdout, /0 process\(es\)/);
});

test("bin fails loudly on a non-content root", () => {
  const dir = mkdtempSync(join(tmpdir(), "bpmiq-validate-empty-"));
  const r = spawnSync(process.execPath, [CLI, "--root", dir], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no bpmiq\.yml/);
});
