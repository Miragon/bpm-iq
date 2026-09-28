/**
 * Sticky text auto-fit (#188) — like a miro sticky, the text shrinks with the
 * note and grows back up to the default label size. The font size is DERIVED
 * from size + text on every render, never persisted: a resize diff touches
 * width/height only, and every peer computes the same result.
 *
 * Pure layout, no DOM: the caller injects the text measurement (a canvas in
 * the renderer, a fake in tests). Words wrap whole; a word is cut only when it
 * is wider than the note even at the minimum size, and then with a hyphen.
 * Text that does not fit at the minimum size is clipped with an ellipsis
 * instead of running out of the note.
 */

/** the width in px of `text` set at `fontSize` px */
export type MeasureText = (text: string, fontSize: number) => number;

export interface StickyTextOptions {
  /** the size the text grows back to — the diagram's default label size */
  maxFontSize: number;
  /** legibility floor: below it the text is clipped instead of shrunk */
  minFontSize: number;
  /** line height as a multiple of the font size */
  lineHeight: number;
  /** inner padding on every side of the note */
  padding: number;
}

export const STICKY_TEXT_DEFAULTS: StickyTextOptions = { maxFontSize: 12, minFontSize: 6, lineHeight: 1.2, padding: 8 };

export interface StickyTextLayout {
  fontSize: number;
  /** px from one baseline to the next */
  lineHeight: number;
  lines: string[];
  /** not even the minimum size holds the text — the last line ends in "…" */
  truncated: boolean;
}

/** half-pixel steps: fine enough to follow a resize, few enough to stay cheap */
const STEP = 0.5;
const SOFT_HYPHEN = "­";
const ELLIPSIS = "…";

/** a line as drawn: soft hyphens vanish, except at the end, where the line broke on one */
function shown(line: string): string {
  return line.replace(/­$/, "-").replaceAll(SOFT_HYPHEN, "");
}

/** the pieces a word may break into without cutting it: after a hyphen, at a soft hyphen */
function piecesOf(word: string): string[] {
  return word.split(/(?<=[-­])/).filter((piece) => piece !== "");
}

interface Wrapped {
  lines: string[];
  /** pieces too wide for a line of their own — cut mid-word */
  cut: string[];
}

function wrap(text: string, width: number, fontSize: number, measure: MeasureText): Wrapped {
  const fits = (line: string): boolean => measure(shown(line), fontSize) <= width;
  const lines: string[] = [];
  const cut: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter((w) => w !== "")) {
      piecesOf(word).forEach((piece, index) => {
        const joined = line === "" ? piece : `${line}${index === 0 ? " " : ""}${piece}`;
        if (fits(joined)) {
          line = joined;
          return;
        }
        if (line !== "") lines.push(line);
        line = piece;
        if (fits(piece)) return;
        // wider than the note: cut it, each cut marked with a hyphen
        cut.push(piece);
        let rest = Array.from(piece);
        while (rest.length > 1 && !fits(rest.join(""))) {
          let take = 1;
          while (take < rest.length - 1 && fits(`${rest.slice(0, take + 1).join("")}-`)) take++;
          lines.push(`${rest.slice(0, take).join("")}-`);
          rest = rest.slice(take);
        }
        line = rest.join("");
      });
    }
    lines.push(line);
  }
  return { lines, cut };
}

/** shorten the last line that still fits until "…" fits behind it */
function ellipsize(line: string, width: number, fontSize: number, measure: MeasureText): string {
  const chars = Array.from(shown(line).replace(/-$/, ""));
  const withEllipsis = (): string => `${chars.join("").trimEnd()}${ELLIPSIS}`;
  while (chars.length > 0 && measure(withEllipsis(), fontSize) > width) chars.pop();
  return withEllipsis();
}

/** the candidate font sizes, largest first — always ending on the minimum */
function* fontSizes({ maxFontSize, minFontSize }: StickyTextOptions): Generator<number> {
  for (let size = maxFontSize; size > minFontSize; size -= STEP) yield size;
  yield minFontSize;
}

/** the largest font size at which `text` fits the note, and its lines */
export function fitStickyText(
  text: string,
  box: { width: number; height: number },
  measure: MeasureText,
  options: StickyTextOptions = STICKY_TEXT_DEFAULTS,
): StickyTextLayout {
  const { minFontSize, maxFontSize, lineHeight, padding } = options;
  const width = box.width - 2 * padding;
  const height = box.height - 2 * padding;
  const content = text.trim();
  const layout = (fontSize: number, lines: string[], truncated: boolean): StickyTextLayout => ({
    fontSize,
    lineHeight: fontSize * lineHeight,
    lines: lines.map(shown),
    truncated,
  });
  if (content === "") return layout(maxFontSize, [], false);
  if (width <= 0 || height <= 0) return layout(minFontSize, [], true);

  for (const fontSize of fontSizes(options)) {
    const { lines, cut } = wrap(content, width, fontSize, measure);
    if (lines.length * fontSize * lineHeight > height) continue;
    // a cut is only fair for a word too long for the note even at the floor —
    // any shorter word rather shrinks the text until it fits whole
    if (cut.some((piece) => measure(shown(piece), minFontSize) <= width)) continue;
    return layout(fontSize, lines, false);
  }

  // not even the floor holds it: keep what fits, the last line marked "…"
  const { lines } = wrap(content, width, minFontSize, measure);
  const room = Math.max(1, Math.floor(height / (minFontSize * lineHeight)));
  const kept = lines.slice(0, room);
  kept[kept.length - 1] = ellipsize(kept[kept.length - 1] ?? "", width, minFontSize, measure);
  return layout(minFontSize, kept, true);
}
