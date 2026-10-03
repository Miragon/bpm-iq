/**
 * Extension elements below <bpmn:extensionElements>. Typed ones (a loaded descriptor) carry the type name
 * (`zeebe:CalledDecision`), untyped ones the tag (`zeebe:calledDecision`), so reads match both.
 */
import type { ModdleElement } from "bpmn-moddle";

import type { BpmnDocument } from "../model/document.ts";

function sameType(value: ModdleElement, type: string): boolean {
  return value.$type.toLowerCase() === type.toLowerCase();
}

export function findExtension(owner: ModdleElement, type: string): ModdleElement | undefined {
  return owner.extensionElements?.values?.find((value) => sameType(value, type));
}

/** The extension of the given type, created when missing. */
export function ensureExtension(document: BpmnDocument, owner: ModdleElement, type: string): ModdleElement {
  const { moddle } = document;
  owner.extensionElements ??= moddle.create("bpmn:ExtensionElements", { values: [] });
  owner.extensionElements.$parent = owner;
  const values = (owner.extensionElements.values ??= []);
  let found = values.find((value) => sameType(value, type));
  if (!found) {
    found = moddle.create(type);
    found.$parent = owner.extensionElements;
    values.push(found);
  }
  return found;
}

/** Removes the extension of the given type, and <bpmn:extensionElements> when it is empty then. */
export function dropExtension(owner: ModdleElement, type: string): void {
  const values = owner.extensionElements?.values;
  if (!values) {
    return;
  }
  const index = values.findIndex((value) => sameType(value, type));
  if (index !== -1) {
    values.splice(index, 1);
  }
  if (values.length === 0) {
    owner.extensionElements = undefined;
  }
}

/** Sets (or with null removes) one entry of a list identified by `keyField`. */
export function setEntry(
  document: BpmnDocument,
  list: ModdleElement[],
  entry: { readonly type: string; readonly keyField: "target" | "key" | "name"; readonly key: string },
  change: { readonly field: "source" | "value"; readonly value: string | null },
): void {
  const existing = list.find((item) => item[entry.keyField] === entry.key);
  if (change.value === null) {
    if (existing) {
      list.splice(list.indexOf(existing), 1);
    }
    return;
  }
  const target = existing ?? document.moddle.create(entry.type, { [entry.keyField]: entry.key });
  target[change.field] = change.value;
  if (!existing) {
    list.push(target);
  }
}
