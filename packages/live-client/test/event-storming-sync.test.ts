/**
 * Headless tests for the event storming adapter (src/event-storming-sync.ts)
 * on the shared DSL engine (src/dsl-sync.ts). Like wardley, the text lane is
 * NOT XML — the rule-4 pre-gate is "non-empty", the renderer's parser stays
 * the judge; and importDSL fires the commandStack clear-echo that must never
 * rewrite a hand-authored file on open.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { bindEventStorming } from "../src/event-storming-sync.ts";

// the DEFAULT gate would call DOMParser; this adapter must never touch it —
// a throwing stub proves it doesn't
(globalThis as Record<string, unknown>).DOMParser = class {
  parseFromString(): never {
    throw new Error("DOMParser must not be used by non-XML adapters");
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STORM =
  "title Order Checkout\ncommand Place Order [240, 300]\nevent Order Placed [620, 300]\nPlace Order -> Order Placed\n";

/** the fake reproduces the two REAL renderer traits the sync must survive:
 *  importDSL runs commandStack.clear(), which EMITS commandStack.changed
 *  (unlike bpmn-js), and exportDSL NORMALIZES (the serializer re-orders a
 *  hand-authored file: config first, elements, then arrows) */
function makeFakeModeler(initial: string) {
  let dsl = initial;
  const handlers: Record<string, Array<() => void>> = {};
  const imports: string[] = [];
  const normalize = (text: string): string => text.split("\n").filter(Boolean).sort().join("\n") + "\n";
  return {
    imports,
    setDsl: (d: string) => {
      dsl = d;
    },
    fire: (ev: string) => handlers[ev]?.forEach((h) => h()),
    get: () => ({ viewbox: () => ({ x: 0, y: 0, width: 100, height: 100 }), zoom: () => undefined }),
    on: (ev: string, cb: () => void) => {
      (handlers[ev] ??= []).push(cb);
    },
    off: () => undefined,
    importDSL: async (text: string) => {
      imports.push(text);
      dsl = text;
      handlers["commandStack.changed"]?.forEach((h) => h()); // the clear echo
      return { warnings: [] };
    },
    exportDSL: () => normalize(dsl),
  };
}

test("event-storming: .storm text imports (non-XML!), board edits round-trip through commandStack.changed", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, STORM);
  const modeler = makeFakeModeler(STORM);
  const unbind = bindEventStorming(modeler as never, ytext, doc);
  await wait(700);
  assert.deepEqual(modeler.imports, [STORM], "the initial import ran despite the text not being XML");
  // THE echo-suppression pin: importDSL fired commandStack.changed, and the
  // exportDSL normalization differs from the hand-authored text — without
  // suppression the open alone would rewrite the shared document
  assert.equal(ytext.toString(), STORM, "opening a hand-authored board must not rewrite it");

  // a canvas edit (a new sticky) exports through commandStack.changed
  modeler.setDsl(`${STORM}actor Customer [80, 300]\n`);
  modeler.fire("commandStack.changed");
  await wait(100);
  assert.match(ytext.toString(), /actor Customer/);
  unbind();
});

test("event-storming: emptied text keeps the last good board (lenient DSL, non-empty gate)", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, STORM);
  const modeler = makeFakeModeler(STORM);
  const unbind = bindEventStorming(modeler as never, ytext, doc);
  await wait(700);
  ytext.delete(0, ytext.length); // a co-editor wipes the text mid-edit
  await wait(700);
  assert.equal(modeler.imports.length, 1, "no re-import of an empty document — last good state kept");
  unbind();
});
