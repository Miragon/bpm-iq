/**
 * The per-mediaKind baseline gate (checkModelBaseline) + its CLI wiring: a
 * model of ANY registered notation must at minimum parse — before this, a
 * broken .tt/.vc.json passed `pnpm validate` untouched because discovery
 * never reached non-BPMN/DMN files. DSL notations are deliberately lenient
 * (the extractors ignore unknown lines), which the cases pin.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkModelBaseline } from "../src/validate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATE = resolve(HERE, "..", "src", "cli.ts");

function run(args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [VALIDATE, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** a minimal content repo whose models folder holds exactly `files` */
function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "validator-baseline-"));
  writeFileSync(join(dir, "bpmiq.yml"), "models: models\n");
  mkdirSync(join(dir, "models"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, "models", name), content);
  }
  return dir;
}

test("checkModelBaseline: json parses or errors, dsl stays lenient", () => {
  assert.deepEqual(checkModelBaseline("{}", { notation: "team-topology" }), []);
  const broken = checkModelBaseline("{ nope", { file: "models/t.tt", notation: "team-topology" });
  assert.equal(broken.length, 1);
  assert.equal(broken[0]?.severity, "ERROR");
  assert.equal(broken[0]?.file, "models/t.tt");
  assert.match(broken[0]?.message ?? "", /not parseable as JSON/);
  // wardley's regex parser ignores garbage lines — no throw, no finding
  assert.deepEqual(checkModelBaseline("!!! not a map !!!", { notation: "wardley" }), []);
  // same for the .storm DSL — uninterpretable lines are passthrough there too
  assert.deepEqual(
    checkModelBaseline("!!! not a board !!!\nevent Order Placed [1, 2]", { notation: "event-storming" }),
    [],
  );
  // an unregistered notation id has no mediaKind — nothing to gate
  assert.deepEqual(checkModelBaseline("anything", { notation: "no-such" }), []);
  // the xml branch — unreachable from runCli today (bpmn/dmn have full
  // checkers), but the first future xml notation ships on this gate
  assert.deepEqual(checkModelBaseline("<a/>", { notation: "bpmn" }), []);
  const xml = checkModelBaseline("<a", { file: "m.bpmn", notation: "bpmn" });
  assert.match(xml[0]?.message ?? "", /not well-formed XML/);
});

test("a broken .tt fails the run; valid non-BPMN models are counted", () => {
  const dir = repoWith({ "teams.tt": "{ this is not json" });
  const { status, out } = run(["--root", dir]);
  assert.equal(status, 1);
  assert.match(out, /\[ERROR\] models\/teams\.tt: not parseable as JSON/);

  const ok = repoWith({ "teams.tt": "{}", "tea.owm": "component Tea [0.5, 0.5]" });
  const green = run(["--root", ok]);
  assert.equal(green.status, 0, green.out);
  assert.match(green.out, /2 other model\(s\) checked/);
});

test("the single-model filter reaches non-BPMN models", () => {
  const dir = repoWith({ "supply.vc.json": "{ broken" });
  const { status, out } = run(["--root", dir, "supply"]);
  assert.equal(status, 1);
  assert.match(out, /not parseable as JSON/);
});
