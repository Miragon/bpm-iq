/**
 * The STRUCTURED live-doc lane (epic #118 step 8) — plain-snapshot helpers
 * over the element-wise CRDT shape (@bpmiq/contracts/live: ELEMENTS_KEY =
 * Y.Map<elementId, Y.Map<attr, value>>, META_KEY = flat Y.Map).
 *
 * readSnapshot / applySnapshot are the codec bridge (seed + write-through);
 * reconcileSnapshot is the write path for whole-document callers (REST/MCP
 * agents, text-tab saves): it applies ONLY the differing elements and
 * attributes, so a co-editor's concurrent edit on a DIFFERENT element — or a
 * different attribute of the same element — survives untouched.
 *
 * The snapshot shape mirrors @bpmiq/notations/codecs StructuredSnapshot
 * structurally (this package deliberately has no notations dependency).
 */
import { ELEMENTS_KEY, META_KEY } from "@bpmiq/contracts/live";
import * as Y from "yjs";

export interface StructuredSnapshot {
  elements: Record<string, Record<string, unknown>>;
  meta: Record<string, unknown>;
}

const elementsOf = (doc: Y.Doc): Y.Map<Y.Map<unknown>> => doc.getMap(ELEMENTS_KEY);
const metaOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(META_KEY);

/** the current structured content as plain data */
export function readSnapshot(doc: Y.Doc): StructuredSnapshot {
  // null-prototype containers: an element id like "__proto__" must land as an
  // OWN key, never as a prototype assignment
  const elements: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  elementsOf(doc).forEach((attrs, id) => {
    elements[id] = attrs instanceof Y.Map ? (attrs.toJSON() as Record<string, unknown>) : {};
  });
  // spread-copy back to a normal prototype (spread defines own keys, incl. a
  // literal "__proto__", without invoking setters)
  return { elements: { ...elements }, meta: metaOf(doc).toJSON() };
}

/** stable deep equality for attribute values (canonical-JSON compare) */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Element- and attribute-wise write: bring the doc to `next`, touching ONLY
 * what differs. One transaction (optionally origin-tagged); safe for seeding
 * an empty doc AND for whole-board saves against a live one.
 */
export function reconcileSnapshot(doc: Y.Doc, next: StructuredSnapshot, origin?: unknown): void {
  doc.transact(() => {
    const elements = elementsOf(doc);
    // removed elements — Object.hasOwn, NOT `in`: an element id named after an
    // Object.prototype member (toString, constructor, …) must stay deletable
    for (const id of [...elements.keys()]) {
      if (!Object.hasOwn(next.elements, id)) elements.delete(id);
    }
    // added/changed elements — attribute-wise so concurrent edits on OTHER
    // attributes of the same element merge instead of being replaced
    for (const [id, attrs] of Object.entries(next.elements)) {
      let target = elements.get(id);
      if (!(target instanceof Y.Map)) {
        target = new Y.Map();
        elements.set(id, target);
      }
      for (const key of [...target.keys()]) {
        if (!Object.hasOwn(attrs, key)) target.delete(key);
      }
      for (const [key, value] of Object.entries(attrs)) {
        if (!target.has(key) || !sameValue(target.get(key), value)) target.set(key, value);
      }
    }
    // meta, flat
    const meta = metaOf(doc);
    for (const key of [...meta.keys()]) {
      if (!Object.hasOwn(next.meta, key)) meta.delete(key);
    }
    for (const [key, value] of Object.entries(next.meta)) {
      if (!meta.has(key) || !sameValue(meta.get(key), value)) meta.set(key, value);
    }
  }, origin);
}
