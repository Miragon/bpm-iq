/**
 * The engine adapters that need no browser: the DSL engine's dirty
 * suppression and viewer shim (src/mcp-app/engines/dsl.ts) and the shared
 * Team-Topology codec (src/lib/tt-codec.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ttCodec } from "../src/lib/tt-codec.ts";
import { viewerCommandStackShim } from "../src/mcp-app/engines/diagram-js.ts";
import { type DslRendererLike, mountDslEngine } from "../src/mcp-app/engines/dsl.ts";

interface FakeRenderer {
  imported: string[];
  fitted: number;
  destroyed: number;
  emit(event: string): void;
  renderer: DslRendererLike;
}

/** a renderer whose importDSL EMITS commandStack.changed (the Miragon trait) */
function fakeRenderer(o: { selection?: Array<{ id: string; labelTarget?: { id: string } }> } = {}): FakeRenderer {
  const handlers = new Map<string, Array<() => void>>();
  const r: FakeRenderer = {
    imported: [],
    fitted: 0,
    destroyed: 0,
    emit: (event: string) => handlers.get(event)?.forEach((cb) => cb()),
    renderer: {
      get: (service: string) => {
        if (service === "canvas") {
          return {
            zoom: () => {
              r.fitted++;
            },
          };
        }
        if (service === "selection" && o.selection) return { get: () => o.selection };
        throw new Error(`No provider for "${service}"`);
      },
      on: (event: string, cb: () => void) => void (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(cb),
      off: () => {},
      destroy: () => {
        r.destroyed++;
      },
      async importDSL(text: string) {
        r.imported.push(text);
        r.emit("commandStack.changed"); // the clear() echo
      },
      exportDSL: (): string => `export(${r.imported.at(-1) ?? ""})`,
    },
  };
  return r;
}

test("mountDslEngine: the import echo never fires onDirty, a later edit does; exportText is the renderer's DSL", async () => {
  const r = fakeRenderer();
  let viewerCalls = 0;
  const engine = mountDslEngine({
    readonly: false,
    editor: () => r.renderer,
    viewer: () => {
      viewerCalls++;
      return r.renderer;
    },
    changeEvents: ["commandStack.changed", "wardley.config.changed"],
    bind: () => () => {},
  });
  assert.equal(viewerCalls, 0);
  assert.equal(engine.editable, true);
  let dirty = 0;
  const off = engine.onDirty(() => dirty++);
  await engine.importText("component A [0.1, 0.2]");
  assert.equal(dirty, 0, "the importDSL clear() echo is suppressed");
  assert.equal(r.fitted, 1);
  r.emit("commandStack.changed");
  r.emit("wardley.config.changed");
  assert.equal(dirty, 2, "both change events count as edits");
  off();
  r.emit("commandStack.changed");
  assert.equal(dirty, 2, "unsubscribed");
  assert.equal(await engine.exportText(), "export(component A [0.1, 0.2])");
  engine.destroy();
  assert.equal(r.destroyed, 1);
});

test("mountDslEngine read-only: the viewer gets the inert command stack, no change events, no export", async () => {
  const r = fakeRenderer();
  let received: unknown[] | undefined;
  const engine = mountDslEngine({
    readonly: true,
    editor: () => {
      throw new Error("never");
    },
    viewer: (modules) => {
      received = modules;
      return r.renderer;
    },
    changeEvents: ["commandStack.changed"],
    bind: () => () => {},
  });
  assert.deepEqual(received, [viewerCommandStackShim]);
  assert.equal(engine.editable, false);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  await engine.importText("x");
  r.emit("commandStack.changed");
  assert.equal(dirty, 0, "a viewer never subscribes");
  await assert.rejects(() => engine.exportText(), /read-only/);
});

test("mountDslEngine: bindLive threads both hooks into the notation's bind; selection resolves label targets", () => {
  const r = fakeRenderer({ selection: [{ id: "label_1", labelTarget: { id: "node_1" } }] });
  const seen: unknown[] = [];
  const engine = mountDslEngine({
    readonly: false,
    editor: () => r.renderer,
    viewer: () => r.renderer,
    changeEvents: [],
    bind: (m, ytext, doc, onConflict, onImportError) => {
      seen.push(m, ytext, doc, onConflict, onImportError);
      return () => seen.push("unbound");
    },
  });
  const hooks = { onConflict: () => {}, onImportError: () => {} };
  const unbind = engine.bindLive!("Y" as never, "D" as never, hooks);
  assert.deepEqual(seen, [r.renderer, "Y", "D", hooks.onConflict, hooks.onImportError]);
  unbind();
  assert.equal(seen.at(-1), "unbound");
  assert.equal(engine.selectedElementId?.(), "node_1");
  const bare = mountDslEngine({
    readonly: false,
    editor: () => fakeRenderer().renderer,
    viewer: () => fakeRenderer().renderer,
    changeEvents: [],
    bind: () => () => {},
  });
  assert.equal(bare.selectedElementId?.(), undefined, "no selection service → undefined, never a throw");
});

test("viewerCommandStackShim is an inert didi value module", () => {
  const [kind, stack] = viewerCommandStackShim.commandStack;
  assert.equal(kind, "value");
  assert.equal(stack.clear(), undefined);
  assert.equal(stack.canUndo(), false);
  assert.equal(stack.canRedo(), false);
});

test("ttCodec: lenient parse, rejected garbage, deterministic round-trip", () => {
  const empty = ttCodec.parse("{}");
  assert.ok(empty.ok, "an empty object migrates to a valid board");
  assert.equal(ttCodec.parse("not json").ok, false);
  const once = ttCodec.serialize(empty.ok ? empty.document : undefined);
  const again = ttCodec.parse(once);
  assert.ok(again.ok);
  assert.equal(ttCodec.serialize(again.document), once);
});

test("mountJsonEngine read-only: no command-stack lookup on the viewer (the renderer's get() forwards no strict flag)", async () => {
  const { mountJsonEngine } = await import("../src/mcp-app/engines/tt.ts");
  const imported: unknown[] = [];
  const renderer = (services: string[]) => ({
    get: (service: string) => {
      if (service === "canvas") return { zoom: () => {} };
      if (services.includes(service)) return { clear: () => void imported.push(`clear:${service}`) };
      throw new Error(`No provider for "${service}"!`);
    },
    on: () => {},
    off: () => {},
    destroy: () => {},
    importDocument: (doc: unknown) => void imported.push(doc),
    exportDocument: () => ({ nodes: [] }),
  });
  const codec = {
    parse: (text: string) => (text === "bad" ? { ok: false as const } : { ok: true as const, document: { text } }),
    serialize: (document: unknown) => JSON.stringify(document),
  };
  const viewer = mountJsonEngine({
    readonly: true,
    noun: "team-topology",
    editor: () => {
      throw new Error("never");
    },
    viewer: () => renderer([]), // no commandStack on a viewer
    codec,
    bind: () => () => {},
  });
  await viewer.importText("x");
  assert.deepEqual(imported, [{ text: "x" }], "imported without touching the stack");
  await assert.rejects(() => viewer.importText("bad"), /not a team-topology document/);
  const editor = mountJsonEngine({
    readonly: false,
    noun: "team-topology",
    editor: () => renderer(["commandStack"]),
    viewer: () => {
      throw new Error("never");
    },
    codec,
    bind: () => () => {},
  });
  imported.length = 0;
  await editor.importText("y");
  assert.deepEqual(imported, [{ text: "y" }, "clear:commandStack"], "the editable mount erases history silently");
  assert.equal(await editor.exportText(), '{"nodes":[]}');
});
