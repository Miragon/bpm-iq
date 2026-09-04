/**
 * The widget engine of the Miragon JSON renderers (team topologies today):
 * the document is a typed object, so the text lane goes through an injected
 * codec (parse: non-throwing, lenient; serialize: deterministic) — the SAME
 * codec the SPA's live binding uses, so a widget save and the live export
 * serialize the same bytes. importDocument replaces every shape but leaves the
 * command stack UNTOUCHED (an undo would then act on removed objects), so the
 * EDITABLE mount erases history after each import, silently — the rule
 * live-client's tt-sync applies. The viewer registers no command stack at all
 * (and the renderer's get() forwards no strict flag: a lookup would throw), so
 * the clear is gated on the mount, not on a lookup. No shim needed either:
 * importDocument never touches the stack.
 *
 * Renderer constructors are injected as factories (the node --test suite
 * mounts fakes); this module imports neither a renderer nor a stylesheet.
 */
import type * as Y from "yjs";

import type { LiveBindHooks, WidgetEngine } from "../core/engine.ts";
import { type DiagramLike, fitViewport, selectedElementOf } from "./diagram-js.ts";

export interface JsonRendererLike extends DiagramLike {
  importDocument(document: unknown): unknown;
  exportDocument(): unknown;
}

export interface JsonCodec {
  parse(text: string): { ok: true; document: unknown } | { ok: false; error?: unknown };
  serialize(document: unknown): string;
}

/** the live-client bind of this notation (bindTeamTopology takes the codec too) */
export type JsonLiveBind = (
  modeler: JsonRendererLike,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
) => () => void;

export interface JsonEngineOptions {
  readonly: boolean;
  /** what a rejected parse is called in the error ("not a team-topology document") */
  noun: string;
  editor: () => JsonRendererLike;
  viewer: () => JsonRendererLike;
  codec: JsonCodec;
  bind: JsonLiveBind;
}

export interface JsonEngine extends WidgetEngine {
  raw: JsonRendererLike;
}

export function mountJsonEngine(o: JsonEngineOptions): JsonEngine {
  const instance = o.readonly ? o.viewer() : o.editor();
  const dirtyCbs = new Set<() => void>();
  if (!o.readonly) {
    // importDocument emits nothing and clear(false) is silent — no echo to suppress
    instance.on("commandStack.changed", () => {
      for (const cb of dirtyCbs) cb();
    });
  }
  return {
    raw: instance,
    editable: !o.readonly,
    async importText(text: string): Promise<void> {
      const parsed = o.codec.parse(text);
      if (!parsed.ok) throw new Error(`not a ${o.noun} document: ${String(parsed.error ?? "parse failed")}`);
      instance.importDocument(parsed.document);
      // the editable mount only — the viewer has no command stack (see header)
      if (!o.readonly) (instance.get("commandStack") as { clear(emit?: boolean): void }).clear(false);
      fitViewport(instance);
    },
    async exportText(): Promise<string> {
      if (o.readonly) throw new Error("read-only view");
      return o.codec.serialize(instance.exportDocument());
    },
    onDirty(cb: () => void): () => void {
      dirtyCbs.add(cb);
      return () => dirtyCbs.delete(cb);
    },
    selectedElementId: () => selectedElementOf(instance),
    bindLive(ytext: Y.Text, doc: Y.Doc, hooks: LiveBindHooks): () => void {
      return o.bind(instance, ytext, doc, hooks.onConflict, hooks.onImportError);
    },
    destroy(): void {
      instance.destroy();
    },
  };
}
