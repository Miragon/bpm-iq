/**
 * The Miragon widget engine without a browser (src/mcp-app/engines/miragon.ts):
 * the DSL lane's dirty suppression and viewer shim, the document lane's
 * silent history erase and codec gate, the live binding through the real
 * live-client adapter, and the ONE schema-model codec both the SPA and the
 * widget serialize through (src/notations/miragon/codec.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { viewerCommandStackShim } from "../src/mcp-app/engines/diagram-js.ts";
import { mountMiragonEngine } from "../src/mcp-app/engines/miragon.ts";
import { schemaModelCodec } from "../src/notations/miragon/codec.ts";
import type { LoadedMiragonRenderer, MiragonRendererCtor, MiragonRendererLike } from "../src/notations/miragon/spec.ts";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const container = {} as HTMLElement;

/** a DSL renderer whose importDSL EMITS commandStack.changed (the Miragon
 *  trait) and whose exportDSL is NOT a byte fixpoint (it wraps) */
function fakeDsl(
  o: {
    selection?: Array<{ id: string; labelTarget?: { id: string } }>;
    changeEvents?: readonly string[];
    importFails?: boolean;
  } = {},
) {
  const handlers = new Map<string, Set<() => void>>();
  const state = {
    imported: [] as string[],
    fitted: 0,
    destroyed: 0,
    /** what the read-only mount handed the viewer */
    viewerModules: undefined as unknown[] | undefined,
    modelerMounts: 0,
    dsl: "",
  };
  const emit = (event: string): void => handlers.get(event)?.forEach((cb) => cb());
  const instance: MiragonRendererLike = {
    get: (service: string) => {
      if (service === "canvas") {
        return {
          zoom: () => {
            state.fitted++;
          },
          viewbox: () => ({ x: 0, y: 0, width: 100, height: 100 }),
        };
      }
      if (service === "selection" && o.selection) return { get: () => o.selection };
      throw new Error(`No provider for "${service}"`);
    },
    on: (event: string, cb: () => void) =>
      void (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(cb),
    off: (event: string, cb: () => void) => void handlers.get(event)?.delete(cb),
    destroy: () => {
      state.destroyed++;
    },
    async importDSL(text: string) {
      if (o.importFails) throw new Error("parse");
      state.imported.push(text);
      state.dsl = text;
      emit("commandStack.changed"); // the clear() echo
    },
    exportDSL: (): string => `export(${state.dsl})`,
  };
  const ctor = (onNew: (opts: { additionalModules?: unknown[] }) => void): MiragonRendererCtor =>
    function (this: unknown, opts: { additionalModules?: unknown[] }) {
      onNew(opts);
      return instance;
    } as unknown as MiragonRendererCtor;
  const renderer: LoadedMiragonRenderer = {
    Modeler: ctor(() => state.modelerMounts++),
    NavigatedViewer: ctor((opts) => {
      state.viewerModules = opts.additionalModules;
    }),
    lane: { kind: "dsl", changeEvents: o.changeEvents ?? ["commandStack.changed", "wardley.config.changed"] },
  };
  return { state, renderer, emit };
}

test("dsl lane: the import echo never fires onDirty, a later edit does; exportText is the renderer's DSL", async () => {
  const { state, renderer, emit } = fakeDsl();
  const engine = mountMiragonEngine(renderer, container, false);
  assert.equal(state.modelerMounts, 1);
  assert.equal(state.viewerModules, undefined, "the editable mount never touches the viewer");
  assert.equal(engine.editable, true);
  let dirty = 0;
  const off = engine.onDirty(() => dirty++);
  await engine.importText("component A [0.1, 0.2]");
  assert.equal(dirty, 0, "the importDSL clear() echo is suppressed");
  assert.equal(state.fitted, 1);
  emit("commandStack.changed");
  emit("wardley.config.changed");
  assert.equal(dirty, 2, "both change events count as edits");
  off();
  emit("commandStack.changed");
  assert.equal(dirty, 2, "unsubscribed");
  assert.equal(await engine.exportText(), "export(component A [0.1, 0.2])");
  engine.destroy();
  assert.equal(state.destroyed, 1);
});

test("dsl lane read-only: the viewer gets the inert command stack, no change events, no export", async () => {
  const { state, renderer, emit } = fakeDsl({ changeEvents: ["commandStack.changed"] });
  const engine = mountMiragonEngine(renderer, container, true);
  assert.equal(state.modelerMounts, 0);
  assert.deepEqual(state.viewerModules, [viewerCommandStackShim]);
  assert.equal(engine.editable, false);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  await engine.importText("x");
  emit("commandStack.changed");
  assert.equal(dirty, 0, "a viewer never subscribes");
  await assert.rejects(() => engine.exportText(), /read-only/);
});

test("dsl lane: bindLive hands the canvas to live-client's miragon-sync — the Y.Text imports, canvas edits export, hooks are threaded", async () => {
  const { state, renderer, emit } = fakeDsl({ selection: [{ id: "label_1", labelTarget: { id: "node_1" } }] });
  const engine = mountMiragonEngine(renderer, container, false);
  assert.equal(engine.selectedElementId?.(), "node_1", "a label resolves to its target");

  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, "component A [0.1, 0.2]\n");
  const errors: string[] = [];
  const unbind = engine.bindLive!(ytext, doc, { onConflict: () => {}, onImportError: (m) => errors.push(m) });
  await tick(50);
  assert.deepEqual(state.imported, ["component A [0.1, 0.2]\n"], "the Y.Text landed on the canvas");
  assert.equal(errors.length, 0);
  // a canvas edit exports into the Y.Text (through the lane's change events)
  state.dsl = "component A [0.1, 0.2]\ncomponent B [0.5, 0.5]\n";
  emit("wardley.config.changed");
  await tick(50);
  assert.match(ytext.toString(), /component B/);
  unbind();
  state.dsl = "gone";
  emit("commandStack.changed");
  await tick(50);
  assert.doesNotMatch(ytext.toString(), /gone/, "unbound: canvas edits no longer export");

  // the import-error hook: a document that never rendered reports once
  const empty = new Y.Doc();
  const unbindEmpty = engine.bindLive!(empty.getText("content"), empty, {
    onConflict: () => {},
    onImportError: (m) => errors.push(m),
  });
  await tick(50);
  assert.deepEqual(errors, ["the document is empty"]);
  unbindEmpty();

  const bare = mountMiragonEngine(fakeDsl().renderer, container, false);
  assert.equal(bare.selectedElementId?.(), undefined, "no selection service → undefined, never a throw");
});

test("dsl lane: a rejected importDSL releases the latch — later edits still count", async () => {
  const { renderer, emit } = fakeDsl({ importFails: true, changeEvents: ["commandStack.changed"] });
  const engine = mountMiragonEngine(renderer, container, false);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  await assert.rejects(() => engine.importText("x"), /parse/);
  emit("commandStack.changed");
  assert.equal(dirty, 1, "edits after a failed import still count");
});

test("viewerCommandStackShim is an inert didi value module", () => {
  const [kind, stack] = viewerCommandStackShim.commandStack;
  assert.equal(kind, "value");
  assert.equal(stack.clear(), undefined);
  assert.equal(stack.canUndo(), false);
  assert.equal(stack.canRedo(), false);
});

// ── the document lane ───────────────────────────────────────────────────────

/** a JSON renderer: `services` names what its injector registers (the viewer
 *  has no command stack); clear(emit) fires 'changed' unless emit === false */
function fakeDocument(services: string[]) {
  const handlers = new Map<string, Array<() => void>>();
  const log: unknown[] = [];
  const instance: MiragonRendererLike = {
    get: (service: string): any => {
      if (service === "canvas") return { zoom: () => {}, viewbox: () => ({ x: 0, y: 0, width: 1, height: 1 }) };
      if (services.includes(service)) {
        return {
          clear: (emit?: boolean) => {
            log.push(`clear:${service}:${emit}`);
            if (emit !== false) handlers.get("commandStack.changed")?.forEach((cb) => cb());
          },
        };
      }
      throw new Error(`No provider for "${service}"!`);
    },
    on: (event: string, cb: () => void) => void (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(cb),
    off: () => {},
    destroy: () => {},
    importDocument: (doc: unknown) => void log.push(doc),
    exportDocument: () => ({ nodes: [] }),
  };
  const ctor = () =>
    function (this: unknown) {
      return instance;
    } as unknown as MiragonRendererCtor;
  const codec = {
    parse: (text: string) => (text === "bad" ? { ok: false as const } : { ok: true as const, document: { text } }),
    serialize: (document: unknown) => JSON.stringify(document),
  };
  const renderer: LoadedMiragonRenderer = {
    Modeler: ctor(),
    NavigatedViewer: ctor(),
    lane: { kind: "document", notation: "team-topology", codec },
  };
  return { renderer, log, emit: (event: string) => handlers.get(event)?.forEach((cb) => cb()) };
}

test("document lane read-only: no command-stack lookup on the viewer (the renderer's get() forwards no strict flag)", async () => {
  const viewer = fakeDocument([]); // no commandStack on a viewer
  const engine = mountMiragonEngine(viewer.renderer, container, true);
  await engine.importText("x");
  assert.deepEqual(viewer.log, [{ text: "x" }], "imported without touching the stack");
  await assert.rejects(() => engine.importText("bad"), /not a team-topology document/);
});

test("document lane editable: the post-import clear is SILENT, a rejected parse never reaches importDocument, a real edit dirties", async () => {
  const r = fakeDocument(["commandStack"]);
  const engine = mountMiragonEngine(r.renderer, container, false);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  await engine.importText("ok");
  assert.deepEqual(r.log, [{ text: "ok" }, "clear:commandStack:false"], "history erased with clear(false)");
  assert.equal(dirty, 0, "engine invariant 1: the import (and its history erase) never dirties");
  await assert.rejects(() => engine.importText("bad"));
  assert.equal(r.log.length, 2, "a rejected parse never reached importDocument");
  r.emit("commandStack.changed");
  assert.equal(dirty, 1, "a real edit does");
  assert.equal(await engine.exportText(), '{"nodes":[]}');
});

// ── the codec ───────────────────────────────────────────────────────────────

for (const pkg of ["@miragon/team-topologies-schema-model", "@miragon/context-maps-schema-model"] as const) {
  test(`schemaModelCodec(${pkg}): lenient parse, rejected garbage, deterministic round-trip`, async () => {
    const codec = schemaModelCodec(await import(pkg));
    const empty = codec.parse("{}");
    assert.ok(empty.ok, "an empty object migrates to a valid document");
    assert.equal(codec.parse("not json").ok, false);
    const once = codec.serialize(empty.ok ? empty.document : undefined);
    const again = codec.parse(once);
    assert.ok(again.ok);
    assert.equal(codec.serialize(again.document), once);
  });
}
