/**
 * Applies a batch of operations to a BPMN document: all semantic changes first, in order, then one geometry step
 * for everything they touched. A failing operation stops the batch; nothing is written then.
 */
import { planesOf } from "../diagram/reader.ts";
import { applyLayout } from "../layout/apply.ts";
import { measurePlane, type PlaneMetrics } from "../metrics/metrics.ts";
import { parseDocument, serializeDocument } from "../model/document.ts";
import type { PlatformId } from "../platform/detect.ts";
import { BpmnEditError } from "../utils/errors.ts";
import { type Effects, noEffects } from "./effects.ts";
import { arrange } from "./geometry.ts";
import { indexModel, type Model } from "./model.ts";
import {
  addLaneOp,
  moveToLane,
  rename,
  setCalledDecision,
  setCalledElement,
  setCondition,
  setDefault,
  setHeader,
  setMapping,
} from "./properties.ts";
import { addErrorBoundary, changeType, connect, insertAfter, insertBetween, remove } from "./structure.ts";
import type { Operation } from "./types.ts";

export interface EditOutcome {
  readonly xml: string;
  readonly changedIds: readonly string[];
  readonly removedIds: readonly string[];
  readonly movedIds: readonly string[];
  readonly before: readonly PlaneMetrics[];
  readonly after: readonly PlaneMetrics[];
  readonly diagnostics: readonly string[];
  /** the platform the file was detected as (ADR 0008) */
  readonly platform: PlatformId;
}

const COMMENT = "<!--";

const STRUCTURAL = ["changeType", "insertAfter", "insertBetween", "remove", "connect", "addErrorBoundary"] as const;
type StructuralOperation = Extract<Operation, { op: (typeof STRUCTURAL)[number] }>;
type PropertyOperation = Exclude<Operation, StructuralOperation>;

function isStructural(op: Operation): op is StructuralOperation {
  return STRUCTURAL.some((name) => name === op.op);
}

function executeStructural(model: Model, op: StructuralOperation, effects: Effects): void {
  switch (op.op) {
    case "insertAfter":
      return insertAfter(model, op, effects);
    case "insertBetween":
      return insertBetween(model, op, effects);
    case "remove":
      return remove(model, op, effects);
    case "connect":
      return connect(model, op, effects);
    case "addErrorBoundary":
      return addErrorBoundary(model, op, effects);
    case "changeType":
      return changeType(model, op, effects);
  }
}

function executeProperty(model: Model, op: PropertyOperation, effects: Effects): void {
  switch (op.op) {
    case "rename":
      return rename(model, op, effects);
    case "setInput":
    case "setOutput":
      return setMapping(model, op, effects);
    case "setHeader":
      return setHeader(model, op, effects);
    case "setCondition":
      return setCondition(model, op, effects);
    case "setDefault":
      return setDefault(model, op, effects);
    case "moveToLane":
      return moveToLane(model, op, effects);
    case "addLane":
      return addLaneOp(model, op, effects);
    case "setCalledDecision":
      return setCalledDecision(model, op, effects);
    case "setCalledElement":
      return setCalledElement(model, op, effects);
  }
}

function execute(model: Model, op: Operation, effects: Effects): void {
  if (isStructural(op)) {
    executeStructural(model, op, effects);
  } else {
    executeProperty(model, op, effects);
  }
}

function runAll(model: Model, operations: readonly Operation[]): Effects {
  const effects = noEffects();
  operations.forEach((op, index) => {
    try {
      execute(model, op, effects);
    } catch (error) {
      if (error instanceof BpmnEditError) {
        throw new BpmnEditError(`operation ${index} (${op.op}): ${error.message}`);
      }
      throw error;
    }
  });
  return effects;
}

export async function applyOperations(
  xml: string,
  operations: readonly Operation[],
  source: string,
): Promise<EditOutcome> {
  const document = await parseDocument(xml, source);
  const before = planesOf(document.definitions);
  const effects = runAll(indexModel(document), operations);
  const arranged = arrange(planesOf(document.definitions), effects);
  applyLayout(document, arranged.result);
  const after = planesOf(document.definitions).filter((plane) => arranged.planes.has(plane.id));
  const touched = new Set([...arranged.planes, ...after.map((plane) => plane.id)]);
  return {
    xml: await serializeDocument(document),
    changedIds: [...effects.changed].filter((id) => !effects.removed.has(id)),
    removedIds: [...effects.removed],
    movedIds: [...arranged.moved],
    before: before.filter((plane) => touched.has(plane.id)).map(measurePlane),
    after: after.map(measurePlane),
    platform: document.platform,
    diagnostics: [
      ...(xml.includes(COMMENT) ? ["the document contained XML comments; the rewrite drops them"] : []),
      ...effects.warnings,
    ],
  };
}
