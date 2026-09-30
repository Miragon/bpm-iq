/**
 * Reads a batch of operations from JSON and validates it at the boundary. Unknown operations, missing or mistyped
 * fields and unknown keys are errors that name the index of the operation.
 */
import { BpmnEditError } from "../utils/errors.ts";
import { NEW_ELEMENT_TYPES, type NewElement, type Operation, type Row } from "./types.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
interface JsonObject {
  readonly [key: string]: Json;
}

const parseJson: (text: string) => Json = JSON.parse;
const ROWS: readonly Row[] = ["same", "below", "bottom"];

/** Field kinds of every operation: required string, optional string, string or null, optional boolean, element. */
type Kind = "string" | "string?" | "nullable" | "boolean?" | "element" | "named?";

const FIELDS: Readonly<Record<Operation["op"], Readonly<Record<string, Kind>>>> = {
  insertAfter: {
    after: "string",
    element: "element",
    via: "string?",
    branch: "boolean?",
    name: "string?",
    condition: "string?",
  },
  insertBetween: { flow: "string", element: "element" },
  remove: { id: "string", reconnect: "boolean?" },
  rename: { id: "string", name: "string" },
  setInput: { id: "string", target: "string", source: "nullable" },
  setOutput: { id: "string", target: "string", source: "nullable" },
  setHeader: { id: "string", key: "string", value: "nullable" },
  setCondition: { flow: "string", condition: "nullable" },
  setDefault: { gateway: "string", flow: "string" },
  moveToLane: { id: "string", lane: "string" },
  addLane: { id: "string", name: "string", process: "string?" },
  changeType: { id: "string", type: "string" },
  setCalledDecision: { id: "string", decision: "nullable" },
  setCalledElement: { id: "string", process: "nullable" },
  addErrorBoundary: {
    attachTo: "string",
    id: "string",
    name: "string",
    errorCode: "string",
    to: "string?",
    end: "named?",
  },
  connect: { from: "string", to: "string", id: "string?", name: "string?", condition: "string?" },
};

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperationName(value: Json | undefined): value is Operation["op"] {
  return typeof value === "string" && Object.hasOwn(FIELDS, value);
}

function checkTemplate(template: Json | undefined): string | undefined {
  if (template === undefined) {
    return undefined;
  }
  const valid = isObject(template) && typeof template["id"] === "string" && typeof template["version"] === "number";
  return valid ? undefined : "template must be { id: string, version: number }";
}

const ELEMENT_FIELDS = ["type", "id", "name", "row", "template", "lane", "calledElement", "calledDecision"];

function checkElement(value: Json | undefined): string | undefined {
  if (!isObject(value)) {
    return "must be an object";
  }
  const unknown = Object.keys(value).filter((key) => !ELEMENT_FIELDS.includes(key));
  if (unknown.length > 0) {
    return `has unknown field ${unknown.join(", ")}`;
  }
  const { type, id, name, row, template } = value;
  for (const key of ["lane", "calledElement", "calledDecision"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      return `${key} must be a string`;
    }
  }
  if (!NEW_ELEMENT_TYPES.some((known) => known === type)) {
    return `type must be one of ${NEW_ELEMENT_TYPES.join(", ")}`;
  }
  if (typeof id !== "string" || typeof name !== "string") {
    return "id and name must be strings";
  }
  if (row !== undefined && !ROWS.some((known) => known === row)) {
    return `row must be one of ${ROWS.join(", ")}`;
  }
  return checkTemplate(template);
}

/** Checks of the scalar field kinds: the test and the message when it fails. */
const SCALAR_CHECKS: Readonly<
  Record<Exclude<Kind, "element" | "named?">, readonly [(value: Json | undefined) => boolean, string]>
> = {
  string: [(value) => typeof value === "string", "must be a string"],
  "string?": [(value) => value === undefined || typeof value === "string", "must be a string"],
  nullable: [(value) => value === null || typeof value === "string", "must be a string or null"],
  "boolean?": [(value) => value === undefined || typeof value === "boolean", "must be a boolean"],
};

function checkField(kind: Kind, value: Json | undefined): string | undefined {
  if (kind === "element") {
    return checkElement(value);
  }
  if (kind === "named?") {
    const valid =
      value === undefined ||
      (isObject(value) &&
        typeof value["id"] === "string" &&
        typeof value["name"] === "string" &&
        Object.keys(value).length === 2);
    return valid ? undefined : "must be { id: string, name: string }";
  }
  const [valid, message] = SCALAR_CHECKS[kind];
  return valid(value) ? undefined : message;
}

function problem(value: Json | undefined): string | undefined {
  if (!isObject(value) || !isOperationName(value["op"])) {
    return `needs "op" as one of ${Object.keys(FIELDS).join(", ")}`;
  }
  const fields = FIELDS[value["op"]];
  const unknown = Object.keys(value).filter((key) => key !== "op" && !Object.hasOwn(fields, key));
  if (unknown.length > 0) {
    return `unknown field ${unknown.join(", ")}`;
  }
  for (const [field, kind] of Object.entries(fields)) {
    const error = checkField(kind, value[field]);
    if (error) {
      return `${field} ${error}`;
    }
  }
  return undefined;
}

function text(value: JsonObject, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function optional(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function nullable(value: JsonObject, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

/** `{ key: value }` only for a present value, so an absent optional field stays absent. */
function defined<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function element(value: JsonObject): NewElement {
  const raw = value["element"];
  const spec = isObject(raw) ? raw : {};
  const template = spec["template"];
  return {
    type: NEW_ELEMENT_TYPES.find((type) => type === spec["type"]) ?? "task",
    id: text(spec, "id"),
    name: text(spec, "name"),
    row: ROWS.find((row) => row === spec["row"]),
    ...defined("lane", optional(spec, "lane")),
    ...defined("calledElement", optional(spec, "calledElement")),
    ...defined("calledDecision", optional(spec, "calledDecision")),
    template: isObject(template) ? { id: text(template, "id"), version: Number(template["version"]) } : undefined,
  };
}

type Builders = { readonly [K in Operation["op"]]: (value: JsonObject) => Extract<Operation, { op: K }> };

/** Builds the typed operation from a JSON object that passed the checks above. */
const BUILDERS: Builders = {
  insertAfter: (v) => ({
    op: "insertAfter",
    after: text(v, "after"),
    element: element(v),
    via: optional(v, "via"),
    ...(v["branch"] === true ? { branch: true } : {}),
    ...defined("name", optional(v, "name")),
    ...defined("condition", optional(v, "condition")),
  }),
  insertBetween: (v) => ({ op: "insertBetween", flow: text(v, "flow"), element: element(v) }),
  remove: (v) => ({ op: "remove", id: text(v, "id"), reconnect: v["reconnect"] === true }),
  rename: (v) => ({ op: "rename", id: text(v, "id"), name: text(v, "name") }),
  setInput: (v) => ({ op: "setInput", id: text(v, "id"), target: text(v, "target"), source: nullable(v, "source") }),
  setOutput: (v) => ({ op: "setOutput", id: text(v, "id"), target: text(v, "target"), source: nullable(v, "source") }),
  setHeader: (v) => ({ op: "setHeader", id: text(v, "id"), key: text(v, "key"), value: nullable(v, "value") }),
  setCondition: (v) => ({ op: "setCondition", flow: text(v, "flow"), condition: nullable(v, "condition") }),
  setDefault: (v) => ({ op: "setDefault", gateway: text(v, "gateway"), flow: text(v, "flow") }),
  moveToLane: (v) => ({ op: "moveToLane", id: text(v, "id"), lane: text(v, "lane") }),
  addLane: (v) => ({ op: "addLane", id: text(v, "id"), name: text(v, "name"), process: optional(v, "process") }),
  changeType: (v) => ({ op: "changeType", id: text(v, "id"), type: text(v, "type") }),
  setCalledDecision: (v) => ({ op: "setCalledDecision", id: text(v, "id"), decision: nullable(v, "decision") }),
  setCalledElement: (v) => ({ op: "setCalledElement", id: text(v, "id"), process: nullable(v, "process") }),
  addErrorBoundary: (v) => ({
    op: "addErrorBoundary",
    attachTo: text(v, "attachTo"),
    id: text(v, "id"),
    name: text(v, "name"),
    errorCode: text(v, "errorCode"),
    ...defined("to", optional(v, "to")),
    ...(isObject(v["end"]) ? { end: { id: text(v["end"], "id"), name: text(v["end"], "name") } } : {}),
  }),
  connect: (v) => ({
    op: "connect",
    from: text(v, "from"),
    to: text(v, "to"),
    id: optional(v, "id"),
    name: optional(v, "name"),
    condition: optional(v, "condition"),
  }),
};

export function parseOperations(content: string, source: string): Operation[] {
  let json: Json;
  try {
    json = parseJson(content);
  } catch (error) {
    throw new BpmnEditError(`${source}: not valid JSON (${String(error)})`);
  }
  return toOperations(json, source);
}

/** The typed batch from an already parsed JSON value (an MCP tool argument): one operation or a list of them. */
export function toOperations(json: unknown, source: string): Operation[] {
  const list: Json[] = Array.isArray(json) ? (json as Json[]) : [json as Json];
  return list.map((value, index) => {
    const error = problem(value);
    if (error || !isObject(value) || !isOperationName(value["op"])) {
      throw new BpmnEditError(`${source}: operation ${index}: ${error ?? "must be an object"}`);
    }
    return BUILDERS[value["op"]](value);
  });
}
