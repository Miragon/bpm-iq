/**
 * Headless tests for the Miragon-renderer adapter (src/miragon-sync.ts), one
 * per text lane. The critical difference to bpmn/dmn: the text lanes are NOT
 * XML — the adapter overrides the rule-4 pre-gate (looksRenderable), so OWM /
 * .storm DSL and TT / CM JSON import at all, and invalid text keeps the last
 * good canvas exactly like an invalid XML interleaving does for bpmn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { bindMiragon, type MiragonLane } from "../src/miragon-sync.ts";

// the DEFAULT gate would call DOMParser; this adapter must never touch it —
// a throwing stub proves it doesn't
(globalThis as Record<string, unknown>).DOMParser = class {
  parseFromString(): never {
    throw new Error("DOMParser must not be used by non-XML adapters");
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the DSL lane (wardley OWM, event storming .storm) ────────────────────────

const OWM = "component Tea [0.5, 0.5]\ncomponent Cup [0.7, 0.8]\nTea -> Cup\n";
const STORM =
  "title Order Checkout\ncommand Place Order [240, 300]\nevent Order Placed [620, 300]\nPlace Order -> Order Placed\n";

/** the fake reproduces the two REAL renderer traits the sync must survive:
 *  importDSL fires commandStack.changed (importMap's commandStack.clear()
 *  emits, unlike bpmn-js), and exportDSL NORMALIZES (the serializer reorders
 *  hand-authored files — not a byte fixpoint) */
function makeFakeDslModeler(initial: string) {
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

const WARDLEY: MiragonLane = { kind: "dsl", changeEvents: ["commandStack.changed", "wardley.config.changed"] };
const EVENT_STORMING: MiragonLane = { kind: "dsl", changeEvents: ["commandStack.changed"] };

test("dsl lane: OWM text imports (non-XML!), edits round-trip through every configured change event", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, OWM);
  const modeler = makeFakeDslModeler(OWM);
  const unbind = bindMiragon(modeler, WARDLEY, ytext, doc);
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

test("dsl lane: only the configured events count — a .storm board re-exports on commandStack.changed alone", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, STORM);
  const modeler = makeFakeDslModeler(STORM);
  const unbind = bindMiragon(modeler, EVENT_STORMING, ytext, doc);
  await wait(700);
  assert.deepEqual(modeler.imports, [STORM]);
  assert.equal(ytext.toString(), STORM, "opening a hand-authored board must not rewrite it");

  modeler.setDsl(`${STORM}actor Customer [80, 300]\n`);
  modeler.fire("wardley.config.changed"); // not one of this lane's events
  await wait(100);
  assert.doesNotMatch(ytext.toString(), /actor Customer/, "an unconfigured event never exports");
  modeler.fire("commandStack.changed");
  await wait(100);
  assert.match(ytext.toString(), /actor Customer/);
  unbind();
});

test("dsl lane: emptied text keeps the last good canvas (lenient DSL, non-empty gate)", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, OWM);
  const modeler = makeFakeDslModeler(OWM);
  const unbind = bindMiragon(modeler, WARDLEY, ytext, doc);
  await wait(700);
  ytext.delete(0, ytext.length); // a co-editor wipes the text mid-edit
  await wait(700);
  assert.equal(modeler.imports.length, 1, "no re-import of an empty document — last good state kept");
  unbind();
});

// ── the document lane (team topology .tt, context map .cm.json) ─────────────

const TT_DOC = JSON.stringify({ version: 2, title: "T", nodes: [], interactions: [], flows: [] });

function makeFakeDocumentModeler(initial: string) {
  const handlers: Record<string, Array<() => void>> = {};
  const imports: unknown[] = [];
  const cleared: boolean[] = [];
  let current: unknown = JSON.parse(initial);
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
      return document.version === 2 ? { ok: true as const, document } : { ok: false as const, error: "version" };
    } catch (e) {
      return { ok: false as const, error: e };
    }
  },
  serialize: (document: unknown) => JSON.stringify(document),
};
const TEAM_TOPOLOGY: MiragonLane = { kind: "document", notation: "team-topology", codec };

test("document lane: the injected codec gates imports — parsed documents in, broken JSON keeps last good", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, TT_DOC);
  const modeler = makeFakeDocumentModeler(TT_DOC);
  const unbind = bindMiragon(modeler as never, TEAM_TOPOLOGY, ytext, doc);
  await wait(700);
  assert.equal(modeler.imports.length, 1, "the initial import ran despite the text not being XML");
  assert.equal((modeler.imports[0] as { version: number }).version, 2, "the PARSED document reaches the modeler");
  // the renderer's importDocument leaves undo history on stale shapes — the
  // adapter must erase it, SILENTLY (no 'changed' echo)
  assert.deepEqual(modeler.cleared, [false], "commandStack.clear(false) after the import");
  assert.equal(ytext.toString(), TT_DOC, "opening a document must not rewrite it");

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
});

test("document lane: a canvas edit serializes through the codec into ytext (commandStack.changed)", async () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, TT_DOC);
  const modeler = makeFakeDocumentModeler(TT_DOC);
  const unbind = bindMiragon(modeler as never, TEAM_TOPOLOGY, ytext, doc);
  await wait(700);
  modeler.setDocument({ version: 2, title: "Renamed", nodes: [], interactions: [], flows: [] });
  modeler.fire("commandStack.changed");
  await wait(100);
  assert.match(ytext.toString(), /Renamed/);
  unbind();
});

test("a lane/renderer mismatch fails at bind time with a readable message", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  assert.throws(
    () => bindMiragon(makeFakeDocumentModeler(TT_DOC) as never, WARDLEY, ytext, doc),
    /lane 'dsl' needs a renderer with importDSL/,
  );
  assert.throws(
    () => bindMiragon(makeFakeDslModeler(OWM) as never, TEAM_TOPOLOGY, ytext, doc),
    /lane 'document' needs a renderer with importDocument/,
  );
});
