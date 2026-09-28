/**
 * Sticky text auto-fit (#188, src/notations/bpmn-sticky/sticky-text.ts): the
 * text shrinks with the note, grows back to the default size, never leaves
 * the note, and cuts only words too long for it — with a hyphen. Measured
 * with a fake monospace font (every character 0.5em wide), so the expected
 * sizes can be worked out by hand.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fitStickyText,
  type MeasureText,
  STICKY_TEXT_DEFAULTS,
  type StickyTextLayout,
} from "../src/notations/bpmn-sticky/sticky-text.ts";

const measure: MeasureText = (text, fontSize) => Array.from(text).length * fontSize * 0.5;
const fit = (text: string, width: number, height = width): StickyTextLayout =>
  fitStickyText(text, { width, height }, measure);

const { padding, maxFontSize, minFontSize } = STICKY_TEXT_DEFAULTS;
const ISSUE_TEXT = "Feature-146: Bonitätsprüfung und Entscheidung abbilden";

/** every line within the note's padding box */
function assertInside(layout: StickyTextLayout, width: number, height = width): void {
  const inner = { width: width - 2 * padding, height: height - 2 * padding };
  assert.ok(layout.lines.length * layout.lineHeight <= inner.height, `${layout.lines.length} lines overflow`);
  for (const line of layout.lines) {
    assert.ok(measure(line, layout.fontSize) <= inner.width, `"${line}" overflows at ${layout.fontSize}px`);
  }
}

const wordsOf = (text: string): string[] => text.split(/\s+/).filter(Boolean);

test("a roomy note shows the text at the default size", () => {
  const layout = fit(ISSUE_TEXT, 120);
  assert.equal(layout.fontSize, maxFontSize);
  assert.equal(layout.truncated, false);
  assert.deepEqual(layout.lines, ["Feature-146:", "Bonitätsprüfung", "und Entscheidung", "abbilden"]);
  assertInside(layout, 120);
});

test("shrinking the note shrinks the text, enlarging it grows it back", () => {
  const small = fit(ISSUE_TEXT, 80);
  assert.ok(small.fontSize < maxFontSize && small.fontSize >= minFontSize, `${small.fontSize}px`);
  assert.equal(small.truncated, false);
  assertInside(small, 80);
  // the words stay whole — the text shrinks instead of cutting them
  assert.deepEqual(wordsOf(small.lines.join(" ")), wordsOf(ISSUE_TEXT));

  const tinier = fit(ISSUE_TEXT, 70);
  assert.ok(tinier.fontSize <= small.fontSize);
  assertInside(tinier, 70);

  assert.equal(fit(ISSUE_TEXT, 120).fontSize, maxFontSize);
  // never beyond the default, however large the note
  assert.equal(fit("Warum?", 400).fontSize, maxFontSize);
});

test("the font size is a pure function of text and size", () => {
  assert.deepEqual(fit(ISSUE_TEXT, 90, 70), fit(ISSUE_TEXT, 90, 70));
});

test("short words are never cut mid-word, at any note size", () => {
  const text = "Kreditantrag prüfen und Bonität bewerten";
  for (let size = 60; size <= 200; size += 5) {
    const layout = fit(text, size);
    assert.deepEqual(wordsOf(layout.lines.join(" ")), wordsOf(text), `${size}px note`);
    assert.ok(!layout.lines.some((line) => line.endsWith("-")), `${size}px note cut a word`);
    assertInside(layout, size);
  }
});

test("at the minimum size the text is clipped with an ellipsis, never outside the note", () => {
  const text = Array.from({ length: 12 }, () => ISSUE_TEXT).join(" ");
  const layout = fit(text, 60);
  assert.equal(layout.fontSize, minFontSize);
  assert.equal(layout.truncated, true);
  assert.ok(layout.lines.at(-1)?.endsWith("…"));
  assertInside(layout, 60);
});

test("a compound word wider than the note even at the minimum size is cut with hyphens", () => {
  const word = "Donaudampfschifffahrtsgesellschaftskapitän";
  const layout = fit(word, 60);
  assert.equal(layout.truncated, false);
  // 7px: 11 characters + hyphen per line, four lines — 7.5px would need five
  assert.equal(layout.fontSize, 7);
  assert.deepEqual(layout.lines, ["Donaudampfs-", "chifffahrts-", "gesellschaf-", "tskapitän"]);
  assert.equal(layout.lines.map((line) => line.replace(/-$/, "")).join(""), word);
  assertInside(layout, 60);
});

test("a word breaks at its soft hyphens before it gets cut", () => {
  const layout = fit("Kredit­würdigkeits­prüfung", 60);
  assert.equal(layout.fontSize, 7);
  assert.deepEqual(layout.lines, ["Kredit-", "würdigkeits-", "prüfung"]);
  // unbroken, a soft hyphen stays invisible
  assert.deepEqual(fit("Kredit­würdigkeit", 200, 60).lines, ["Kreditwürdigkeit"]);
});

test("a hyphenated word may break after its hyphen", () => {
  assert.deepEqual(fit("Feature-146:", 60).lines, ["Feature-", "146:"]);
});

test("line breaks and empty lines survive, an empty note has no lines", () => {
  assert.deepEqual(fit("Frage:\n\nWer entscheidet?", 120).lines, ["Frage:", "", "Wer entscheidet?"]);
  assert.deepEqual(fit("  \n ", 120).lines, []);
});
