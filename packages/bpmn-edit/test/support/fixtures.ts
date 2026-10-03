import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DiagramEdge, DiagramPlane, DiagramShape } from "../../src/diagram/plane.ts";
import type { Point, Rect } from "../../src/geometry/geometry.ts";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * A large local model for the layout work (not committed: customer material). Tests on it run only where
 * BPMN_EDIT_LARGE_MODEL names an existing file.
 */
export const LARGE_MODEL = process.env["BPMN_EDIT_LARGE_MODEL"] ?? "";

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function shape(id: string, bounds: Rect, extra: Partial<DiagramShape> = {}): DiagramShape {
  return { id, type: "Task", bounds, container: false, ...extra };
}

export function flow(id: string, source: string, target: string, waypoints: Point[]): DiagramEdge {
  return { id, type: "SequenceFlow", source, target, waypoints };
}

export function plane(shapes: DiagramShape[], edges: DiagramEdge[] = []): DiagramPlane {
  return { id: "Process_Test", shapes, edges };
}
