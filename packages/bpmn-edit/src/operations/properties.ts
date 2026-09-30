/**
 * Operations that change properties: names, ids, conditions, default flows, lanes and the call and decision links of
 * the design core; variable mappings and task headers through the platform adapter.
 */
import { adapterFor, requireImplement } from "../platform/adapters.ts";
import { BpmnEditError } from "../utils/errors.ts";
import { diOf, labelBounds } from "./di.ts";
import type { Effects } from "./effects.ts";
import { addLane, joinLane, laneById, laneOf } from "./lanes.ts";
import { checkNewId, element, incomingOf, type Model, outgoingOf, sequenceFlow } from "./model.ts";
import type { Operation } from "./types.ts";

type OperationOf<K extends Operation["op"]> = Extract<Operation, { op: K }>;

export function rename(model: Model, op: OperationOf<"rename">, effects: Effects): void {
  const target = element(model, op.id, "element");
  target.name = op.name;
  const label = diOf(model.document, target)?.label;
  if (label?.bounds) {
    const { x, y, width } = label.bounds;
    const resized = labelBounds(op.name, { x: x + width / 2, y });
    label.bounds = model.document.moddle.create("dc:Bounds", resized);
    effects.labels.add(op.id);
  }
  effects.changed.add(op.id);
}

export function setMapping(
  model: Model,
  op: OperationOf<"setInput"> | OperationOf<"setOutput">,
  effects: Effects,
): void {
  const owner = element(model, op.id, "element");
  const { document } = model;
  requireImplement(document, op.op, "A variable mapping").setMapping(
    document,
    owner,
    op.op === "setInput" ? "input" : "output",
    op.target,
    op.source,
  );
  effects.changed.add(op.id);
}

export function setHeader(model: Model, op: OperationOf<"setHeader">, effects: Effects): void {
  const owner = element(model, op.id, "element");
  const { document } = model;
  requireImplement(document, "setHeader", "A task header").setHeader(document, owner, op.key, op.value);
  effects.changed.add(op.id);
}

export function setCalledDecision(model: Model, op: OperationOf<"setCalledDecision">, effects: Effects): void {
  const task = element(model, op.id, "business rule task");
  const { document } = model;
  adapterFor(document)
    .setCalledDecision(document, task, op.decision)
    .forEach((warning) => effects.warnings.push(warning));
  effects.changed.add(op.id);
}

export function setCalledElement(model: Model, op: OperationOf<"setCalledElement">, effects: Effects): void {
  const activity = element(model, op.id, "call activity");
  const { document } = model;
  adapterFor(document).setCalledElement(document, activity, op.process);
  effects.changed.add(op.id);
}

/** A new lane (role) in the process (the only one, else the named one), at the bottom of its pool. */
export function addLaneOp(model: Model, op: OperationOf<"addLane">, effects: Effects): void {
  checkNewId(model, op.id);
  const processes = (model.document.definitions.rootElements ?? []).filter((root) => root.$type === "bpmn:Process");
  const process = op.process === undefined ? processes[0] : processes.find((candidate) => candidate.id === op.process);
  if (!process || (op.process === undefined && processes.length > 1)) {
    throw new BpmnEditError(
      op.process === undefined
        ? "the document has several processes; name one with process"
        : `no process '${op.process}'`,
    );
  }
  const lane = addLane(model.document, process, op.id, op.name);
  model.byId.set(op.id, lane);
  effects.changed.add(op.id);
}

/** Changes the role of a node: it and its boundary events join the lane; the shape moves into the lane's band. */
export function moveToLane(model: Model, op: OperationOf<"moveToLane">, effects: Effects): void {
  const node = element(model, op.id, "flow node");
  const lane = laneById(node, op.lane);
  if (laneOf(node) === lane) {
    return;
  }
  const boundaries = (node.$parent?.flowElements ?? []).filter((candidate) => candidate.attachedToRef === node);
  for (const member of [node, ...boundaries]) {
    joinLane(member, lane);
  }
  effects.relocations.push({ id: op.id, lane: op.lane });
  for (const flow of [...incomingOf(node), ...outgoingOf(node)]) {
    effects.routes.add(flow.id ?? "");
  }
  effects.changed.add(op.id);
}

export function setCondition(model: Model, op: OperationOf<"setCondition">, effects: Effects): void {
  const flow = sequenceFlow(model, op.flow);
  if (op.condition !== null && flow.sourceRef?.default === flow) {
    throw new BpmnEditError(
      `'${op.flow}' is the default flow of '${flow.sourceRef.id ?? ""}'; a default flow has no condition`,
    );
  }
  flow.conditionExpression =
    op.condition === null ? undefined : model.document.moddle.create("bpmn:FormalExpression", { body: op.condition });
  effects.changed.add(op.flow);
}

export function setDefault(model: Model, op: OperationOf<"setDefault">, effects: Effects): void {
  const gateway = element(model, op.gateway, "gateway or activity");
  const flow = sequenceFlow(model, op.flow);
  if (flow.sourceRef !== gateway) {
    throw new BpmnEditError(`flow '${op.flow}' does not leave '${op.gateway}'`);
  }
  gateway.default = flow;
  // a default flow is taken when no condition holds; it carries none itself
  flow.conditionExpression = undefined;
  effects.changed.add(op.gateway);
  effects.changed.add(op.flow);
}
