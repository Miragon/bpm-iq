/**
 * Edits of the semantic model through bpmn-moddle: elements are created by the moddle so that the serializer writes
 * them like the modeler does, references are objects, so a renamed id reaches every reference by itself.
 */
import type { ModdleElement } from "bpmn-moddle";

import type { BpmnDocument } from "../model/document.ts";
import { adapterFor, requireImplement } from "../platform/adapters.ts";
import { BpmnEditError } from "../utils/errors.ts";
import { leaveLanes } from "./lanes.ts";
import type { NewElement } from "./types.ts";

export interface Model {
  readonly document: BpmnDocument;
  readonly byId: Map<string, ModdleElement>;
  /**
   * Whether the file lists a node's flows in <bpmn:incoming>/<bpmn:outgoing> (the modeler does, hand-written and
   * generated files often do not): those lists are optional, sourceRef/targetRef are the truth, so reads always use
   * the flows and the lists are only maintained where the file keeps them.
   */
  readonly flowRefs: boolean;
}

const ID = /^[A-Za-z_][\w.-]*$/;

function collect(element: ModdleElement, byId: Map<string, ModdleElement>): void {
  if (element.id) {
    byId.set(element.id, element);
  }
  const children = [
    ...(element.rootElements ?? []),
    ...(element.flowElements ?? []),
    ...(element.participants ?? []),
    ...(element.laneSets ?? []),
    ...(element.lanes ?? []),
    ...(element.childLaneSet ? [element.childLaneSet] : []),
  ];
  for (const child of children) {
    collect(child, byId);
  }
}

export function indexModel(document: BpmnDocument): Model {
  const byId = new Map<string, ModdleElement>();
  collect(document.definitions, byId);
  const flowRefs = [...byId.values()].some(
    (element) => (element.incoming ?? []).length > 0 || (element.outgoing ?? []).length > 0,
  );
  return { document, byId, flowRefs };
}

export function element(model: Model, id: string, what: string): ModdleElement {
  const found = model.byId.get(id);
  if (!found) {
    throw new BpmnEditError(`no ${what} with id '${id}'`);
  }
  return found;
}

export function sequenceFlow(model: Model, id: string): ModdleElement {
  const flow = element(model, id, "sequence flow");
  if (flow.$type !== "bpmn:SequenceFlow") {
    throw new BpmnEditError(`'${id}' is a ${flow.$type}, not a sequence flow`);
  }
  return flow;
}

export function checkNewId(model: Model, id: string): void {
  if (!ID.test(id)) {
    throw new BpmnEditError(`'${id}' is not a valid id (letters, digits, _ . -, not starting with a digit)`);
  }
  if (model.byId.has(id)) {
    throw new BpmnEditError(`id '${id}' is already taken`);
  }
}

export function containerOf(node: ModdleElement): ModdleElement {
  const parent = node.$parent;
  if (!parent?.flowElements) {
    throw new BpmnEditError(`'${node.id ?? ""}' is not inside a process or sub-process`);
  }
  return parent;
}

function remove<T>(list: T[] | undefined, item: T): void {
  const index = list?.indexOf(item) ?? -1;
  if (list && index !== -1) {
    list.splice(index, 1);
  }
}

/** Adds a created element to a process or sub-process and to the index. */
export function addToContainer(model: Model, container: ModdleElement, created: ModdleElement): ModdleElement {
  created.$parent = container;
  (container.flowElements ??= []).push(created);
  model.byId.set(created.id ?? "", created);
  return created;
}

/** 'Task_ship_goods' -> 'ship_goods', 'serviceTask_checkStock' -> 'checkStock': the id without its type prefix. */
function stem(id: string): string {
  return id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Flow ids the Camunda Modeler generates: `Flow_` and seven base-36 characters. */
const MODELER_FLOW_ID = /^Flow_[0-9a-z]{7}$/;
const CAMEL_FLOW_ID = /^flow_[a-z]\w*To[A-Z]/;
const NUMBERED_FLOW_ID = /^([A-Za-z]+_)(\d+)$/;

/** A short stable hash of the text in base 36, seven characters like a modeler id. */
function hash7(text: string): string {
  let value = 2166136261;
  for (const char of text) {
    value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  return value.toString(36).padStart(7, "0").slice(-7);
}

/** The id style the file's sequence flows follow, so new flows look like the existing ones. */
function flowStyle(model: Model): { style: "modeler" | "camel" | "numbered" | "snake"; prefix: string } {
  const ids = [...model.byId.values()].filter((e) => e.$type === "bpmn:SequenceFlow").map((e) => e.id ?? "");
  const most = (predicate: (id: string) => boolean): boolean =>
    ids.length > 0 && ids.filter(predicate).length * 2 >= ids.length;
  if (most((id) => MODELER_FLOW_ID.test(id))) {
    return { style: "modeler", prefix: "Flow_" };
  }
  if (most((id) => CAMEL_FLOW_ID.test(id))) {
    return { style: "camel", prefix: "flow_" };
  }
  if (most((id) => NUMBERED_FLOW_ID.test(id))) {
    const prefixes = ids.map((id) => NUMBERED_FLOW_ID.exec(id)?.[1]).filter((p): p is string => p !== undefined);
    const counts = new Map<string, number>();
    prefixes.forEach((p) => counts.set(p, (counts.get(p) ?? 0) + 1));
    return { style: "numbered", prefix: [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Flow_" };
  }
  const prefixes = new Map<string, number>();
  for (const id of ids) {
    const prefix = /^[A-Za-z]+_/.exec(id)?.[0];
    if (prefix) {
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    }
  }
  const [prefix] = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["Flow_"];
  return { style: "snake", prefix };
}

/**
 * A free id for a new flow in the convention of the file: `Flow_<hash>` beside modeler ids, `flow_<source>To<Target>`
 * beside that style, the next free number beside `Flow_1`, `Flow_2`, …, else `<prefix><source>_to_<target>`;
 * numbered when taken.
 */
function flowId(model: Model, source: string, target: string): string {
  const { style, prefix } = flowStyle(model);
  if (style === "numbered") {
    let next = 1;
    for (const id of model.byId.keys()) {
      const match = NUMBERED_FLOW_ID.exec(id);
      if (match?.[1] === prefix) next = Math.max(next, Number(match[2]) + 1);
    }
    while (model.byId.has(`${prefix}${next}`)) next++;
    return `${prefix}${next}`;
  }
  const base =
    style === "modeler"
      ? `${prefix}${hash7(`${source}->${target}`)}`
      : style === "camel"
        ? `${prefix}${stem(source).charAt(0).toLowerCase()}${stem(source).slice(1)}To${capitalise(stem(target))}`
        : `${prefix}${stem(source)}_to_${stem(target)}`;
  let candidate = base;
  for (let counter = 2; model.byId.has(candidate); counter++) {
    candidate = `${base}${style === "snake" ? "_" : ""}${counter}`;
  }
  return candidate;
}

export function createFlowNode(
  model: Model,
  container: ModdleElement,
  spec: NewElement,
  warnings: string[],
): ModdleElement {
  checkNewId(model, spec.id);
  const { moddle } = model.document;
  const type = `bpmn:${spec.type.charAt(0).toUpperCase()}${spec.type.slice(1)}`;
  const node = moddle.create(type, { id: spec.id, name: spec.name });
  const { document } = model;
  if (spec.template) {
    requireImplement(document, "template", "An element template").setTemplate(document, node, spec.template);
  }
  adapterFor(document).created(document, node);
  if (spec.calledElement !== undefined) {
    adapterFor(document).setCalledElement(document, node, spec.calledElement);
  }
  if (spec.calledDecision !== undefined) {
    const adapterWarnings = adapterFor(document).setCalledDecision(document, node, spec.calledDecision);
    warnings.push(...adapterWarnings);
  }
  return addToContainer(model, container, node);
}

function flowsOf(node: ModdleElement): ModdleElement[] {
  return (node.$parent?.flowElements ?? []).filter((element) => element.$type === "bpmn:SequenceFlow");
}

/** The sequence flows into the node, from their targetRef (never from the optional <bpmn:incoming> list). */
export function incomingOf(node: ModdleElement): ModdleElement[] {
  return flowsOf(node).filter((flow) => flow.targetRef === node);
}

/** The sequence flows out of the node, from their sourceRef (never from the optional <bpmn:outgoing> list). */
export function outgoingOf(node: ModdleElement): ModdleElement[] {
  return flowsOf(node).filter((flow) => flow.sourceRef === node);
}

export function connect(
  model: Model,
  source: ModdleElement,
  target: ModdleElement,
  spec: { id?: string; name?: string },
): ModdleElement {
  const id = spec.id ?? flowId(model, source.id ?? "", target.id ?? "");
  checkNewId(model, id);
  const flow = model.document.moddle.create("bpmn:SequenceFlow", { id, name: spec.name });
  flow.sourceRef = source;
  flow.targetRef = target;
  if (model.flowRefs) {
    (source.outgoing ??= []).push(flow);
    (target.incoming ??= []).push(flow);
  }
  return addToContainer(model, containerOf(source), flow);
}

export function retarget(model: Model, flow: ModdleElement, target: ModdleElement): void {
  remove(flow.targetRef?.incoming, flow);
  flow.targetRef = target;
  if (model.flowRefs) {
    (target.incoming ??= []).push(flow);
  }
}

export function removeFlow(model: Model, flow: ModdleElement): void {
  remove(flow.sourceRef?.outgoing, flow);
  remove(flow.targetRef?.incoming, flow);
  if (flow.sourceRef?.default === flow) {
    flow.sourceRef.default = undefined;
  }
  remove(flow.$parent?.flowElements, flow);
  model.byId.delete(flow.id ?? "");
}

export function removeNode(model: Model, node: ModdleElement): void {
  leaveLanes(node);
  remove(node.$parent?.flowElements, node);
  model.byId.delete(node.id ?? "");
}
