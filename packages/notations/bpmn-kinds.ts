/**
 * The ONE BPMN element taxonomy. Three modules used to carry partial copies
 * (extract's 22-tag whitelist, the validator's byte-identical twin, derive's
 * activity/event partition) — and the two activity classifiers had already
 * drifted: the validator's 7±2 count missed adHocSubProcess/transaction that
 * deriveProcess counts as steps.
 *
 * ZERO imports, enforced by `pnpm arch` (rule bpmn-kinds-has-zero-imports):
 * derive.ts imports this at RUNTIME and must stay browser-safe, so nothing
 * (not even ./extract with its fast-xml-parser) may ever ride in through here.
 */
export type BpmnKind = "activity" | "event" | "gateway";

export const BPMN_ELEMENT_KIND: ReadonlyMap<string, BpmnKind> = new Map<string, BpmnKind>([
  ["task", "activity"],
  ["userTask", "activity"],
  ["serviceTask", "activity"],
  ["scriptTask", "activity"],
  ["businessRuleTask", "activity"],
  ["manualTask", "activity"],
  ["sendTask", "activity"],
  ["receiveTask", "activity"],
  ["callActivity", "activity"],
  ["subProcess", "activity"],
  ["adHocSubProcess", "activity"],
  ["transaction", "activity"],
  ["startEvent", "event"],
  ["endEvent", "event"],
  ["intermediateThrowEvent", "event"],
  ["intermediateCatchEvent", "event"],
  ["boundaryEvent", "event"],
  ["exclusiveGateway", "gateway"],
  ["parallelGateway", "gateway"],
  ["inclusiveGateway", "gateway"],
  ["eventBasedGateway", "gateway"],
  ["complexGateway", "gateway"],
]);

/** the kind of a flow-node tag; undefined = not a flow node (artifact, lane, …) */
export const kindOf = (tag: string): BpmnKind | undefined => BPMN_ELEMENT_KIND.get(tag);

/** every flow-node tag — everything else (textAnnotation, dataObject, …) is a
 *  legal artifact but NOT a flow node; treating it as one produces false
 *  "unreachable"/"dead end" errors on perfectly valid models */
export const BPMN_FLOW_NODE_TAGS: ReadonlySet<string> = new Set(BPMN_ELEMENT_KIND.keys());

/** container tags whose children form their own flow graph */
export const BPMN_SUB_CONTAINER_TAGS: ReadonlySet<string> = new Set(["subProcess", "adHocSubProcess", "transaction"]);

/** non-flow-node artifacts that still need a BPMNDI shape/edge to render.
 *  Exactly these five: plain `dataObject` is deliberately ABSENT — bpmn-js
 *  draws the dataObjectReference, not the dataObject; requiring DI for the
 *  latter would false-error every model with one. */
export const BPMN_DI_ARTIFACT_TAGS: ReadonlySet<string> = new Set([
  "textAnnotation",
  "association",
  "dataObjectReference",
  "dataStoreReference",
  "group",
]);
