/** Operations that change the flow structure: insert, remove, connect, add an error boundary event. */
import type { ModdleElement } from "bpmn-moddle";

import type { Rect } from "../geometry/geometry.ts";
import { BOUNDARY_FROM_BOTTOM, BOUNDARY_FROM_RIGHT } from "../layout/constants.ts";
import { adapterFor } from "../platform/adapters.ts";
import { BpmnEditError } from "../utils/errors.ts";
import { addEdge, addShape, diOf, planeShowing, removeDi, sizeOf } from "./di.ts";
import type { Effects } from "./effects.ts";
import { assignLane, lanesOf } from "./lanes.ts";
import {
  addToContainer,
  checkNewId,
  connect as connectNodes,
  containerOf,
  createFlowNode,
  element,
  incomingOf,
  type Model,
  outgoingOf,
  removeFlow,
  removeNode,
  retarget,
  sequenceFlow,
} from "./model.ts";
import type { NewElement, Operation } from "./types.ts";

type OperationOf<K extends Operation["op"]> = Extract<Operation, { op: K }>;

function boundsOf(model: Model, node: ModdleElement): Rect {
  const bounds = diOf(model.document, node)?.bounds;
  if (!bounds) {
    throw new BpmnEditError(`'${node.id ?? ""}' has no shape in any diagram`);
  }
  return bounds;
}

function provisionalEdge(model: Model, flow: ModdleElement): void {
  const plane = planeShowing(model.document, flow.sourceRef ?? flow);
  const from = boundsOf(model, flow.sourceRef ?? flow);
  const to = boundsOf(model, flow.targetRef ?? flow);
  addEdge(model.document, plane, flow, [
    { x: from.x + from.width, y: from.y + from.height / 2 },
    { x: to.x, y: to.y + to.height / 2 },
  ]);
}

/** The outgoing flow of `after` that the new element is inserted into, or undefined when `after` has none. */
function splitFlow(model: Model, after: ModdleElement, via: string | undefined): ModdleElement | undefined {
  if (via !== undefined) {
    const flow = sequenceFlow(model, via);
    if (flow.sourceRef !== after) {
      throw new BpmnEditError(`flow '${via}' does not leave '${after.id ?? ""}'`);
    }
    return flow;
  }
  const outgoing = outgoingOf(after);
  if (outgoing.length > 1) {
    const ids = outgoing.map((flow) => flow.id ?? "").join(", ");
    throw new BpmnEditError(`'${after.id ?? ""}' has ${outgoing.length} outgoing flows (${ids}); name one with via`);
  }
  return outgoing[0];
}

function createNode(
  model: Model,
  after: ModdleElement,
  spec: NewElement,
  effects: Effects,
  before?: ModdleElement,
): ModdleElement {
  const node = createFlowNode(model, containerOf(after), spec, effects.warnings);
  assignLane(node, after, spec.lane);
  const anchor = boundsOf(model, after);
  const size = sizeOf(node);
  addShape(model.document, planeShowing(model.document, after), node, {
    x: anchor.x + anchor.width,
    y: anchor.y + anchor.height / 2 - size.height / 2,
    ...size,
  });
  effects.placements.push({
    id: spec.id,
    anchor: after.id ?? "",
    row: spec.row ?? "same",
    ...(before?.id ? { before: before.id } : {}),
  });
  effects.changed.add(spec.id);
  effects.labels.add(spec.id);
  return node;
}

/**
 * A new flow node after `after`: by default it is inserted into the outgoing flow (the only one, or `via`); with
 * `branch` — and always for an end event, which cannot pass a flow on — it hangs on a new outgoing flow of its own,
 * named and conditioned like an outcome of a gateway. `name` and `condition` always go to the flow into the new node.
 */
export function insertAfter(model: Model, op: OperationOf<"insertAfter">, effects: Effects): void {
  const after = element(model, op.after, "flow node");
  const branch = op.branch === true || op.element.type === "endEvent";
  if (branch && op.via !== undefined) {
    throw new BpmnEditError("via splits an existing flow; a branch gets a new one — use one of them");
  }
  const split = branch ? undefined : splitFlow(model, after, op.via);
  const node = createNode(model, after, op.element, effects, split?.targetRef);
  if (split) {
    const target = split.targetRef ?? node;
    retarget(model, split, node);
    // name and condition belong to the flow into the new element — here the split one
    if (op.name !== undefined) split.name = op.name;
    if (op.condition !== undefined) {
      split.conditionExpression = model.document.moddle.create("bpmn:FormalExpression", { body: op.condition });
    }
    const onward = connectNodes(model, node, target, {});
    provisionalEdge(model, onward);
    [split, onward].forEach((flow) => effects.routes.add(flow.id ?? ""));
    effects.changed.add(split.id ?? "");
    effects.changed.add(onward.id ?? "");
    return;
  }
  if (branch) {
    warnNoGateway(after, effects);
  }
  const incoming = connectNodes(model, after, node, { name: op.name });
  if (op.condition !== undefined) {
    incoming.conditionExpression = model.document.moddle.create("bpmn:FormalExpression", { body: op.condition });
  }
  provisionalEdge(model, incoming);
  effects.routes.add(incoming.id ?? "");
  effects.labels.add(incoming.id ?? "");
  effects.changed.add(incoming.id ?? "");
}

/** A second flow out of an element that is no gateway is an implicit split (bpmnlint); allowed but reported. */
function warnNoGateway(source: ModdleElement, effects: Effects): void {
  if (!source.$type.endsWith("Gateway") && outgoingOf(source).length > 0) {
    effects.warnings.push(
      `'${source.id ?? ""}' now has several outgoing flows; bpmnlint reports an implicit split, use a gateway`,
    );
  }
}

export function insertBetween(model: Model, op: OperationOf<"insertBetween">, effects: Effects): void {
  const flow = sequenceFlow(model, op.flow);
  insertAfter(
    model,
    { op: "insertAfter", after: flow.sourceRef?.id ?? "", element: op.element, via: op.flow },
    effects,
  );
}

function dropFlow(model: Model, flow: ModdleElement, effects: Effects): void {
  removeFlow(model, flow);
  removeDi(model.document, flow);
  effects.removed.add(flow.id ?? "");
}

/** The only incoming and outgoing flow of a node, or undefined when it has more or fewer. */
function singlePassage(
  node: ModdleElement,
): { incoming: ModdleElement; outgoing: ModdleElement; target: ModdleElement } | undefined {
  const incoming = incomingOf(node);
  const outgoing = outgoingOf(node);
  const [into] = incoming;
  const [out] = outgoing;
  const target = out?.targetRef;
  return incoming.length === 1 && outgoing.length === 1 && into && out && target
    ? { incoming: into, outgoing: out, target }
    : undefined;
}

function reconnectAround(model: Model, node: ModdleElement, effects: Effects): void {
  const passage = singlePassage(node);
  if (!passage) {
    throw new BpmnEditError(`'${node.id ?? ""}' needs exactly one incoming and one outgoing flow to be reconnected`);
  }
  const { incoming, outgoing } = passage;
  retarget(model, incoming, passage.target);
  dropFlow(model, outgoing, effects);
  effects.routes.add(incoming.id ?? "");
  effects.changed.add(incoming.id ?? "");
}

export function remove(model: Model, op: OperationOf<"remove">, effects: Effects): void {
  const target = element(model, op.id, "element");
  if (target.$type === "bpmn:SequenceFlow") {
    dropFlow(model, target, effects);
    return;
  }
  const boundaries = (target.$parent?.flowElements ?? []).filter((candidate) => candidate.attachedToRef === target);
  boundaries.forEach((boundary) => remove(model, { op: "remove", id: boundary.id ?? "" }, effects));
  if (op.reconnect) {
    reconnectAround(model, target, effects);
  }
  [...incomingOf(target), ...outgoingOf(target)].forEach((flow) => dropFlow(model, flow, effects));
  recordGap(model, target, effects);
  removeNode(model, target);
  removeDi(model.document, target);
  dropUnusedErrors(model, target);
  effects.removed.add(op.id);
}

function recordGap(model: Model, node: ModdleElement, effects: Effects): void {
  const bounds = diOf(model.document, node)?.bounds;
  if (bounds && !node.attachedToRef) {
    const plane = planeShowing(model.document, node).bpmnElement?.id ?? "";
    effects.gaps.push({ plane, left: bounds.x, right: bounds.x + bounds.width });
  }
}

function referencesError(element: ModdleElement, error: ModdleElement): boolean {
  return (
    (element.eventDefinitions ?? []).some((definition) => definition.errorRef === error) ||
    (element.flowElements ?? []).some((child) => referencesError(child, error))
  );
}

/** The event definitions of an element and of everything nested in it (a removed sub-process). */
function eventDefinitionsWithin(element: ModdleElement): ModdleElement[] {
  return [...(element.eventDefinitions ?? []), ...(element.flowElements ?? []).flatMap(eventDefinitionsWithin)];
}

/** Removes the bpmn:Error definitions of a removed element (and its content) that nothing references any more. */
function dropUnusedErrors(model: Model, removed: ModdleElement): void {
  const { definitions } = model.document;
  for (const definition of eventDefinitionsWithin(removed)) {
    const error = definition.errorRef;
    const roots = definitions.rootElements ?? [];
    if (error && !roots.some((root) => referencesError(root, error))) {
      roots.splice(roots.indexOf(error), 1);
      model.byId.delete(error.id ?? "");
    }
  }
}

/** A second flow into an element that is no gateway is a fake join (bpmnlint); it is allowed but reported. */
function warnFakeJoin(target: ModdleElement, effects: Effects): void {
  if (!target.$type.endsWith("Gateway") && incomingOf(target).length > 0) {
    effects.warnings.push(
      `'${target.id ?? ""}' now has several incoming flows; bpmnlint reports a fake join, merge them with a gateway`,
    );
  }
}

export function connect(model: Model, op: OperationOf<"connect">, effects: Effects): void {
  const from = element(model, op.from, "flow node");
  const to = element(model, op.to, "flow node");
  warnFakeJoin(to, effects);
  if (containerOf(from) !== containerOf(to)) {
    throw new BpmnEditError(`'${op.from}' and '${op.to}' are not in the same process or sub-process`);
  }
  const flow = connectNodes(model, from, to, { id: op.id, name: op.name });
  if (op.condition !== undefined) {
    flow.conditionExpression = model.document.moddle.create("bpmn:FormalExpression", { body: op.condition });
  }
  provisionalEdge(model, flow);
  effects.routes.add(flow.id ?? "");
  effects.labels.add(flow.id ?? "");
  effects.changed.add(flow.id ?? "");
}

/** The bpmn:Error with the code, created as `Error_<code>` when the definitions have none. */
function errorFor(model: Model, code: string): ModdleElement {
  const { definitions, moddle } = model.document;
  const existing = (definitions.rootElements ?? []).find(
    (root) => root.$type === "bpmn:Error" && root.errorCode === code,
  );
  if (existing) {
    return existing;
  }
  const id = `Error_${code.replace(/[^\w.-]/g, "_")}`;
  checkNewId(model, id);
  const created = moddle.create("bpmn:Error", { id, name: code, errorCode: code });
  created.$parent = definitions;
  (definitions.rootElements ??= []).push(created);
  model.byId.set(id, created);
  return created;
}

export function addErrorBoundary(model: Model, op: OperationOf<"addErrorBoundary">, effects: Effects): void {
  const host = element(model, op.attachTo, "activity");
  if ((op.to === undefined) === (op.end === undefined)) {
    throw new BpmnEditError("name where the error path leads: `to` (an existing node) or `end` (a new end event)");
  }
  checkNewId(model, op.id);
  const { moddle } = model.document;
  const boundary = moddle.create("bpmn:BoundaryEvent", { id: op.id, name: op.name });
  boundary.attachedToRef = host;
  const definition = moddle.create("bpmn:ErrorEventDefinition");
  definition.errorRef = errorFor(model, op.errorCode);
  boundary.eventDefinitions = [definition];
  addToContainer(model, containerOf(host), boundary);
  assignLane(boundary, host, undefined);
  const bounds = boundsOf(model, host);
  const size = sizeOf(boundary);
  // bottom right of the host; further left along the bottom edge past the boundary events already there
  const taken = (containerOf(host).flowElements ?? [])
    .filter((other) => other !== boundary && other.attachedToRef === host)
    .flatMap((other) => {
      const di = diOf(model.document, other)?.bounds;
      return di ? [di] : [];
    });
  let x = bounds.x + bounds.width - BOUNDARY_FROM_RIGHT;
  while (x > bounds.x && taken.some((other) => Math.abs(other.x - x) < size.width + 4)) {
    x -= size.width + 8;
  }
  addShape(model.document, planeShowing(model.document, host), boundary, {
    x,
    y: bounds.y + bounds.height - BOUNDARY_FROM_BOTTOM,
    ...size,
  });
  if (op.end) {
    insertAfter(
      model,
      {
        op: "insertAfter",
        after: op.id,
        element: { type: "endEvent", id: op.end.id, name: op.end.name, row: "below" },
      },
      effects,
    );
  } else {
    connect(model, { op: "connect", from: op.id, to: op.to ?? "" }, effects);
  }
  effects.changed.add(op.id);
  effects.labels.add(op.id);
}

const TASK_TYPES = [
  "task",
  "userTask",
  "serviceTask",
  "scriptTask",
  "sendTask",
  "receiveTask",
  "manualTask",
  "businessRuleTask",
];
const GATEWAY_TYPES = ["exclusiveGateway", "parallelGateway", "inclusiveGateway"];

function localType(element: ModdleElement): string {
  const local = element.$type.slice(element.$type.indexOf(":") + 1);
  return local.charAt(0).toLowerCase() + local.slice(1);
}

/**
 * Replaces a flow node by one of another type of the same family (a task kind for a task kind, a gateway kind for a
 * gateway kind) — the "replace" of the modeler. Id, name, documentation, flows, lane, boundary events and diagram
 * shape stay; what only the old type knew (a decision link, a script, platform details) goes.
 */
export function changeType(model: Model, op: OperationOf<"changeType">, effects: Effects): void {
  const old = element(model, op.id, "flow node");
  const from = localType(old);
  const family = TASK_TYPES.includes(from) ? TASK_TYPES : GATEWAY_TYPES.includes(from) ? GATEWAY_TYPES : undefined;
  if (!family || !family.includes(op.type)) {
    const allowed = family ? family.filter((type) => type !== from).join(", ") : "none";
    throw new BpmnEditError(`'${op.id}' is a ${from}; it can become: ${allowed}`);
  }
  if (from === op.type) {
    return;
  }
  const { document } = model;
  const created = document.moddle.create(`bpmn:${op.type.charAt(0).toUpperCase()}${op.type.slice(1)}`, {
    id: op.id,
    name: old.name,
  });
  if (old.documentation) {
    created.documentation = old.documentation;
  }
  const container = containerOf(old);
  created.$parent = container;
  const siblings = container.flowElements ?? [];
  siblings.splice(siblings.indexOf(old), 1, created);
  for (const flow of incomingOf(old)) flow.targetRef = created;
  for (const flow of outgoingOf(old)) flow.sourceRef = created;
  if (model.flowRefs) {
    created.incoming = [...(old.incoming ?? [])];
    created.outgoing = [...(old.outgoing ?? [])];
  }
  if (old.default && family === GATEWAY_TYPES && op.type !== "parallelGateway") {
    created.default = old.default;
  }
  for (const boundary of siblings.filter((candidate) => candidate.attachedToRef === old)) {
    boundary.attachedToRef = created;
  }
  for (const lane of lanesOf(container)) {
    const refs = lane.flowNodeRef ?? [];
    const index = refs.indexOf(old);
    if (index !== -1) refs.splice(index, 1, created);
  }
  const di = diOf(document, old);
  if (di) di.bpmnElement = created;
  adapterFor(document).created(document, created);
  model.byId.set(op.id, created);
  effects.changed.add(op.id);
}
