/**
 * Design core vs implement adapters (ADR 0008). The core reads every spelling of a link and writes the one of the
 * file's platform; implementation details (mappings, headers, templates, job types, forms) are typed only through the
 * adapter of the file's platform, and a design model has none: the core never writes a platform extension.
 */
import type { ModdleElement } from "bpmn-moddle";

import type { BpmnDocument } from "../model/document.ts";
import type { ElementOutline } from "../outline/types.ts";
import { BpmnEditError } from "../utils/errors.ts";
import type { PlatformId } from "./detect.ts";
import { dropExtension, ensureExtension, findExtension, setEntry } from "./extensions.ts";

export type ImplementOperation = "setInput" | "setOutput" | "setHeader" | "template";

export interface TemplateReference {
  readonly id: string;
  readonly version: number;
}

/** Shortens long values of the outline unless the full outline is requested. */
export type Shorten = (value: string) => string;

export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly label: string;
  readonly implements: ReadonlySet<ImplementOperation>;
  /** extensions a new flow node gets on this platform (a Camunda 8 user task is a native one) */
  created(document: BpmnDocument, node: ModdleElement): void;
  setTemplate(document: BpmnDocument, node: ModdleElement, template: TemplateReference): void;
  /** writes the decision link in the platform's spelling; null removes it */
  setCalledDecision(document: BpmnDocument, node: ModdleElement, decision: string | null): string[];
  /** writes the call link in the platform's spelling; null removes it */
  setCalledElement(document: BpmnDocument, node: ModdleElement, process: string | null): void;
  setMapping(
    document: BpmnDocument,
    node: ModdleElement,
    direction: "input" | "output",
    target: string,
    source: string | null,
  ): void;
  setHeader(document: BpmnDocument, node: ModdleElement, key: string, value: string | null): void;
  /** the implementation details of the outline */
  details(node: ModdleElement, shorten: Shorten): Partial<ElementOutline>;
}

/** The decision link in every spelling bpmiq reads (`decisionRefOf` in @bpmiq/notations/extract). */
export function calledDecisionOf(node: ModdleElement): string | undefined {
  const extension = findExtension(node, "zeebe:CalledDecision");
  const value =
    node.get("camunda:decisionRef") ??
    extension?.decisionId ??
    node.$attrs?.["calledDecision"] ??
    node.$attrs?.["calledElement"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The call link in every spelling bpmiq reads (`calledElementOf` in @bpmiq/notations/extract). */
export function calledElementOf(node: ModdleElement): string | undefined {
  const value = node.calledElement ?? findExtension(node, "zeebe:CalledElement")?.processId;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Removes the decision link spellings other than `keep` (the unprefixed `calledDecision`, `camunda:decisionRef`). */
function clearDecisionLinks(node: ModdleElement, keep: string): void {
  if (keep !== "calledDecision" && node.$attrs && "calledDecision" in node.$attrs) {
    delete node.$attrs["calledDecision"];
  }
  if (keep !== "camunda:decisionRef" && node.get("camunda:decisionRef") !== undefined) {
    node.set("camunda:decisionRef", undefined);
    if (node.$attrs) {
      delete node.$attrs["camunda:decisionRef"];
    }
  }
}

/** bpmiq's existing design spelling (CLAUDE.md hard rule 5): the unprefixed attribute every bpmiq reader follows. */
function setUnprefixedDecision(node: ModdleElement, decision: string | null): string[] {
  requireKind(node, "bpmn:BusinessRuleTask", "a decision link");
  clearDecisionLinks(node, "calledDecision");
  node.$attrs ??= {};
  if (decision === null) {
    delete node.$attrs["calledDecision"];
  } else {
    node.$attrs["calledDecision"] = decision;
  }
  return [];
}

/** per parsed document: whether it links decisions unprefixed (read once, an edit batch asks per operation) */
const unprefixedDecisions = new WeakMap<BpmnDocument, boolean>();

/** Whether the document already links decisions in the unprefixed spelling: then new links follow the file. */
function usesUnprefixedDecisions(document: BpmnDocument): boolean {
  const known = unprefixedDecisions.get(document);
  if (known !== undefined) return known;
  const answer = scanUnprefixedDecisions(document);
  unprefixedDecisions.set(document, answer);
  return answer;
}

function scanUnprefixedDecisions(document: BpmnDocument): boolean {
  const tasks = (element: ModdleElement): ModdleElement[] =>
    (element.rootElements ?? element.flowElements ?? []).flatMap((child) =>
      child.$type === "bpmn:BusinessRuleTask" ? [child] : tasks(child),
    );
  return tasks(document.definitions).some((task) => task.$attrs?.["calledDecision"] !== undefined);
}

function requireKind(node: ModdleElement, type: string, what: string): void {
  if (node.$type !== type) {
    throw new BpmnEditError(`'${node.id ?? ""}' is a ${node.$type}; ${what} needs a ${type}`);
  }
}

function unsupported(platform: string, what: string): never {
  throw new BpmnEditError(
    `${what} is an implementation detail; this file is ${platform}. ` +
      "Implementation details are written only in a Camunda 7 or Camunda 8 model (ADR 0008).",
  );
}

function record(
  entries: readonly ModdleElement[] | undefined,
  pick: (entry: ModdleElement) => readonly [string | undefined, string | undefined],
  shorten: Shorten,
): Record<string, string> | undefined {
  const pairs = (entries ?? [])
    .map(pick)
    .filter((pair): pair is readonly [string, string | undefined] => pair[0] !== undefined)
    .map(([key, value]) => [key, shorten(value ?? "")] as const);
  return pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
}

const design: PlatformAdapter = {
  id: "design",
  label: "a design model (no execution platform)",
  implements: new Set(),
  created() {},
  setTemplate() {
    unsupported(this.label, "An element template");
  },
  setCalledDecision(_document, node, decision) {
    return setUnprefixedDecision(node, decision);
  },
  setCalledElement(_document, node, process) {
    requireKind(node, "bpmn:CallActivity", "a call link");
    node.calledElement = process ?? undefined;
  },
  setMapping() {
    unsupported(this.label, "A variable mapping");
  },
  setHeader() {
    unsupported(this.label, "A task header");
  },
  details() {
    return {};
  },
};

const c7: PlatformAdapter = {
  id: "c7",
  label: "a Camunda 7 model",
  implements: new Set(["setInput", "setOutput", "template"]),
  created() {},
  setTemplate(_document, node, template) {
    node.set("camunda:modelerTemplate", template.id);
    node.set("camunda:modelerTemplateVersion", template.version);
  },
  setCalledDecision(_document, node, decision) {
    requireKind(node, "bpmn:BusinessRuleTask", "a decision link");
    clearDecisionLinks(node, "camunda:decisionRef");
    node.set("camunda:decisionRef", decision ?? undefined);
    return [];
  },
  setCalledElement(_document, node, process) {
    requireKind(node, "bpmn:CallActivity", "a call link");
    node.calledElement = process ?? undefined;
  },
  setMapping(document, node, direction, target, source) {
    const io = ensureExtension(document, node, "camunda:InputOutput");
    const list = direction === "input" ? (io.inputParameters ??= []) : (io.outputParameters ??= []);
    setEntry(
      document,
      list,
      {
        type: direction === "input" ? "camunda:InputParameter" : "camunda:OutputParameter",
        keyField: "name",
        key: target,
      },
      { field: "value", value: source },
    );
  },
  setHeader() {
    unsupported(this.label, "A task header (Camunda 8 only)");
  },
  details(node, shorten) {
    const io = findExtension(node, "camunda:InputOutput");
    const byName = (entry: ModdleElement): readonly [string | undefined, string | undefined] => [
      entry.name,
      typeof entry.value === "string" ? entry.value : undefined,
    ];
    const implementation =
      node.get("camunda:class") ??
      node.get("camunda:delegateExpression") ??
      node.get("camunda:expression") ??
      (node.get("camunda:topic") === undefined ? undefined : `external: ${String(node.get("camunda:topic"))}`);
    const template = node.get("camunda:modelerTemplate");
    return {
      template:
        template === undefined
          ? undefined
          : { id: String(template), version: String(node.get("camunda:modelerTemplateVersion") ?? "") },
      taskType: implementation === undefined ? undefined : shorten(String(implementation)),
      resultVariable: node.get("camunda:resultVariable"),
      formId: node.get("camunda:formKey") ?? node.get("camunda:formRef"),
      assignment:
        node.get("camunda:assignee") ?? node.get("camunda:candidateGroups") ?? node.get("camunda:candidateUsers"),
      inputs: record(io?.inputParameters, byName, shorten),
      outputs: record(io?.outputParameters, byName, shorten),
    };
  },
};

const c8: PlatformAdapter = {
  id: "c8",
  label: "a Camunda 8 model",
  implements: new Set(["setInput", "setOutput", "setHeader", "template"]),
  created(document, node) {
    if (node.$type === "bpmn:UserTask") {
      ensureExtension(document, node, "zeebe:UserTask");
    }
  },
  setTemplate(_document, node, template) {
    node.set("zeebe:modelerTemplate", template.id);
    node.set("zeebe:modelerTemplateVersion", template.version);
  },
  setCalledDecision(document, node, decision) {
    requireKind(node, "bpmn:BusinessRuleTask", "a decision link");
    clearDecisionLinks(node, "");
    if (decision === null) {
      dropExtension(node, "zeebe:CalledDecision");
      return [];
    }
    const called = ensureExtension(document, node, "zeebe:CalledDecision");
    called.decisionId = decision;
    return called.resultVariable
      ? []
      : [`'${node.id ?? ""}' calls decision '${decision}' without a resultVariable; Camunda 8 requires one`];
  },
  setCalledElement(document, node, process) {
    requireKind(node, "bpmn:CallActivity", "a call link");
    if (process === null) {
      dropExtension(node, "zeebe:CalledElement");
      return;
    }
    const called = ensureExtension(document, node, "zeebe:CalledElement");
    called.processId = process;
    called.propagateAllChildVariables ??= false;
  },
  setMapping(document, node, direction, target, source) {
    const io = ensureExtension(document, node, "zeebe:IoMapping");
    const list = direction === "input" ? (io.inputParameters ??= []) : (io.outputParameters ??= []);
    setEntry(
      document,
      list,
      { type: direction === "input" ? "zeebe:Input" : "zeebe:Output", keyField: "target", key: target },
      { field: "source", value: source },
    );
  },
  setHeader(document, node, key, value) {
    const headers = ensureExtension(document, node, "zeebe:TaskHeaders");
    setEntry(
      document,
      (headers.values ??= []),
      { type: "zeebe:Header", keyField: "key", key },
      { field: "value", value },
    );
  },
  details(node, shorten) {
    const io = findExtension(node, "zeebe:IoMapping");
    const script = findExtension(node, "zeebe:Script");
    const form = findExtension(node, "zeebe:FormDefinition");
    const assignment = findExtension(node, "zeebe:AssignmentDefinition");
    const byTarget = (entry: ModdleElement): readonly [string | undefined, string | undefined] => [
      entry.target,
      entry.source,
    ];
    const template = node.get("zeebe:modelerTemplate");
    return {
      template:
        template === undefined
          ? undefined
          : { id: String(template), version: String(node.get("zeebe:modelerTemplateVersion") ?? "") },
      taskType: findExtension(node, "zeebe:TaskDefinition")?.type,
      script: script?.expression === undefined ? undefined : shorten(script.expression),
      resultVariable: script?.resultVariable ?? findExtension(node, "zeebe:CalledDecision")?.resultVariable,
      formId: form?.formId ?? form?.externalReference,
      assignment: assignment?.assignee ?? assignment?.candidateGroups ?? assignment?.candidateUsers,
      inputs: record(io?.inputParameters, byTarget, shorten),
      outputs: record(io?.outputParameters, byTarget, shorten),
      headers: record(findExtension(node, "zeebe:TaskHeaders")?.values, (entry) => [entry.key, entry.value], shorten),
    };
  },
};

const ADAPTERS: Readonly<Record<PlatformId, PlatformAdapter>> = { design, c7, c8 };

/**
 * The adapter of the document's platform. Links follow the file first: a file that already uses the unprefixed
 * `calledDecision` keeps using it for new links, whatever platform it names, so an edit never introduces a second
 * spelling next to the existing one.
 */
export function adapterFor(document: BpmnDocument): PlatformAdapter {
  const adapter = ADAPTERS[document.platform];
  if (adapter.id !== "design" && usesUnprefixedDecisions(document)) {
    return { ...adapter, setCalledDecision: (_document, node, decision) => setUnprefixedDecision(node, decision) };
  }
  return adapter;
}

/** An implement operation on a platform that does not support it is an error naming the platform. */
export function requireImplement(document: BpmnDocument, operation: ImplementOperation, what: string): PlatformAdapter {
  const adapter = adapterFor(document);
  if (!adapter.implements.has(operation)) {
    unsupported(adapter.label, what);
  }
  return adapter;
}
