/**
 * The size of an external label from its text, as the modeler (bpmn-js) will draw it. bpmn-js wraps a label at the
 * width its DI gives it (at least DEFAULT_WIDTH) and then once more at the width of its longest line, which can break
 * a label of two lines into three or four. Both passes are simulated here with the advance widths of the font; a width
 * is taken only when the label keeps its lines, broken between words, with the measured widths a little off.
 */
import { LABEL_LINE_HEIGHT, type Size } from "./constants.ts";

/** A break bpmn-js may take inside a word, drawn as a hyphen. */
const SOFT_HYPHEN = "\u00AD";
/** Width bpmn-js wraps a label at when its DI is narrower. */
const DEFAULT_WIDTH = 90;
/** Widest label. */
const MAX_WIDTH = 240;
/** Most lines the label of a shape takes when it can; a flow label takes one. */
const SHAPE_LINES = 2;
const WIDTH_STEP = 5;
/** Size of the label font (bpmn-js: 11 px Arial). */
const FONT_SIZE = 11;
/** The advance widths below are in thousandths of the font size. */
const UNITS_PER_EM = 1000;
/** Advance widths of Arial, keyed by the characters that have them. */
const ARIAL: Readonly<Record<string, number>> = {
  "'": 191,
  ijl: 222,
  " ftI.,:;/!\\[]": 278,
  "r-()": 333,
  '"': 355,
  cksvxyzJ: 500,
  "abdeghnopquäöü0123456789?_L#$": 556,
  "+=<>": 584,
  FTZß: 611,
  "ABEKPSVXYÄ&": 667,
  CDHNRUwÜ: 722,
  GOQÖ: 778,
  mM: 833,
  W: 944,
};
/** Width of a character missing from the table: the common width of Arial. */
const REGULAR = 556;
const ADVANCE = new Map<string, number>(
  Object.entries(ARIAL).flatMap(([characters, width]) =>
    characters.split("").map((character): [string, number] => [character, width]),
  ),
);
/**
 * Scales of the measured widths, up to SCALE_SPREAD off in steps of SCALE_STEP: bpmn-js measures the drawn text,
 * which may differ a little from the advance widths and land on another side of the pixel it rounds the longest line
 * up to. Measured widths are fractions, so an estimate that comes out whole is nudged by FRACTION past that pixel.
 */
const SCALE_SPREAD = 0.03;
const SCALE_STEP = 0.005;
const SCALES = Array.from(
  { length: Math.round((2 * SCALE_SPREAD) / SCALE_STEP) + 1 },
  (_, index) => 1 - SCALE_SPREAD + index * SCALE_STEP,
);
const FRACTION = 0.01;

/** The drawn width of a line; SVG drops the space a line ends with. */
function measure(text: string, scale: number): number {
  const units = text
    .trimEnd()
    .split("")
    .reduce((sum, character) => sum + (ADVANCE.get(character) ?? REGULAR), 0);
  return (units * FONT_SIZE * scale) / UNITS_PER_EM + FRACTION;
}

/** bpmn-js shortens a line by characters in proportion to the room, breaking at spaces and hyphens where it can. */
function shorten(line: string, width: number, maxWidth: number): string {
  const length = Math.max((line.length * maxWidth) / width, 1);
  const taken: string[] = [];
  // like diagram-js, the first empty piece (two separators in a row) ends the line
  for (const part of line.split(/(\s|-|\u00AD)/g)) {
    if (part.length === 0 || part.length + taken.join("").length >= length) {
      // a hyphen that does not fit anymore takes the part before it along
      return shown((part === "-" || part === SOFT_HYPHEN ? taken.slice(0, -1) : taken).join(""));
    }
    taken.push(part);
  }
  return shown(taken.join(""));
}

/** A line bpmn-js breaks at a soft hyphen shows a hyphen there. */
function shown(line: string): string {
  return line.endsWith(SOFT_HYPHEN) ? `${line.slice(0, -1)}-` : line;
}

/** The first line bpmn-js cuts off `line` at `maxWidth`, as diagram-js `layoutNext` does. */
function nextLine(line: string, maxWidth: number, scale: number): string {
  let fitting = line;
  for (;;) {
    const width = measure(fitting, scale);
    if (fitting.trim() === "" || width < Math.round(maxWidth) || fitting.length < 2) {
      return fitting;
    }
    const shorter = shorten(fitting, width, maxWidth);
    fitting =
      shorter.length > 0 ? shorter : fitting.slice(0, Math.max(Math.round((fitting.length * maxWidth) / width) - 1, 1));
  }
}

/** The lines bpmn-js lays `text` out in at `maxWidth`. */
function layout(text: string, maxWidth: number, scale: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let rest = paragraph;
    do {
      const line = nextLine(rest, maxWidth, scale);
      lines.push(line);
      rest = rest.slice(line.length).trim();
    } while (rest.length > 0);
  }
  return lines;
}

function widest(lines: readonly string[], scale: number): number {
  return Math.ceil(Math.max(0, ...lines.map((line) => measure(line, scale))));
}

/** The lines bpmn-js draws for a label of DI width `width`: laid out on import, then again at its longest line. */
function drawn(text: string, width: number, scale: number): string[] {
  const imported = layout(text, Math.max(width, DEFAULT_WIDTH), scale);
  return layout(text, widest(imported, scale), scale);
}

/** Whether every line ends where a word ends: at a space or behind a hyphen (a soft one too), never inside a word. */
function betweenWords(original: string, lines: readonly string[]): boolean {
  const text = original.replaceAll(SOFT_HYPHEN, "-");
  let position = 0;
  return lines.every((line, index) => {
    position = text.indexOf(line.trim(), position) + line.trim().length;
    const next = text[position];
    return index === lines.length - 1 || next === undefined || /\s/.test(next) || line.trim().endsWith("-");
  });
}

/** The number of lines of the label at `width` when every estimate agrees and breaks between words, else none. */
function stableLines(text: string, width: number): number | undefined {
  const layouts = SCALES.map((scale) => drawn(text, width, scale));
  const counts = new Set(layouts.map((lines) => lines.length));
  return counts.size === 1 && layouts.every((lines) => betweenWords(text, lines)) ? layouts[0]?.length : undefined;
}

function sizeAt(text: string, width: number, lines: number): Size {
  const narrow = widest(drawn(text, width, 1), 1);
  // a DI as narrow as the drawn text keeps its lines when bpmn-js lays it out again; else the DI keeps its width
  return { width: stableLines(text, narrow) === lines ? narrow : width, height: lines * LABEL_LINE_HEIGHT };
}

/**
 * The size of a label: the narrowest width on which it takes at most `lines` lines (two for a shape, so its label
 * stays compact at the shape; one for a flow), at most MAX_WIDTH; a longer text takes MAX_WIDTH and more lines.
 */
export function labelSize(text: string, lines = SHAPE_LINES): Size {
  for (let width = DEFAULT_WIDTH; width <= MAX_WIDTH; width += WIDTH_STEP) {
    const count = stableLines(text, width);
    if (count !== undefined && count <= lines) {
      return sizeAt(text, width, count);
    }
  }
  return sizeAt(text, MAX_WIDTH, drawn(text, MAX_WIDTH, 1).length);
}
