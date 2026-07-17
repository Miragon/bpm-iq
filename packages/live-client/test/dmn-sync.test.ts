/**
 * Headless tests for the dmn adapter (src/dmn-sync.ts) on the shared sync
 * engine. What is dmn-specific and therefore tested here:
 *
 *  - command stacks are PER VIEWER: an edit fired from a viewer that dmn-js
 *    created only after binding (view switch to a decision table) must sync
 *  - re-imports restore the DRD viewbox but leave table views alone
 *  - a document that is malformed from the start reports the import error
 *    exactly once and heals when valid content arrives
 *
 * The merge/conflict discipline itself is engine behavior, covered by
 * sync-merge.test.ts through the bpmn adapter.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { bindDmn } from "../src/dmn-sync.ts";

// importFromY's validity gate uses DOMParser; the stub flags a marker string
// as non-well-formed so the gate itself is testable
(globalThis as Record<string, unknown>).DOMParser = class {
  parseFromString(s: string) {
    return {
      getElementsByTagName: (tag: string) => (tag === "parsererror" && s.includes("NOTWELLFORMED") ? [{}] : []),
    };
  }
};

const BASE = `<definitions><decision id="A" name="Alpha"/><decision id="B" name="Beta"/></definitions>`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeFakeViewer() {
  const handlers: Record<string, Array<() => void>> = {};
  const canvasCalls: string[] = [];
  return {
    canvasCalls,
    fire: (ev: string) => handlers[ev]?.forEach((h) => h()),
    listenerCount: (ev: string) => handlers[ev]?.length ?? 0,
    get: (service: string) =>
      service === "canvas"
        ? {
            viewbox: (vb?: unknown) => {
              if (vb) canvasCalls.push("viewbox:set");
              return { x: 0, y: 0, width: 100, height: 100 };
            },
            zoom: () => {
              canvasCalls.push("zoom:fit");
            },
          }
        : undefined,
    on: (ev: string, cb: () => void) => {
      (handlers[ev] ??= []).push(cb);
    },
    off: (ev: string, cb: () => void) => {
      handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== cb);
    },
  };
}
type FakeViewer = ReturnType<typeof makeFakeViewer>;

function makeFakeDmnModeler(initial: string, opts: { rejectWhen?: (xml: string) => boolean } = {}) {
  let xml = initial;
  const importCalls: string[] = [];
  const managerHandlers: Record<string, Array<(event: never) => void>> = {};
  const viewers: Record<string, FakeViewer> = {};
  let activeType: string | null = null;
  const emit = (ev: string, payload: unknown) => managerHandlers[ev]?.forEach((h) => h(payload as never));
  const openView = (type: string) => {
    if (!viewers[type]) {
      viewers[type] = makeFakeViewer();
      emit("viewer.created", { viewer: viewers[type] });
    }
    activeType = type;
    emit("views.changed", {});
  };
  return {
    xml: () => xml,
    setXml: (x: string) => {
      xml = x;
    },
    openView,
    // tests only ask for viewers they opened before
    viewer: (type: string) => viewers[type] as FakeViewer,
    getActiveView: () => (activeType ? { type: activeType } : null),
    getActiveViewer: () => (activeType ? viewers[activeType] : null),
    getViews: () => ["drd", "decisionTable"].map((type) => ({ type })),
    open: async (view: { type: string }) => {
      openView(view.type);
    },
    on: (ev: string, cb: (event: never) => void) => {
      (managerHandlers[ev] ??= []).push(cb);
    },
    off: (ev: string, cb: (event: never) => void) => {
      managerHandlers[ev] = (managerHandlers[ev] ?? []).filter((h) => h !== cb);
    },
    importCalls,
    // like dmn-js: clears the stage BEFORE parsing, then re-opens the
    // previously active view (or the DRD initially) on success
    importXML: async (x: string) => {
      importCalls.push(x);
      const previousActive = activeType;
      activeType = null;
      if (opts.rejectWhen?.(x)) throw new Error("unparsable DMN");
      xml = x;
      openView(previousActive ?? "drd");
    },
    saveXML: async () => ({ xml }),
  };
}

function setup(initial = BASE, opts: Parameters<typeof makeFakeDmnModeler>[1] = {}) {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, initial);
  const modeler = makeFakeDmnModeler(initial, opts);
  return { doc, ytext, modeler };
}

test("edits from a viewer created after binding (view switch) sync as minimal diffs", async () => {
  const { doc, ytext, modeler } = setup();
  const unbind = bindDmn(modeler as never, ytext, doc);
  await wait(100); // initial import opens the DRD

  // user switches to a decision table — dmn-js creates that viewer only now
  modeler.openView("decisionTable");
  const deltas: Array<Array<Record<string, unknown>>> = [];
  ytext.observe((e) => deltas.push(e.changes.delta as never));

  modeler.setXml(BASE.replace('name="Beta"', 'name="Beta-CELL"'));
  modeler.viewer("decisionTable").fire("commandStack.changed");
  await wait(100);

  assert.ok(ytext.toString().includes("Beta-CELL"), "table edit must land in the shared text");
  // minimal diff, not replace-all: the write keeps the unchanged prefix
  assert.ok(deltas.length > 0, "edit must write to ytext");
  assert.ok(
    deltas.every((d) => typeof d[0]?.retain === "number" && (d[0].retain as number) > 0),
    `writes must retain the common prefix, got ${JSON.stringify(deltas)}`,
  );

  // and edits from the re-activated DRD keep working
  modeler.openView("drd");
  modeler.setXml(modeler.xml().replace('name="Alpha"', 'name="Alpha-DRD"'));
  modeler.viewer("drd").fire("commandStack.changed");
  await wait(100);
  assert.ok(ytext.toString().includes("Alpha-DRD"));
  unbind();
});

test("a viewer active BEFORE binding syncs from the moment of binding", async () => {
  const { doc, ytext, modeler } = setup();
  modeler.openView("decisionTable"); // exists before bindDmn
  const unbind = bindDmn(modeler as never, ytext, doc);
  await wait(100);

  modeler.setXml(BASE.replace('name="Alpha"', 'name="Alpha-EARLY"'));
  modeler.viewer("decisionTable").fire("commandStack.changed");
  await wait(100);
  assert.ok(ytext.toString().includes("Alpha-EARLY"));

  // exactly ONE subscription despite viewer.created/views.changed both firing later
  assert.equal(modeler.viewer("decisionTable").listenerCount("commandStack.changed"), 1);
  unbind();
});

test("a viewer created before binding but INACTIVE at bind time is picked up via views.changed", async () => {
  const { doc, ytext, modeler } = setup();
  modeler.openView("decisionTable"); // viewer.created fired before the binding listens
  modeler.openView("drd"); // ...and the table viewer is not active at bind time
  const unbind = bindDmn(modeler as never, ytext, doc);
  await wait(100);

  modeler.openView("decisionTable"); // re-activation → views.changed → subscribe
  modeler.setXml(BASE.replace('name="Beta"', 'name="Beta-LATE"'));
  modeler.viewer("decisionTable").fire("commandStack.changed");
  await wait(100);
  assert.ok(ytext.toString().includes("Beta-LATE"), "edits from a pre-existing viewer must sync");
  assert.equal(modeler.viewer("decisionTable").listenerCount("commandStack.changed"), 1);
  unbind();
});

test("remote change re-imports; DRD restores the viewbox, table views are left alone", async () => {
  const { doc, ytext, modeler } = setup();
  const unbind = bindDmn(modeler as never, ytext, doc);
  await wait(100);
  const drd = modeler.viewer("drd");
  assert.deepEqual(drd.canvasCalls, ["zoom:fit"], "first import fits the viewport");

  const remote = BASE.replace('name="Beta"', 'name="Beta-REMOTE"');
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, remote);
  }, "remote-user");
  await wait(500); // debounced import
  assert.equal(modeler.xml(), remote);
  assert.deepEqual(drd.canvasCalls, ["zoom:fit", "viewbox:set"], "re-import restores the viewbox");

  // active table view: a further remote re-import must not touch any canvas
  modeler.openView("decisionTable");
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, remote.replace("Beta-REMOTE", "Beta-REMOTE-2"));
  }, "remote-user");
  await wait(500);
  assert.ok(modeler.xml().includes("Beta-REMOTE-2"));
  assert.deepEqual(drd.canvasCalls, ["zoom:fit", "viewbox:set"], "no canvas calls while a table is active");
  unbind();
});

test("unbind detaches from every viewer", async () => {
  const { doc, ytext, modeler } = setup();
  const unbind = bindDmn(modeler as never, ytext, doc);
  await wait(100);
  modeler.openView("decisionTable");
  unbind();
  assert.equal(modeler.viewer("drd").listenerCount("commandStack.changed"), 0);
  assert.equal(modeler.viewer("decisionTable").listenerCount("commandStack.changed"), 0);

  modeler.setXml(BASE.replace('name="Alpha"', 'name="Alpha-AFTER"'));
  modeler.viewer("decisionTable").fire("commandStack.changed");
  await wait(100);
  assert.ok(!ytext.toString().includes("Alpha-AFTER"), "no export after unbind");
});

test("failed re-import restores the last good render AND the user's view (dmn-js clears before parsing)", async () => {
  const errors: string[] = [];
  const { doc, ytext, modeler } = setup(BASE, { rejectWhen: (x) => x.includes("BROKEN") });
  const unbind = bindDmn(modeler as never, ytext, doc, undefined, (msg) => errors.push(msg));
  await wait(100); // initial import succeeds
  modeler.openView("decisionTable"); // the user is editing a table

  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, "<definitions>BROKEN</definitions>");
  }, "remote-user");
  await wait(500);
  assert.deepEqual(modeler.importCalls.at(-1), BASE, "adapter re-imports the last good XML");
  assert.equal(modeler.xml(), BASE, "visual editor keeps rendering the last good state");
  assert.equal(
    modeler.getActiveView()?.type,
    "decisionTable",
    "the failing import nulled the active view — the recovery must re-open the user's view",
  );
  assert.equal(errors.length, 0, "mid-session interleavings are not surfaced as import errors");

  // the document heals — the merged state imports normally again
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, BASE.replace('name="Beta"', 'name="Beta-HEALED"'));
  }, "remote-user");
  await wait(500);
  assert.ok(modeler.xml().includes("Beta-HEALED"));
  assert.equal(modeler.getActiveView()?.type, "decisionTable", "the healed import keeps the restored view");
  unbind();
});

test("a document that is empty from the start reports the import error once", async () => {
  const errors: string[] = [];
  const { doc, ytext, modeler } = setup("");
  const unbind = bindDmn(modeler as never, ytext, doc, undefined, (msg) => errors.push(msg));
  await wait(100);
  assert.equal(errors.length, 1, "empty document surfaces exactly once");
  assert.equal(modeler.importCalls.length, 0, "nothing is imported");

  // content arrives (e.g. typed in the XML view) — the visual editor mounts
  doc.transact(() => {
    ytext.insert(0, BASE);
  }, "remote-user");
  await wait(500);
  assert.equal(modeler.xml(), BASE);
  assert.equal(errors.length, 1);
  unbind();
});

test("a non-well-formed document reports the import error once without an import attempt", async () => {
  const errors: string[] = [];
  const { doc, ytext, modeler } = setup("<definitions NOTWELLFORMED");
  const unbind = bindDmn(modeler as never, ytext, doc, undefined, (msg) => errors.push(msg));
  await wait(100);
  assert.equal(errors.length, 1, "well-formedness gate failure surfaces exactly once");
  assert.equal(modeler.importCalls.length, 0, "the import is never attempted");

  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, BASE);
  }, "remote-user");
  await wait(500);
  assert.equal(modeler.xml(), BASE, "heals once well-formed content arrives");
  assert.equal(errors.length, 1);
  unbind();
});

test("malformed document: import error reported once, heals when valid content arrives", async () => {
  const BROKEN = "<definitions>BROKEN</definitions>";
  const errors: string[] = [];
  const { doc, ytext, modeler } = setup(BROKEN, { rejectWhen: (x) => x.includes("BROKEN") });
  const unbind = bindDmn(modeler as never, ytext, doc, undefined, (msg) => errors.push(msg));
  await wait(100);
  assert.equal(errors.length, 1, "first-import failure surfaces exactly once");
  assert.equal(modeler.getActiveView(), null, "nothing rendered");

  // a second failing update stays quiet (still no last good state, already reported)
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, BROKEN + "<!-- still broken -->");
  }, "remote-user");
  await wait(500);
  assert.equal(errors.length, 1);

  // the fix arrives (e.g. via the Monaco XML view) — the visual editor heals
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, BASE);
  }, "remote-user");
  await wait(500);
  assert.equal(modeler.xml(), BASE);
  assert.equal(modeler.getActiveView()?.type, "drd");
  assert.equal(errors.length, 1);
  unbind();
});
