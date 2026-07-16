/**
 * CLI-level tests for the platform validator (the slim contract: bpmiq.yml +
 * .bpmn files, BPMN structure + BPMNDI coverage). Run against the checked-in
 * fixture content repo (test/fixtures/content-repo), which carries the two
 * model shapes that once produced false positives:
 *   - order-to-cash carries a textAnnotation + association + data object, and
 *     a callActivity that calls the invoice-handling sub-process
 *   - two-pool is a collaboration (two pools, message flow, embedded sub-process)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("fixture repo validates green (a process per .bpmn, artifacts + collaboration are legal)", () => {
  const { status, out } = run(["--root", FIXTURE]);
  assert.equal(status, 0, out);
  assert.match(out, /0 error\(s\)/);
  // three .bpmn files: order-to-cash, its invoice-handling sub-process, two-pool
  assert.match(out, /3 process\(es\) checked/);
});

test("two-pool collaboration is parsed per pool, not flagged bogus", () => {
  const { status, out } = run(["--root", FIXTURE, "two-pool"]);
  assert.equal(status, 0, out);
  assert.doesNotMatch(out, /expected exactly one start event/);
  assert.doesNotMatch(out, /unreachable/);
});

test("a callActivity that resolves to a real process raises no link warning", () => {
  // order-to-cash calls calledElement="invoice-handling", which IS a process here
  const { status, out } = run(["--root", FIXTURE, "order-to-cash"]);
  assert.equal(status, 0, out);
  assert.doesNotMatch(out, /which is not a process in this repo/);
});

test("unknown process id fails instead of reporting OK", () => {
  const { status, out } = run(["--root", FIXTURE, "no-such-process"]);
  assert.equal(status, 1);
  assert.match(out, /unknown process 'no-such-process'/);
});

test("--root without a bpmiq.yml fails gracefully (no stacktrace)", () => {
  const { status, out } = run(["--root", tmpdir()]);
  assert.equal(status, 1);
  assert.match(out, /no bpmiq\.yml/);
  assert.doesNotMatch(out, /at .*validate\.ts/);
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

test("a sequenceFlow to a missing node is an error", () => {
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

/** write a self-contained content repo (bpmiq.yml + one process) and validate it */
function loneProcess(id: string, bpmn: string): { status: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "validator-lone-"));
  try {
    writeFileSync(join(dir, "bpmiq.yml"), "processes: processes\n");
    mkdirSync(join(dir, "processes"), { recursive: true });
    writeFileSync(join(dir, "processes", `${id}.bpmn`), bpmn);
    return run(["--root", dir, id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an event sub-process is NOT flagged unreachable / dead end (it triggers itself)", () => {
  // regression: a subProcess triggeredByEvent="true" has no parent sequence flow by design
  const { out } = loneProcess(
    "evsub",
    `<?xml version="1.0"?>
     <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
       <bpmn:process id="P">
         <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
         <bpmn:task id="t"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:task>
         <bpmn:endEvent id="e"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
         <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t"/>
         <bpmn:sequenceFlow id="f2" sourceRef="t" targetRef="e"/>
         <bpmn:subProcess id="EventSub" triggeredByEvent="true">
           <bpmn:startEvent id="es"><bpmn:outgoing>g1</bpmn:outgoing></bpmn:startEvent>
           <bpmn:task id="et"><bpmn:incoming>g1</bpmn:incoming><bpmn:outgoing>g2</bpmn:outgoing></bpmn:task>
           <bpmn:endEvent id="ee"><bpmn:incoming>g2</bpmn:incoming></bpmn:endEvent>
           <bpmn:sequenceFlow id="g1" sourceRef="es" targetRef="et"/>
           <bpmn:sequenceFlow id="g2" sourceRef="et" targetRef="ee"/>
         </bpmn:subProcess>
       </bpmn:process>
     </bpmn:definitions>`,
  );
  assert.doesNotMatch(out, /EventSub is unreachable/);
  assert.doesNotMatch(out, /EventSub is a dead end/);
});

test("a boundary event omitted from flowNodeRef is NOT flagged 'not assigned to any lane'", () => {
  const { out } = loneProcess(
    "bnd",
    `<?xml version="1.0"?>
     <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
       <bpmn:process id="P">
         <bpmn:laneSet>
           <bpmn:lane id="L1" name="Clerk">
             <bpmn:flowNodeRef>s</bpmn:flowNodeRef>
             <bpmn:flowNodeRef>t</bpmn:flowNodeRef>
             <bpmn:flowNodeRef>e</bpmn:flowNodeRef>
             <bpmn:flowNodeRef>e2</bpmn:flowNodeRef>
           </bpmn:lane>
         </bpmn:laneSet>
         <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
         <bpmn:task id="t"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:task>
         <bpmn:boundaryEvent id="Bnd" attachedToRef="t"><bpmn:outgoing>f3</bpmn:outgoing></bpmn:boundaryEvent>
         <bpmn:endEvent id="e"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
         <bpmn:endEvent id="e2"><bpmn:incoming>f3</bpmn:incoming></bpmn:endEvent>
         <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t"/>
         <bpmn:sequenceFlow id="f2" sourceRef="t" targetRef="e"/>
         <bpmn:sequenceFlow id="f3" sourceRef="Bnd" targetRef="e2"/>
       </bpmn:process>
     </bpmn:definitions>`,
  );
  assert.doesNotMatch(out, /Bnd is not assigned to any lane/);
});

test("a callActivity to a process that does not exist is a link warning (not an error)", () => {
  const dir = mutableFixture();
  try {
    const bpmn = join(dir, "processes", "order-to-cash", "order-to-cash.bpmn");
    writeFileSync(
      bpmn,
      readFileSync(bpmn, "utf8").replace('calledElement="invoice-handling"', 'calledElement="ghost-proc"'),
    );
    const { status, out } = run(["--root", dir, "order-to-cash"]);
    assert.equal(status, 0, out); // a dangling call is a warning, still green
    assert.match(out, /calls 'ghost-proc', which is not a process in this repo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
