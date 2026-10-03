/**
 * Reads the outline of one flow element and one sequence flow from the moddle object model: the design core (links in
 * every spelling, lane) plus the implementation details of the file's platform adapter.
 */
import type { ModdleElement } from "bpmn-moddle";

import { laneOf } from "../operations/lanes.ts";
import { calledDecisionOf, calledElementOf, type PlatformAdapter } from "../platform/adapters.ts";
import type { ElementOutline, FlowOutline } from "./types.ts";

/** Values longer than this are shortened unless the full outline is requested. */
const MAX_VALUE_LENGTH = 80;
const EVENT_DEFINITION_SUFFIX = "EventDefinition";

export interface ElementContext {
  readonly parent?: string;
  readonly line?: number;
  readonly full: boolean;
  readonly adapter: PlatformAdapter;
}

/** 'bpmn:ServiceTask' -> 'serviceTask' */
function camelType(element: ModdleElement): string {
  const local = element.$type.slice(element.$type.indexOf(":") + 1);
  return local.charAt(0).toLowerCase() + local.slice(1);
}

function shorten(value: string, full: boolean): string {
  return full || value.length <= MAX_VALUE_LENGTH
    ? value
    : `${value.slice(0, MAX_VALUE_LENGTH)}...(+${value.length - MAX_VALUE_LENGTH} chars)`;
}

function triggerDetail(definition: ModdleElement): string | undefined {
  const timer = definition.timeDuration ?? definition.timeDate ?? definition.timeCycle;
  return definition.errorRef?.errorCode ?? definition.messageRef?.name ?? definition.signalRef?.name ?? timer?.body;
}

/** 'error: PET_NOT_FOUND', 'timer: PT1H', 'terminate', ... for the first event definition. */
function trigger(element: ModdleElement): string | undefined {
  const [definition] = element.eventDefinitions ?? [];
  if (!definition) {
    return undefined;
  }
  const kind = camelType(definition).replace(EVENT_DEFINITION_SUFFIX, "");
  const detail = triggerDetail(definition);
  return detail ? `${kind}: ${detail}` : kind;
}

export function elementOutline(element: ModdleElement, context: ElementContext): ElementOutline {
  const lane = laneOf(element) ?? (element.attachedToRef ? laneOf(element.attachedToRef) : undefined);
  return {
    id: element.id ?? "",
    type: camelType(element),
    name: element.name,
    line: context.line,
    parent: context.parent,
    lane: lane?.id,
    attachedTo: element.attachedToRef?.id,
    trigger: trigger(element),
    calledElement: calledElementOf(element),
    calledDecision: element.$type === "bpmn:BusinessRuleTask" ? calledDecisionOf(element) : undefined,
    ...context.adapter.details(element, (value) => shorten(value, context.full)),
    default: element.default?.id,
  };
}

export function flowOutline(flow: ModdleElement, context: ElementContext): FlowOutline {
  const condition = flow.conditionExpression?.body;
  return {
    id: flow.id ?? "",
    from: flow.sourceRef?.id ?? "",
    to: flow.targetRef?.id ?? "",
    name: flow.name,
    condition: condition === undefined ? undefined : shorten(condition, context.full),
    line: context.line,
  };
}
