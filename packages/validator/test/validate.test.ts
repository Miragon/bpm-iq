/**
 * CLI-level tests for the platform validator, run against the checked-in
 * fixture content repo (test/fixtures/content-repo). The fixture deliberately
 * contains the two model shapes that once produced false positives:
 *   - order-to-cash carries a textAnnotation + association + data object
 *   - two-pool is a collaboration (two pools, message flow, embedded sub-process)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATE = resolve(HERE, "..", "src", "validate.ts");
const FIXTURE = resolve(HERE, "fixtures", "content-repo");

function run(args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [VALIDATE, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** copy the fixture into a temp dir so a test can mutate it */
function mutableFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "validator-fixture-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

test("fixture repo validates green (artifacts + collaboration are legal)", () => {
  const { status, out } = run(["--root", FIXTURE]);
  assert.equal(status, 0, out);
  assert.match(out, /0 error\(s\)/);
  assert.match(out, /2 process\(es\) checked/);
});

test("two-pool collaboration is parsed per pool, not flagged bogus", () => {
  const { status, out } = run(["--root", FIXTURE, "two-pool"]);
  assert.equal(status, 0, out);
  assert.doesNotMatch(out, /expected exactly one start event/);
  assert.doesNotMatch(out, /unreachable/);
});

test("unknown process id fails instead of reporting OK", () => {
  const { status, out } = run(["--root", FIXTURE, "no-such-process"]);
  assert.equal(status, 1);
  assert.match(out, /unknown process id 'no-such-process'/);
  assert.match(out, /0 process\(es\) checked/);
});

test("--root without a processes/ directory fails gracefully", () => {
  const { status, out } = run(["--root", tmpdir()]);
  assert.equal(status, 1);
  assert.match(out, /no processes\/ directory/);
  assert.doesNotMatch(out, /at .*validate\.ts/); // no stacktrace
});

test("--root without a value fails with a clear message", () => {
  const { status, out } = run(["--root"]);
  assert.equal(status, 2);
  assert.match(out, /--root requires a directory argument/);
});

test("missing BPMNDI for an artifact is an error (breaks the editor)", () => {
  const dir = mutableFixture();
  try {
    const bpmn = join(dir, "processes", "order-to-cash", "order-to-cash.bpmn");
    writeFileSync(
      bpmn,
      readFileSync(bpmn, "utf8").replace(
        /[ \t]*<bpmndi:BPMNShape id="TextAnnotation_note_di"[\s\S]*?<\/bpmndi:BPMNShape>\n/,
        "",
      ),
    );
    const { status, out } = run(["--root", dir, "order-to-cash"]);
    assert.equal(status, 1);
    assert.match(out, /TextAnnotation_note has no BPMNDI/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model change semantics: sequenceFlow to a missing node is an error", () => {
  const dir = mutableFixture();
  try {
    const bpmn = join(dir, "processes", "two-pool", "two-pool.bpmn");
    writeFileSync(bpmn, readFileSync(bpmn, "utf8").replace('targetRef="EndEvent_customer"', 'targetRef="Ghost_node"'));
    const { status, out } = run(["--root", dir, "two-pool"]);
    assert.equal(status, 1);
    assert.match(out, /references missing node 'Ghost_node'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("declared DMN decision id must exist in the DMN file", () => {
  const dir = mutableFixture();
  try {
    const pyaml = join(dir, "processes", "order-to-cash", "process.yaml");
    writeFileSync(pyaml, readFileSync(pyaml, "utf8").replace("- id: credit-check", "- id: credit-check-typo"));
    const { status, out } = run(["--root", dir, "order-to-cash"]);
    assert.equal(status, 1);
    assert.match(out, /decision 'credit-check-typo' not found in decisions\/credit-check\.dmn/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
