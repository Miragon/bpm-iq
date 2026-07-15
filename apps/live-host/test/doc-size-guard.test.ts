/**
 * In-session document size guard (audit M3 residual): updates that would push a
 * doc past the cap are rejected at ingest, cheap-estimate first, exact re-measure
 * only near the cap.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";

test("admits updates while under the cap without ever measuring", () => {
  const g = new DocSizeGuard(1000);
  g.load("doc", 100);
  let measured = 0;
  const measure = () => {
    measured++;
    return 0;
  };
  assert.ok(g.admit("doc", 200, measure));
  assert.ok(g.admit("doc", 300, measure));
  assert.equal(measured, 0, "no exact measurement below the cap");
});

test("rejects an update once the exact size confirms the doc is at the cap", () => {
  const g = new DocSizeGuard(1000);
  g.load("doc", 900);
  // estimate crosses the cap → re-measure says the doc really is 990B → reject
  assert.equal(
    g.admit("doc", 200, () => 990),
    false,
  );
  // and stays rejected for further growth attempts
  assert.equal(
    g.admit("doc", 50, () => 990),
    false,
  );
});

test("an over-estimate self-corrects: measure says smaller → update admitted", () => {
  const g = new DocSizeGuard(1000);
  g.load("doc", 500);
  // pending inflates the estimate (sync chatter counts in), crossing the cap …
  assert.ok(g.admit("doc", 400, () => 0));
  // … but the exact size is only 300B, so the next update fits fine
  assert.ok(g.admit("doc", 200, () => 300));
});

test("stored() re-anchors the estimate so pending never accumulates forever", () => {
  const g = new DocSizeGuard(1000);
  g.load("doc", 100);
  assert.ok(g.admit("doc", 400, () => 0));
  g.stored("doc", 200); // the store path encoded the doc: 200B exact
  let measured = false;
  assert.ok(
    g.admit("doc", 300, () => {
      measured = true;
      return 0;
    }),
  );
  assert.equal(measured, false, "200 + 300 is under the cap — no measurement needed");
});

test("an untracked doc (no load) is guarded from base 0 — measure re-anchors it", () => {
  const g = new DocSizeGuard(1000);
  // first update on an unknown doc: estimate 0+600 fits
  assert.ok(g.admit("mystery", 600, () => 0));
  // second crosses: 600+600 > 1000 → measure says the doc is really 900 → reject
  assert.equal(
    g.admit("mystery", 600, () => 900),
    false,
  );
});

test("drop() forgets a doc; the tracking map does not grow unbounded", () => {
  const g = new DocSizeGuard(1000);
  g.load("a", 1);
  g.load("b", 1);
  assert.equal(g.tracked, 2);
  g.drop("a");
  g.drop("b");
  assert.equal(g.tracked, 0);
});

test("measure cooldown: repeated cap-crossings cost at most one measure per window", () => {
  const g = new DocSizeGuard(1000, 5000);
  g.load("doc", 950);
  let measured = 0;
  const measure = () => {
    measured++;
    return 950; // genuinely at the cap
  };
  // an attacker hammering headroom-sized messages: first crossing measures …
  assert.equal(g.admit("doc", 100, measure, 10_000), false);
  assert.equal(measured, 1);
  // … every further crossing INSIDE the cooldown rejects on the estimate alone
  for (let t = 10_100; t < 14_000; t += 100) assert.equal(g.admit("doc", 100, measure, t), false);
  assert.equal(measured, 1, "no CPU amplification: the cooldown suppressed re-measures");
  // after the cooldown the exact measure runs again (self-heals a shrunken doc)
  measured = 0;
  assert.equal(
    g.admit(
      "doc",
      100,
      () => {
        measured++;
        return 200; // the doc was pruned/compacted meanwhile
      },
      15_001,
    ),
    true,
    "a doc that shrank below the cap admits again after the cooldown",
  );
  assert.equal(measured, 1);
});

test("cooldown does not penalize docs under the cap (no crossing → no measure)", () => {
  const g = new DocSizeGuard(1000, 5000);
  g.load("doc", 100);
  let measured = 0;
  for (let t = 0; t < 2000; t += 100) assert.ok(g.admit("doc", 10, () => measured++, t));
  assert.equal(measured, 0);
});
