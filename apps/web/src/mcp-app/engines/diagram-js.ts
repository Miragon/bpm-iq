/**
 * The diagram-js surface every engine adapter touches — STRUCTURALLY. The
 * widgets bundle different diagram-js copies (each Miragon renderer pins its
 * own, bpmn-js another), so nothing here may `instanceof` or import a
 * diagram-js module: only `get(service)` and the documented service APIs.
 */
export interface DiagramLike {
  /** didi's strict lookup — the Miragon viewers forward only the name, so a
   *  missing service THROWS (never pass a strict flag; guard by mount instead) */
  get(service: string): unknown;
  on(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
  destroy(): void;
}

/** the single selected element's id (a label resolves to its target), or
 *  undefined — also when this build registers no selection service */
export function selectedElementOf(instance: Pick<DiagramLike, "get">): string | undefined {
  try {
    const selection = instance.get("selection") as { get(): Array<{ id: string; labelTarget?: { id: string } }> };
    const selected = selection.get();
    if (selected.length !== 1) return undefined;
    return selected[0]?.labelTarget?.id ?? selected[0]?.id;
  } catch {
    return undefined;
  }
}

/** zoom the canvas to the whole diagram — what a fresh import shows */
export function fitViewport(instance: Pick<DiagramLike, "get">): void {
  (instance.get("canvas") as { zoom(mode: string): void }).zoom("fit-viewport");
}

export interface InertCommandStack {
  clear(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}
/** a didi module declaration: `[type, value]` providers keyed by service */
export type ViewerModule = { commandStack: ["value", InertCommandStack] };

/**
 * A didi VALUE module providing an inert `commandStack` — the read-only
 * mount of the wardley and event-storming renderers needs it: their
 * importMap runs `get("commandStack").clear()` unconditionally, but only the
 * Modeler registers a command stack (features/modeling); the Viewer and
 * NavigatedViewer do not, so a plain `new NavigatedViewer().importDSL()`
 * rejects with didi's "No provider for commandStack" (verified in
 * wardley-renderer 0.6.1 dist/index.js:204 and event-storming-renderer 0.2.1
 * dist/index.js:82). Nothing edits a viewer, so an inert stack is the truthful
 * service. team-topologies' importDocument never touches the stack — no shim
 * there. Remove once the renderers guard the clear() themselves (upstream
 * issues on Miragon/wardley-maps-modeler and Miragon/event-storming-modeler).
 */
export const viewerCommandStackShim: ViewerModule = {
  commandStack: ["value", { clear(): void {}, canUndo: () => false, canRedo: () => false }],
};
