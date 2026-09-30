/**
 * The outline of a BPMN document: every process with its flow elements (sub-processes flattened, with `parent`),
 * their lanes, links and platform details and sequence flows, each with its line in the XML. The DI is left out except for optional
 * bounds; with `around` only the neighbourhood of one element is returned.
 */
import type { ModdleElement } from "bpmn-moddle";

import { planesOf } from "../diagram/reader.ts";
import type { Rect } from "../geometry/geometry.ts";
import { parseDocument } from "../model/document.ts";
import { lanesOf } from "../operations/lanes.ts";
import { adapterFor, type PlatformAdapter } from "../platform/adapters.ts";
import { BpmnEditError } from "../utils/errors.ts";
import { elementOutline, flowOutline } from "./elements.ts";
import { lineNumbers } from "./lines.ts";
import type { ElementOutline, FlowOutline, Outline, OutlineOptions, ProcessOutline } from "./types.ts";
import { limitToWindow } from "./window.ts";

const PROCESS = "bpmn:Process";
const SEQUENCE_FLOW = "bpmn:SequenceFlow";
/** Flow elements without a place in the flow: data objects only exist through their references. */
const SKIPPED_TYPES: ReadonlySet<string> = new Set(["bpmn:DataObject"]);

interface Collector {
  readonly lines: ReadonlyMap<string, number>;
  readonly bounds: ReadonlyMap<string, Rect> | undefined;
  readonly full: boolean;
  readonly adapter: PlatformAdapter;
  readonly elements: ElementOutline[];
  readonly flows: FlowOutline[];
}

function collect(container: ModdleElement, parent: string | undefined, collector: Collector): void {
  for (const element of container.flowElements ?? []) {
    const context = {
      parent,
      line: collector.lines.get(element.id ?? ""),
      full: collector.full,
      adapter: collector.adapter,
    };
    if (element.$type === SEQUENCE_FLOW) {
      collector.flows.push(flowOutline(element, context));
      continue;
    }
    if (SKIPPED_TYPES.has(element.$type)) {
      continue;
    }
    const bounds = collector.bounds?.get(element.id ?? "");
    collector.elements.push(
      bounds ? { ...elementOutline(element, context), bounds } : elementOutline(element, context),
    );
    collect(element, element.id, collector);
  }
}

function processOutline(process: ModdleElement, collector: Omit<Collector, "elements" | "flows">): ProcessOutline {
  const elements: ElementOutline[] = [];
  const flows: FlowOutline[] = [];
  collect(process, undefined, { ...collector, elements, flows });
  const lanes = lanesOf(process).map((lane) => ({ id: lane.id ?? "", name: lane.name }));
  return { id: process.id ?? "", name: process.name, ...(lanes.length > 0 ? { lanes } : {}), elements, flows };
}

function boundsById(definitions: ModdleElement): Map<string, Rect> {
  return new Map(planesOf(definitions).flatMap((plane) => plane.shapes.map((shape) => [shape.id, shape.bounds])));
}

function limit(processes: readonly ProcessOutline[], around: string, depth: number): ProcessOutline[] {
  const windows = processes.flatMap((process) => limitToWindow(process, around, depth) ?? []);
  if (windows.length === 0) {
    throw new BpmnEditError(`no element with id '${around}' in any process`);
  }
  return windows;
}

export async function outline(xml: string, options: OutlineOptions, source: string): Promise<Outline> {
  const document = await parseDocument(xml, source);
  const { definitions } = document;
  const collector = {
    adapter: adapterFor(document),
    lines: lineNumbers(xml),
    bounds: options.bounds ? boundsById(definitions) : undefined,
    full: options.full,
  };
  const processes = (definitions.rootElements ?? [])
    .filter((element) => element.$type === PROCESS)
    .map((process) => processOutline(process, collector));
  return {
    platform: document.platform,
    processes: options.around === undefined ? processes : limit(processes, options.around, options.depth),
  };
}
