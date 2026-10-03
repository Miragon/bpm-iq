/**
 * The operations an agent applies to a BPMN document; a batch runs in order and is applied all or nothing. The design
 * operations work on every BPMN file; setInput, setOutput, setHeader and an element template are implementation
 * details that only the adapter of a Camunda 7 or Camunda 8 file writes (ADR 0008).
 */

export const NEW_ELEMENT_TYPES = [
  "serviceTask",
  "userTask",
  "scriptTask",
  "sendTask",
  "receiveTask",
  "manualTask",
  "businessRuleTask",
  "callActivity",
  "task",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "intermediateCatchEvent",
  "intermediateThrowEvent",
  "endEvent",
] as const;

export type NewElementType = (typeof NEW_ELEMENT_TYPES)[number];

/** Where a new element goes relative to its anchor: its row, the row below, or a new row at the bottom. */
export type Row = "same" | "below" | "bottom";

export interface NewElement {
  readonly type: NewElementType;
  readonly id: string;
  readonly name: string;
  /** element template to reference (implement: Camunda 7 or 8); the template sync fills in the rest */
  readonly template?: { readonly id: string; readonly version: number };
  readonly row?: Row;
  /** the lane (role) of the new element; by default the lane of its anchor */
  readonly lane?: string;
  /** callActivity: the called process (its file stem) */
  readonly calledElement?: string;
  /** businessRuleTask: the called decision (its file stem) */
  readonly calledDecision?: string;
}

export type Operation =
  | {
      readonly op: "insertAfter";
      readonly after: string;
      readonly element: NewElement;
      /** the outgoing flow to split when `after` has several */
      readonly via?: string;
      /** a new outgoing flow instead of splitting one (a new outcome of a gateway); implied for an end event */
      readonly branch?: boolean;
      /** name and condition of the flow into the element (the new one of a branch, else the split one) */
      readonly name?: string;
      readonly condition?: string;
    }
  | { readonly op: "insertBetween"; readonly flow: string; readonly element: NewElement }
  | { readonly op: "remove"; readonly id: string; readonly reconnect?: boolean }
  | { readonly op: "rename"; readonly id: string; readonly name: string }
  | { readonly op: "setInput"; readonly id: string; readonly target: string; readonly source: string | null }
  | { readonly op: "setOutput"; readonly id: string; readonly target: string; readonly source: string | null }
  | { readonly op: "setHeader"; readonly id: string; readonly key: string; readonly value: string | null }
  | { readonly op: "setCondition"; readonly flow: string; readonly condition: string | null }
  | { readonly op: "setDefault"; readonly gateway: string; readonly flow: string }
  | { readonly op: "moveToLane"; readonly id: string; readonly lane: string }
  | { readonly op: "addLane"; readonly id: string; readonly name: string; readonly process?: string }
  | { readonly op: "changeType"; readonly id: string; readonly type: string }
  | { readonly op: "setCalledDecision"; readonly id: string; readonly decision: string | null }
  | { readonly op: "setCalledElement"; readonly id: string; readonly process: string | null }
  | {
      readonly op: "addErrorBoundary";
      readonly attachTo: string;
      readonly id: string;
      readonly name: string;
      readonly errorCode: string;
      /** the existing flow node the error path leads to … */
      readonly to?: string;
      /** … or a new end event for it (exactly one of both) */
      readonly end?: { readonly id: string; readonly name: string };
    }
  | {
      readonly op: "connect";
      readonly from: string;
      readonly to: string;
      readonly id?: string;
      readonly name?: string;
      readonly condition?: string;
    };

export type OperationName = Operation["op"];
