/**
 * The outline: semantics of a BPMN document without DI, every element with its XML line — the design core (lanes,
 * links) plus the implementation details of the file's platform (ADR 0008).
 */
import type { Rect } from "../geometry/geometry.ts";
import type { PlatformId } from "../platform/detect.ts";

export interface OutlineOptions {
  /** only this element and its neighbours along sequence flows */
  readonly around?: string;
  /** flow steps in both directions from `around` */
  readonly depth: number;
  /** include the DI bounds of every element */
  readonly bounds: boolean;
  /** show long values in full instead of shortened */
  readonly full: boolean;
}

export interface TemplateReference {
  readonly id: string;
  readonly version: string;
}

export interface ElementOutline {
  readonly id: string;
  /** local BPMN type in camel case: 'serviceTask', 'exclusiveGateway', ... */
  readonly type: string;
  readonly name?: string;
  /** line of the opening tag in the XML */
  readonly line?: number;
  /** enclosing sub-process */
  readonly parent?: string;
  /** the lane (role) of the element */
  readonly lane?: string;
  /** host activity of a boundary event */
  readonly attachedTo?: string;
  /** event definition with its detail: 'error: CODE', 'timer: PT1H', 'message: name', 'terminate', ... */
  readonly trigger?: string;
  /** callActivity: the called process (file stem), any spelling */
  readonly calledElement?: string;
  /** businessRuleTask: the called decision (file stem), any spelling */
  readonly calledDecision?: string;
  readonly template?: TemplateReference;
  /** implementation: the job type (Camunda 8), the class, expression or external topic (Camunda 7) */
  readonly taskType?: string;
  /** mappings: target (Camunda 8) or parameter name (Camunda 7) to source expression */
  readonly inputs?: Readonly<Record<string, string>>;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly script?: string;
  readonly resultVariable?: string;
  readonly formId?: string;
  /** assignee or candidate groups of a user task */
  readonly assignment?: string;
  /** id of the default flow of a gateway or activity */
  readonly default?: string;
  readonly bounds?: Rect;
}

export interface FlowOutline {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly name?: string;
  /** condition expression (FEEL in Camunda 8, JUEL in Camunda 7, free text in a design model) */
  readonly condition?: string;
  readonly line?: number;
}

export interface LaneOutline {
  readonly id: string;
  readonly name?: string;
}

export interface ProcessOutline {
  readonly id: string;
  readonly name?: string;
  /** the lanes (roles) of the process */
  readonly lanes?: readonly LaneOutline[];
  readonly elements: readonly ElementOutline[];
  readonly flows: readonly FlowOutline[];
  /** set when `around` limited the output: what was left out */
  readonly omitted?: { readonly elements: number; readonly flows: number };
}

export interface Outline {
  /** the platform the file was detected as: 'design' (no implementation details), 'c7' or 'c8' */
  readonly platform: PlatformId;
  readonly processes: readonly ProcessOutline[];
}
