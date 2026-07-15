/**
 * Headless tests for the merge-aware canvas export (src/bpmn-sync.ts).
 *
 * The scenario that used to lose data: user B's remote edit lands in ytext,
 * user A makes a canvas edit before the debounced import ran — the old code
 * diffed A's full export against the merged ytext and DELETED B's edit as
 * "the differing middle". Disjoint edits must merge; true overlaps must keep
 * the remote edit and surface a conflict.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { bindBpmn } from "../src/bpmn-sync.ts";

// importFromY's validity gate uses DOMParser; a permissive stub is enough here
(globalThis as Record<string, unknown>).DOMParser = class {
  parseFromString() {
    return { getElementsByTagName: () => [] };
  }
};

const BASE = `<definitions><task id="A" name="Alpha"/><task id="B" name="Beta"/><task id="C" name="Gamma"/></definitions>`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeFakeModeler(initial: string) {
  let xml = initial;
  const handlers: Record<string, Array<() => void>> = {};
  return {
    xml: () => xml,
    setXml: (x: string) => {
      xml = x;
    },
    fire: (ev: string) => handlers[ev]?.forEach((h) => h()),
    get: () => ({ viewbox: () => ({ x: 0, y: 0, width: 100, height: 100 }), zoom: () => undefined }),
    on: (ev: string, cb: () => void) => {
      (handlers[ev] ??= []).push(cb);
    },
    off: () => undefined,
    importXML: async (x: string) => {
      xml = x;
    },
    saveXML: async () => ({ xml }),
  };
}

function setup(onConflict?: (m: string) => void) {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, BASE);
  const modeler = makeFakeModeler(BASE);
  const unbind = bindBpmn(modeler as never, ytext, doc, onConflict);
  return { doc, ytext, modeler, unbind };
}

test("disjoint concurrent edits merge — nobody's change is lost", async () => {
  const { doc, ytext, modeler, unbind } = setup();
  await wait(700); // initial import settles

  const remote = BASE.replace('name="Beta"', 'name="Beta-REMOTE"');
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, remote);
  }, "remote-user");

  modeler.setXml(BASE.replace('name="Alpha"', 'name="Alpha-LOCAL"'));
  modeler.fire("commandStack.changed");
  await wait(100);

  const merged = ytext.toString();
  assert.ok(merged.includes("Beta-REMOTE"), "remote edit must survive the local export");
  assert.ok(merged.includes("Alpha-LOCAL"), "local edit must be applied");

  await wait(1100); // canvas convergence (import quiet period)
  assert.ok(modeler.xml().includes("Beta-REMOTE") && modeler.xml().includes("Alpha-LOCAL"));
  unbind();
});

test("overlapping edits: remote wins, conflict is reported — never silent", async () => {
  let conflict = "";
  const { doc, ytext, modeler, unbind } = setup((m) => {
    conflict = m;
  });
  await wait(700);

  const remote = BASE.replace('name="Beta"', 'name="Beta-REMOTE"');
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, remote);
  }, "remote-user");
  modeler.setXml(BASE.replace('name="Beta"', 'name="Beta-LOCAL"'));
  modeler.fire("commandStack.changed");
  await wait(600);

  assert.ok(ytext.toString().includes("Beta-REMOTE"));
  assert.ok(!ytext.toString().includes("Beta-LOCAL"));
  assert.ok(conflict.length > 0, "conflict callback must fire");
  assert.ok(modeler.xml().includes("Beta-REMOTE"), "canvas reverts to the surviving state");
  unbind();
});

test("sequential edit without remote interference uses the plain minimal diff", async () => {
  const { ytext, modeler, unbind } = setup();
  await wait(700);
  modeler.setXml(BASE.replace('name="Gamma"', 'name="Gamma-EDIT"'));
  modeler.fire("commandStack.changed");
  await wait(100);
  assert.ok(ytext.toString().includes("Gamma-EDIT"));
  unbind();
});
