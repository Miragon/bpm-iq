/**
 * Layout of a BPMN document: `computeLayout` returns geometry only (the shape of the bpmn-modeler layout port),
 * `layout` writes it into the DI and returns the new XML with the metrics of the touched planes before and after.
 *
 * - tidy:     removes overlaps and too small gaps with minimal displacement, keeps the order (VPSC)
 * - relayout: lays out the smallest SESE fragment around the given flow nodes anew (or the whole plane), the rest
 *             of the plane only makes room
 * - layout:   lays out every level of the plane anew, left to right (global/global.ts); the current drawing only
 *             orders equal branches
 *
 * Which variant is taken, if any, is decided in choice.ts (hard limits, score against a fair reference); otherwise the
 * plane stays as it is and a diagnostic says so.
 */
import type { DiagramPlane } from "../diagram/plane.ts";
import { planesOf } from "../diagram/reader.ts";
import { measurePlane, type PlaneMetrics } from "../metrics/metrics.ts";
import { parseDocument, serializeDocument } from "../model/document.ts";
import { BpmnEditError } from "../utils/errors.ts";
import { applyLayout } from "./apply.ts";
import { choose } from "./choice.ts";
import { layoutGlobally } from "./global/global.ts";
import { relayoutVariants, type Variant } from "./relayout/relayout.ts";
import { diffPlane, type LayoutDiagnostic, type LayoutResult } from "./result.ts";
import { tidy } from "./tidy.ts";

export type LayoutScope =
  | { readonly kind: "all" }
  | { readonly kind: "plane"; readonly id: string }
  | { readonly kind: "fragmentOf"; readonly ids: readonly string[] };

export type LayoutMode = "tidy" | "relayout" | "layout";

export interface LayoutRequest {
  readonly scope: LayoutScope;
  readonly mode: LayoutMode;
}

export interface PlaneChange {
  readonly before: DiagramPlane;
  readonly after: DiagramPlane;
  readonly moved: ReadonlySet<string>;
  readonly diagnostics: readonly LayoutDiagnostic[];
}

export interface LayoutOutcome {
  readonly xml: string;
  readonly result: LayoutResult;
  readonly movedIds: readonly string[];
  readonly before: readonly PlaneMetrics[];
  readonly after: readonly PlaneMetrics[];
}

function containsAll(plane: DiagramPlane, ids: readonly string[]): boolean {
  return ids.every((id) => plane.shapes.some((shape) => shape.id === id));
}

function targetPlanes(planes: readonly DiagramPlane[], scope: LayoutScope): DiagramPlane[] {
  const selected =
    scope.kind === "all"
      ? [...planes]
      : planes.filter((plane) => (scope.kind === "plane" ? plane.id === scope.id : containsAll(plane, scope.ids)));
  if (selected.length === 0) {
    const wanted =
      scope.kind === "all"
        ? "diagram plane"
        : scope.kind === "plane"
          ? `plane '${scope.id}'`
          : "one plane with all given elements";
    throw new BpmnEditError(`no ${wanted} in the document`);
  }
  return selected;
}

function flowNodeIds(plane: DiagramPlane): string[] {
  const connected = new Set(plane.edges.flatMap((edge) => [edge.source, edge.target]));
  return plane.shapes.filter((shape) => connected.has(shape.id)).map((shape) => shape.id);
}

function candidates(plane: DiagramPlane, request: LayoutRequest): Variant[] {
  if (request.mode === "tidy") {
    return [tidy(plane)];
  }
  if (request.mode === "layout") {
    return [{ plane: layoutGlobally(plane), moved: new Set(plane.shapes.map((shape) => shape.id)) }];
  }
  return relayoutVariants(plane, request.scope.kind === "fragmentOf" ? request.scope.ids : flowNodeIds(plane));
}

function layoutPlane(plane: DiagramPlane, request: LayoutRequest): PlaneChange {
  return { before: plane, ...choose(plane, candidates(plane, request), request.mode) };
}

function layoutPlanes(planes: readonly DiagramPlane[], request: LayoutRequest): PlaneChange[] {
  return targetPlanes(planes, request.scope).map((plane) => layoutPlane(plane, request));
}

function toResult(changes: readonly PlaneChange[]): LayoutResult {
  const diffs = changes.map((change) => diffPlane(change.before, change.after));
  return {
    shapes: diffs.flatMap((diff) => diff.shapes),
    edges: diffs.flatMap((diff) => diff.edges),
    labels: diffs.flatMap((diff) => diff.labels),
    diagnostics: changes.flatMap((change) => change.diagnostics),
  };
}

/** The new geometry of everything the layout changes; nothing else. */
export async function computeLayout(xml: string, request: LayoutRequest, source: string): Promise<LayoutResult> {
  const { definitions } = await parseDocument(xml, source);
  return toResult(layoutPlanes(planesOf(definitions), request));
}

/** The document with the layout applied, and the metrics of the touched planes before and after. */
export async function layout(xml: string, request: LayoutRequest, source: string): Promise<LayoutOutcome> {
  const document = await parseDocument(xml, source);
  const changes = layoutPlanes(planesOf(document.definitions), request);
  const result = toResult(changes);
  applyLayout(document, result);
  return {
    xml: await serializeDocument(document),
    result,
    movedIds: changes.flatMap((change) => [...change.moved]),
    before: changes.map((change) => measurePlane(change.before)),
    after: changes.map((change) => measurePlane(change.after)),
  };
}
