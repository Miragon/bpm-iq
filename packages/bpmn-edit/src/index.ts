// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- the ambient bpmn-moddle types must reach consumers' typecheck (bpmn-moddle ships none; an ambient `declare module` file cannot be imported)
/// <reference path="./types/bpmn-moddle.d.ts" />
/**
 * @bpmiq/bpmn-edit — BPMN editing through bpmn-moddle (ADR 0008). Browser-safe: everything exported here runs in
 * Node and in the browser; src/main.ts (the CLI) is the only Node entry and is not exported.
 *
 * - outline:          the semantics without DI (lanes, links, the platform's implementation details), optionally
 *                     only the neighbourhood of one element
 * - applyOperations:  a batch of semantic operations, all or nothing, with the geometry of everything it touches
 * - layout:           tidy | relayout | layout, a variant taken only when it scores better
 * - measure:          layout metrics per diagram plane
 */
export type { LayoutMode, LayoutOutcome, LayoutRequest, LayoutScope } from "./layout/layout.ts";
export { computeLayout, layout } from "./layout/layout.ts";
export type { LayoutResult } from "./layout/result.ts";
export type { PlaneMetrics } from "./metrics/metrics.ts";
export { measure } from "./metrics/metrics.ts";
export type { EditOutcome } from "./operations/apply.ts";
export { applyOperations } from "./operations/apply.ts";
export { parseOperations, toOperations } from "./operations/parse.ts";
export type { NewElement, Operation, OperationName } from "./operations/types.ts";
export { NEW_ELEMENT_TYPES } from "./operations/types.ts";
export { outline } from "./outline/outline.ts";
export type {
  ElementOutline,
  FlowOutline,
  LaneOutline,
  Outline,
  OutlineOptions,
  ProcessOutline,
} from "./outline/types.ts";
export { formatYaml } from "./outline/yaml.ts";
export type { PlatformId } from "./platform/detect.ts";
export { detectPlatform } from "./platform/detect.ts";
export { BpmnEditError } from "./utils/errors.ts";
