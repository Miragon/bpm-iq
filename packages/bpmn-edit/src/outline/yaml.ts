/**
 * Formats an outline as YAML with one line per element and flow (flow mappings), the compact form an agent reads.
 * Strings that are not plain identifiers are written as JSON strings, which YAML reads as double-quoted scalars.
 */
import type { Rect } from "../geometry/geometry.ts";
import type { ElementOutline, FlowOutline, Outline, ProcessOutline } from "./types.ts";

const PLAIN = /^[A-Za-z_][\w.-]*$/;
/** Words YAML 1.1 readers turn into booleans or null. */
const RESERVED = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;
const INDENT = "  ";

type Entry = readonly [string, string | undefined];

function identifier(value: string): string {
  return PLAIN.test(value) && !RESERVED.test(value) ? value : JSON.stringify(value);
}

function text(value: string | undefined): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

function id(value: string | undefined): string | undefined {
  return value === undefined ? undefined : identifier(value);
}

function num(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function mapping(entries: readonly Entry[]): string {
  const present = entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
  return `{${present.map(([key, value]) => `${identifier(key)}: ${value}`).join(", ")}}`;
}

function dictionary(values: Readonly<Record<string, string>> | undefined): string | undefined {
  return values === undefined ? undefined : mapping(Object.entries(values).map(([key, value]) => [key, text(value)]));
}

function bounds(rect: Rect | undefined): string | undefined {
  return rect === undefined ? undefined : `[${[rect.x, rect.y, rect.width, rect.height].join(", ")}]`;
}

function elementLine(element: ElementOutline): string {
  const template = element.template ? text(`${element.template.id}@${element.template.version}`) : undefined;
  return `${identifier(element.id)}: ${mapping([
    ["type", element.type],
    ["name", text(element.name)],
    ["line", num(element.line)],
    ["parent", id(element.parent)],
    ["lane", id(element.lane)],
    ["attachedTo", id(element.attachedTo)],
    ["trigger", text(element.trigger)],
    ["calledElement", text(element.calledElement)],
    ["calledDecision", text(element.calledDecision)],
    ["template", template],
    ["taskType", text(element.taskType)],
    ["formId", text(element.formId)],
    ["assignment", text(element.assignment)],
    ["script", text(element.script)],
    ["resultVariable", text(element.resultVariable)],
    ["inputs", dictionary(element.inputs)],
    ["outputs", dictionary(element.outputs)],
    ["headers", dictionary(element.headers)],
    ["default", id(element.default)],
    ["bounds", bounds(element.bounds)],
  ])}`;
}

function flowLine(flow: FlowOutline): string {
  return `${identifier(flow.id)}: ${mapping([
    ["from", identifier(flow.from)],
    ["to", identifier(flow.to)],
    ["name", text(flow.name)],
    ["condition", text(flow.condition)],
    ["line", num(flow.line)],
  ])}`;
}

/** A block mapping of one line per entry; an empty section stays a valid empty mapping. */
function section(title: string, entries: readonly string[]): string[] {
  return entries.length === 0
    ? [`${INDENT}${title}: {}`]
    : [`${INDENT}${title}:`, ...entries.map((entry) => INDENT.repeat(2) + entry)];
}

function processLines(process: ProcessOutline): string[] {
  const lines = [`- process: ${identifier(process.id)}`];
  if (process.name !== undefined) {
    lines.push(`${INDENT}name: ${JSON.stringify(process.name)}`);
  }
  if (process.lanes) {
    lines.push(
      ...section(
        "lanes",
        process.lanes.map((lane) => `${identifier(lane.id)}: ${mapping([["name", text(lane.name)]])}`),
      ),
    );
  }
  lines.push(
    ...section("elements", process.elements.map(elementLine)),
    ...section("flows", process.flows.map(flowLine)),
  );
  if (process.omitted) {
    lines.push(
      `${INDENT}omitted: ${mapping([
        ["elements", String(process.omitted.elements)],
        ["flows", String(process.omitted.flows)],
      ])}`,
    );
  }
  return lines;
}

export function formatYaml(outline: Outline): string[] {
  return [
    `platform: ${outline.platform}`,
    "processes:",
    ...outline.processes.flatMap(processLines).map((line) => INDENT + line),
  ];
}
