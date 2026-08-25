/**
 * Headless tests for the two external-renderer adapters (src/wardley-sync.ts,
 * src/tt-sync.ts). The critical difference to bpmn/dmn: their text lanes are
 * NOT XML — the adapters override the rule-4 pre-gate (looksRenderable), so
 * OWM DSL and TT JSON import at all, and invalid text keeps the last good
 * canvas exactly like an invalid XML interleaving does for bpmn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { bindTeamTopology } from "../src/tt-sync.ts";
import { bindWardley } from "../src/wardley-sync.ts";

// the DEFAULT gate would call DOMParser; these adapters must never touch it —
// a throwing stub proves they don't
(globalThis as Record<string, unknown>).DOMParser = class {
  parseFromString(): never {
    throw new Error("DOMParser must not be used by non-XML adapters");
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OWM = "component Tea [0.5, 0.5]\ncomponent Cup [0.7, 0.8]\nTea -> Cup\n";

/** the fake reproduces the two REAL renderer traits the sync must survive:
 *  importDSL fires commandStack.changed (importMap's commandStack.clear()
 *  emits, unlike bpmn-js), and exportDSL NORMALIZES (the serializer reorders
 *  hand-authored files — not a byte fixpoint) */
function makeFakeWardley(initial: string) {
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

test("wardley: OWM text imports (non-XML!), edits round-trip through both change events", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, OWM);
  const modeler = makeFakeWardley(OWM);
  const unbind = bindWardley(modeler as never, ytext, doc);
  await wait(700);
  assert.deepEqual(modeler.imports, [OWM], "the initial import ran despite the text not being XML");
  // THE echo-suppression pin: importDSL fired commandStack.changed, and the
  // exportDSL normalization differs from the hand-authored text — without
  // suppression the open alone would rewrite the shared document
  assert.equal(ytext.toString(), OWM, "opening a hand-authored file must not rewrite it");

  // a canvas edit exports through commandStack.changed
  modeler.setDsl(`${OWM}component Water [0.3, 0.9]\n`);
  modeler.fire("commandStack.changed");
  await wait(100);
  assert.match(ytext.toString(), /Water/);

  // a config edit (axis labels) fires wardley.config.changed, NOT commandStack
  modeler.setDsl(ytext.toString().replace("Tea ->", "Tee ->"));
  modeler.fire("wardley.config.changed");
  await wait(100);
  assert.match(ytext.toString(), /Tee ->/);
  unbind();
});

test("wardley: emptied text keeps the last good canvas (lenient DSL, non-empty gate)", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, OWM);
  const modeler = makeFakeWardley(OWM);
  const unbind = bindWardley(modeler as never, ytext, doc);
  await wait(700);
  ytext.delete(0, ytext.length); // a co-editor wipes the text mid-edit
  await wait(700);
  assert.equal(modeler.imports.length, 1, "no re-import of an empty document — last good state kept");
  unbind();
});

const TT_DOC = JSON.stringify({ version: 2, title: "T", nodes: [], interactions: [], flows: [] });

function makeFakeTt() {
  const handlers: Record<string, Array<() => void>> = {};
  const imports: unknown[] = [];
  const cleared: boolean[] = [];
  let current: unknown = { version: 2, title: "T", nodes: [], interactions: [], flows: [] };
  return {
    imports,
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
    cleared,
  };
}

/** the codec the web engine injects, stubbed: strict JSON + a version gate */
const codec = {
  parse: (text: string) => {
    try {
      const document = JSON.parse(text) as { version?: number };
      return document.version === 2 ? { ok: true as const, document } : { ok: false as const, error: "version" };
    } catch (e) {
      return { ok: false as const, error: e };
    }
  },
  serialize: (document: unknown) => JSON.stringify(document),
};

test("team-topology: the injected codec gates imports — parsed documents in, broken JSON keeps last good", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, TT_DOC);
  const modeler = makeFakeTt();
  const unbind = bindTeamTopology(modeler as never, codec, ytext, doc);
  await wait(700);
  assert.equal(modeler.imports.length, 1);
  assert.deepEqual((modeler.imports[0] as { version: number }).version, 2, "the PARSED document reaches the modeler");
  // the renderer's importDocument leaves undo history on stale shapes — the
  // adapter must erase it, SILENTLY (no 'changed' echo)
  assert.deepEqual(modeler.cleared, [false], "commandStack.clear(false) after the import");

  // a co-editor's half-typed JSON must not reach the canvas
  ytext.insert(ytext.length, "{ broken");
  await wait(700);
  assert.equal(modeler.imports.length, 1, "invalid text keeps the last good canvas");

  // healing the text imports again
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, JSON.stringify({ version: 2, title: "T2", nodes: [], interactions: [], flows: [] }));
  });
  await wait(700);
  assert.equal(modeler.imports.length, 2);
  unbind();

  // a canvas edit serializes through the codec into ytext
  const doc2 = new Y.Doc();
  const ytext2 = doc2.getText("content");
  ytext2.insert(0, TT_DOC);
  const m2 = makeFakeTt();
  const unbind2 = bindTeamTopology(m2 as never, codec, ytext2, doc2);
  await wait(700);
  m2.setDocument({ version: 2, title: "Renamed", nodes: [], interactions: [], flows: [] });
  m2.fire("commandStack.changed");
  await wait(100);
  assert.match(ytext2.toString(), /Renamed/);
  unbind2();
});
