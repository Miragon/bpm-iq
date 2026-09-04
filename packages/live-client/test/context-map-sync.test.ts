/**
 * Headless tests for the context-map adapter (src/context-map-sync.ts) on
 * the shared document engine (src/document-sync.ts). Like team topology, the
 * text lane is JSON through an injected codec: the codec's parse gates
 * imports (broken JSON keeps the last good canvas), the renderer's
 * importDocument leaves undo history on stale shapes (the adapter erases it
 * silently), and a canvas edit serializes through the codec into ytext.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { bindContextMap } from "../src/context-map-sync.ts";

// the DEFAULT gate would call DOMParser; this adapter must never touch it —
// a throwing stub proves it doesn't
(globalThis as Record<string, unknown>).DOMParser = class {
  parseFromString(): never {
    throw new Error("DOMParser must not be used by non-XML adapters");
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CM_DOC = JSON.stringify({ version: 1, title: "Planner", contexts: [], relationships: [] });

function makeFakeModeler() {
  const handlers: Record<string, Array<() => void>> = {};
  const imports: unknown[] = [];
  const cleared: boolean[] = [];
  let current: unknown = JSON.parse(CM_DOC);
  return {
    imports,
    cleared,
    setDocument: (d: unknown) => {
      current = d;
    },
    fire: (ev: string) => handlers[ev]?.forEach((h) => h()),
    get: (service: string) =>
      service === "commandStack"
        ? { clear: (emit?: boolean) => void cleared.push(emit ?? true) }
        : { viewbox: () => ({ x: 0, y: 0, width: 100, height: 100 }), zoom: () => undefined },
    on: (ev: string, cb: () => void) => {
      (handlers[ev] ??= []).push(cb);
    },
    off: () => undefined,
    importDocument: (d: unknown) => {
      imports.push(d);
      current = d;
      return { warnings: [] };
    },
    exportDocument: () => current,
  };
}

/** the codec the web engine injects, stubbed: strict JSON + a version gate */
const codec = {
  parse: (text: string) => {
    try {
      const document = JSON.parse(text) as { version?: number };
      return document.version === 1 ? { ok: true as const, document } : { ok: false as const, error: "version" };
    } catch (e) {
      return { ok: false as const, error: e };
    }
  },
  serialize: (document: unknown) => JSON.stringify(document),
};

test("context-map: the injected codec gates imports — parsed documents in, broken JSON keeps last good", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, CM_DOC);
  const modeler = makeFakeModeler();
  const unbind = bindContextMap(modeler as never, codec, ytext, doc);
  await wait(700);
  assert.equal(modeler.imports.length, 1, "the initial import ran despite the text not being XML");
  assert.equal((modeler.imports[0] as { title: string }).title, "Planner", "the PARSED document reaches the modeler");
  // the renderer's importDocument leaves undo history on stale shapes — the
  // adapter must erase it, SILENTLY (no 'changed' echo)
  assert.deepEqual(modeler.cleared, [false], "commandStack.clear(false) after the import");
  assert.equal(ytext.toString(), CM_DOC, "opening a document must not rewrite it");

  // a co-editor's half-typed JSON must not reach the canvas
  ytext.insert(ytext.length, "{ broken");
  await wait(700);
  assert.equal(modeler.imports.length, 1, "invalid text keeps the last good canvas");

  // healing the text imports again
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, JSON.stringify({ version: 1, title: "Planner v2", contexts: [], relationships: [] }));
  });
  await wait(700);
  assert.equal(modeler.imports.length, 2);
  unbind();
});

test("context-map: a canvas edit serializes through the codec into ytext (commandStack.changed)", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, CM_DOC);
  const modeler = makeFakeModeler();
  const unbind = bindContextMap(modeler as never, codec, ytext, doc);
  await wait(700);
  modeler.setDocument({
    version: 1,
    title: "Planner",
    contexts: [
      {
        id: "ctx_cfp",
        label: "CfP Management",
        subdomainType: "core",
        position: { x: 340, y: 120 },
        size: { width: 200, height: 110 },
      },
    ],
    relationships: [],
  });
  modeler.fire("commandStack.changed");
  await wait(100);
  assert.match(ytext.toString(), /CfP Management/);
  unbind();
});
