/**
 * Coordinates of one level from its grid: every column as wide as its widest node, every row as high as its highest
 * node, the gaps of layout-geometry.md between them (200 px between task centres, 150 px between rows). Rows belong to
 * bands (the lanes of a pool, else one band for the level); each band stacks its own rows, in the order of the row
 * tree, and keeps a padding to its borders. Every node is centred in its cell.
 */
import type { DiagramShape } from "../../diagram/plane.ts";
import type { Point } from "../../geometry/geometry.ts";
import { COLUMN_GAP, ROW_SPACING, type Size, SIZES } from "../constants.ts";
import type { Grid } from "./level.ts";

/** Free space between two rows: the row spacing minus the height of a task. */
const ROW_GAP = ROW_SPACING - SIZES.activity.height;
/** Height of a band without any node (an empty lane). */
const EMPTY_BAND = SIZES.activity.height + 2 * ROW_GAP;

export interface Bands {
  /** band of every node */
  readonly of: (shape: DiagramShape) => string;
  /** the bands from top to bottom */
  readonly order: readonly string[];
  /** space between the border of a band and its first and last row */
  readonly padding: number;
}

export interface LevelLayout {
  /** top left corner of every node, relative to the level */
  readonly positions: ReadonlyMap<string, Point>;
  readonly width: number;
  readonly height: number;
  /** top and height of every band, relative to the level */
  readonly bands: ReadonlyMap<string, readonly [number, number]>;
}

/** Nodes without any flow (an event sub-process) side by side in one row at `y`; returns the size of the row. */
function placeLoose(
  loose: readonly DiagramShape[],
  sizeOf: (shape: DiagramShape) => Size,
  at: { readonly positions: Map<string, Point>; readonly y: number },
): Size {
  let x = 0;
  for (const shape of loose) {
    at.positions.set(shape.id, { x, y: at.y });
    x += sizeOf(shape).width + COLUMN_GAP;
  }
  return { width: Math.max(0, x - COLUMN_GAP), height: Math.max(0, ...loose.map((shape) => sizeOf(shape).height)) };
}

/**
 * Start and extent of every index when each takes its largest member plus the gap before the next one: `gap`, or
 * the larger `room` that index needs before it.
 */
function tracks(
  extents: ReadonlyMap<number, number>,
  gap: number,
  room: ReadonlyMap<number, number> = new Map(),
): Map<number, readonly [number, number]> {
  const result = new Map<number, readonly [number, number]>();
  let start: number | undefined;
  for (const index of [...extents.keys()].sort((first, second) => first - second)) {
    const extent = extents.get(index) ?? 0;
    start = start === undefined ? 0 : start + Math.max(gap, room.get(index) ?? 0);
    result.set(index, [start, extent]);
    start += extent;
  }
  return result;
}

function largest(entries: readonly (readonly [number, number])[]): Map<number, number> {
  const result = new Map<number, number>();
  entries.forEach(([index, extent]) => result.set(index, Math.max(result.get(index) ?? 0, extent)));
  return result;
}

/**
 * Rows of one band, packed like a skyline: in the order of the row tree every row takes the first level below all
 * rows before it whose columns it shares (its flows in and out included); rows in columns apart share a level.
 */
function bandRows(nodes: readonly DiagramShape[], grid: Grid): Map<string, number> {
  const span = new Map<number, readonly [number, number]>();
  for (const shape of nodes) {
    const [row, column] = [grid.row.get(shape.id) ?? 0, grid.column.get(shape.id) ?? 0];
    const [from, to] = span.get(row) ?? [column, column];
    span.set(row, [Math.min(from, column - 1), Math.max(to, column + 1)]);
  }
  const level = new Map<number, number>();
  const placed: [number, number, number][] = [];
  for (const row of [...span.keys()].sort((first, second) => first - second)) {
    const [from, to] = span.get(row) ?? [0, 0];
    const below = placed.filter(([start, end]) => start <= to && from <= end).map(([, , taken]) => taken + 1);
    const chosen = Math.max(0, ...below);
    level.set(row, chosen);
    placed.push([from, to, chosen]);
  }
  return new Map(nodes.map((shape) => [shape.id, level.get(grid.row.get(shape.id) ?? 0) ?? 0]));
}

interface BandContext {
  readonly grid: Grid;
  readonly sizeOf: (shape: DiagramShape) => Size;
  readonly columns: ReadonlyMap<number, readonly [number, number]>;
  readonly padding: number;
  readonly positions: Map<string, Point>;
}

/** Places the nodes of one band from its top; returns the height of the band and the width of its loose row. */
function placeBand(all: readonly DiagramShape[], top: number, context: BandContext): Size {
  const { grid, sizeOf, columns, padding, positions } = context;
  const inBand = all.filter((shape) => grid.column.has(shape.id));
  const localRow = bandRows(inBand, grid);
  const rows = tracks(largest(inBand.map((shape) => [localRow.get(shape.id) ?? 0, sizeOf(shape).height])), ROW_GAP);
  for (const shape of inBand) {
    const size = sizeOf(shape);
    const [left, width] = columns.get(grid.column.get(shape.id) ?? 0) ?? [0, size.width];
    const [rowTop, height] = rows.get(localRow.get(shape.id) ?? 0) ?? [0, size.height];
    positions.set(shape.id, {
      x: left + (width - size.width) / 2,
      y: top + padding + rowTop + (height - size.height) / 2,
    });
  }
  const gridHeight = Math.max(0, ...[...rows.values()].map(([start, extent]) => start + extent));
  const loose = all.filter((shape) => !grid.column.has(shape.id));
  const gap = gridHeight > 0 && loose.length > 0 ? ROW_GAP : 0;
  const looseRow = placeLoose(loose, sizeOf, { positions, y: top + padding + gridHeight + gap });
  const height = all.length > 0 ? gridHeight + gap + looseRow.height + 2 * padding : EMPTY_BAND;
  return { width: looseRow.width, height };
}

export function placeLevel(
  members: readonly DiagramShape[],
  grid: Grid,
  sizeOf: (shape: DiagramShape) => Size,
  bands: Bands,
): LevelLayout {
  const nodes = members.filter((shape) => !shape.attachedTo);
  const widths = largest(
    nodes.flatMap((shape) => {
      const column = grid.column.get(shape.id);
      return column === undefined ? [] : [[column, sizeOf(shape).width] as const];
    }),
  );
  const columns = tracks(widths, COLUMN_GAP, grid.room);
  const context: BandContext = { grid, sizeOf, columns, padding: bands.padding, positions: new Map() };
  const spans = new Map<string, readonly [number, number]>();
  let top = 0;
  let looseWidth = 0;
  for (const band of bands.order) {
    const placed = placeBand(
      nodes.filter((shape) => bands.of(shape) === band),
      top,
      context,
    );
    spans.set(band, [top, placed.height]);
    looseWidth = Math.max(looseWidth, placed.width);
    top += placed.height;
  }
  const width = Math.max(looseWidth, ...[...columns.values()].map(([start, extent]) => start + extent));
  return { positions: context.positions, width, height: top, bands: spans };
}
