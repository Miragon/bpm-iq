import assert from "node:assert/strict";
import { test } from "node:test";

import { bootstrap, report, wilcoxon, wilson } from "../../bench/agent/report.ts";

test("wilson: the textbook interval for 8 of 10", () => {
  const [p, low, high] = wilson(8, 10);
  assert.equal(p, 0.8);
  assert.ok(Math.abs(low - 0.4902) < 0.001 && Math.abs(high - 0.9433) < 0.001, `${low} ${high}`);
});

test("wilcoxon: clearly shifted pairs are significant, symmetric noise is not", () => {
  assert.ok(wilcoxon([-0.6, -0.5, -0.7, -0.55, -0.62, -0.48, -0.66, -0.51, -0.58, -0.6]) < 0.01);
  assert.ok(wilcoxon([0.1, -0.1, 0.2, -0.2, 0.05, -0.05, 0.15, -0.15]) > 0.5);
});

test("bootstrap: the interval of a constant sample is the constant", () => {
  assert.deepEqual(bootstrap([3, 3, 3, 3]), [3, 3]);
});

const run = (arm: "A" | "B", task: string, rep: number, size: string, success: boolean, total: number) => ({
  task,
  kind: "edit" as const,
  size,
  arm,
  rep,
  success,
  validatorErrors: 0,
  collateral: arm === "A" ? 1 : 0,
  hardDefects: 0,
  usage: { input: total, output: 0, cacheWrite: 0, cacheRead: 0 },
  costUsd: total / 1e6,
  ms: 1000,
  turns: 3,
  failedSaves: 0,
});

test("report: the gate says GO only when every criterion holds", () => {
  const good = [1, 2, 3, 4, 5].flatMap((rep) =>
    ["S", "M", "L"].flatMap((size) => [
      run("A", `t-${size}`, rep, size, size !== "L" || rep > 3, 100_000),
      run("B", `t-${size}`, rep, size, true, 30_000),
    ]),
  );
  assert.equal(report(good).gate, true);
  const worse = good.map((r) => (r.arm === "B" && r.size === "L" ? { ...r, success: false } : r));
  assert.equal(report(worse).gate, false);
});
