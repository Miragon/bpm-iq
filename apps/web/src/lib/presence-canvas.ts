/**
 * Live canvas presence (#115) — remote cursors and selection outlines on any
 * diagram-js canvas, plus publishing the LOCAL pointer/selection. Same
 * ownership rule and structural typing as todo-canvas: framework-free, one
 * controller per modeler, created by the notation engine on mount and torn
 * down in its destroy. Works unchanged on bpmn-js and the Miragon
 * wardley/team-topologies modelers (all diagram-js: canvas + elementRegistry
 * + eventBus-backed on/off).
 *
 * Coordinates travel in MODEL space (@bpmiq/contracts/live CanvasPresence),
 * so peers at different zoom/pan see each cursor on the right spot. The
 * drawing layer is a named diagram-js layer INSIDE the viewport transform:
 * outlines drawn at model coordinates land automatically; cursor glyphs get
 * `scale(1/zoom)` so they keep their screen size. Canvas._clear (re-import)
 * leaves named layers alone, but elements change — render re-runs on
 * import.done / elements.changed and rebuilds from the last peer states.
 */
import type { CanvasPresence, PresenceUser } from "@bpmiq/contracts/live";

import { safePresenceColor, safePresenceLabel } from "@/lib/presence-format";

/** a remote peer as the shell surfaces it — user always present (peers that
 *  have not announced themselves yet are filtered out upstream) */
export interface RemotePresence {
  clientId: number;
  user: PresenceUser;
  canvas?: CanvasPresence;
}

/** the shell's presence surface (EditorContext.presence) — publish local,
 *  subscribe remote; the subscribe calls back immediately with the current
 *  peers and returns the unsubscribe */
export interface PresenceSurface {
  setLocal(presence: CanvasPresence | null): void;
  onRemote(cb: (peers: RemotePresence[]) => void): () => void;
}

/** minimal structural view of the diagram-js services we touch */
interface ElementLike {
  id: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  labelTarget?: ElementLike;
}
interface CanvasLike {
  getContainer(): HTMLElement;
  /** created on first use; default index = utility layer, ABOVE elements */
  getLayer(name: string): SVGElement;
  viewbox(): { x: number; y: number; scale: number };
}
interface ModelerLike {
  get(service: "canvas"): CanvasLike;
  get(service: "elementRegistry"): { get(id: string): ElementLike | undefined };
  on(event: string, callback: (event?: unknown) => void): void;
  off(event: string, callback: (event?: unknown) => void): void;
}

const LAYER = "bpm-presence";
const SVG_NS = "http://www.w3.org/2000/svg";
/** publish cadence for pointer moves — awareness is a broadcast, not a stream */
const PUBLISH_MS = 33;
/** outline cap per peer — a hostile select-all must not freeze the canvas */
const MAX_OUTLINES = 50;

const svg = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS(SVG_NS, tag);

export function attachPresenceCanvas(modeler: ModelerLike, presence: PresenceSurface): { destroy(): void } {
  const canvas = modeler.get("canvas");
  const registry = modeler.get("elementRegistry");
  const container = canvas.getContainer();

  // ── local: pointer + selection → setLocal, throttled ───────────────────────
  const local: CanvasPresence = { cursor: null, selection: [] };
  let lastPublish = 0;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  const publish = (): void => {
    lastPublish = Date.now();
    presence.setLocal({ cursor: local.cursor, selection: [...local.selection] });
  };
  const publishNow = (): void => {
    clearTimeout(trailing);
    trailing = undefined;
    publish();
  };
  const publishThrottled = (): void => {
    const due = lastPublish + PUBLISH_MS - Date.now();
    if (due <= 0) publishNow();
    else if (trailing === undefined) {
      trailing = setTimeout(() => {
        trailing = undefined;
        publish();
      }, due);
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    const rect = container.getBoundingClientRect();
    let vb;
    try {
      vb = canvas.viewbox();
    } catch {
      return; // nothing imported yet — no coordinate system to speak in
    }
    const scale = vb.scale || 1;
    local.cursor = {
      x: Math.round((vb.x + (e.clientX - rect.left) / scale) * 10) / 10,
      y: Math.round((vb.y + (e.clientY - rect.top) / scale) * 10) / 10,
    };
    publishThrottled();
  };
  const onPointerLeave = (): void => {
    local.cursor = null;
    publishNow();
  };
  const onSelectionChanged = (event?: unknown): void => {
    const raw = (event as { newSelection?: ElementLike[] } | undefined)?.newSelection ?? [];
    const ids = new Set<string>();
    for (const el of raw) {
      // an external label stands in for its host element (todo-canvas rule)
      const target = el.type === "label" && el.labelTarget ? el.labelTarget : el;
      ids.add(target.id);
    }
    // capped at the SOURCE, not only at render: awareness re-broadcasts the
    // full state with every cursor tick, and a select-all on a huge diagram
    // (~3,750+ elements) would exceed the server's ephemeral-message cap —
    // Hocuspocus then CLOSEs the doc and the session dies. Nobody renders
    // more than MAX_OUTLINES outlines anyway.
    local.selection = [...ids].slice(0, MAX_OUTLINES);
    publishNow(); // selection is discrete — no reason to throttle
  };

  // ── remote: peers → cursors + outlines on the presence layer ───────────────
  let peers: RemotePresence[] = [];
  let raf = 0;
  const scheduleRender = (): void => {
    if (raf === 0)
      raf = requestAnimationFrame(() => {
        raf = 0;
        render();
      });
  };

  const render = (): void => {
    const layer = canvas.getLayer(LAYER);
    while (layer.firstChild) layer.firstChild.remove();
    let vb;
    try {
      vb = canvas.viewbox();
    } catch {
      return;
    }
    const glyphScale = 1 / (vb.scale || 1);

    for (const peer of peers) {
      if (!peer.canvas) continue;
      const color = safePresenceColor(peer.user.color);

      // the session boundary sanitizes CanvasPresence, but render() clears
      // the layer FIRST — a throw here would blank every peer's presence, so
      // the shape is re-checked (belt and suspenders against future callers)
      const selection = Array.isArray(peer.canvas.selection) ? peer.canvas.selection : [];
      for (const id of selection.slice(0, MAX_OUTLINES)) {
        const el = typeof id === "string" ? registry.get(id) : undefined;
        // shapes only — connections carry waypoints, not a box
        if (!el || typeof el.x !== "number" || typeof el.width !== "number") continue;
        const outline = svg("rect");
        outline.setAttribute("x", String(el.x - 3));
        outline.setAttribute("y", String((el.y ?? 0) - 3));
        outline.setAttribute("width", String(el.width + 6));
        outline.setAttribute("height", String((el.height ?? 0) + 6));
        outline.setAttribute("rx", "3");
        outline.setAttribute("fill", "none");
        outline.setAttribute("stroke", color);
        outline.setAttribute("stroke-width", "1.5");
        // constant screen width regardless of zoom
        outline.setAttribute("vector-effect", "non-scaling-stroke");
        layer.appendChild(outline);
      }

      const cursor = peer.canvas.cursor;
      // isFinite, not typeof: translate(NaN) poisons the transform attribute
      if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
        const group = svg("g");
        group.setAttribute("transform", `translate(${cursor.x}, ${cursor.y}) scale(${glyphScale})`);
        group.setAttribute("style", "pointer-events: none");
        const arrow = svg("path");
        arrow.setAttribute("d", "M0,0 L0,14 L4,10.5 L6.5,16 L9,15 L6.5,9.5 L11,9.5 Z");
        arrow.setAttribute("fill", color);
        arrow.setAttribute("stroke", "#fff");
        arrow.setAttribute("stroke-width", "0.75");
        const pill = svg("rect");
        pill.setAttribute("x", "12");
        pill.setAttribute("y", "14");
        pill.setAttribute("height", "16");
        pill.setAttribute("rx", "4");
        pill.setAttribute("fill", color);
        const label = svg("text");
        label.setAttribute("x", "18");
        label.setAttribute("y", "25.5");
        label.setAttribute("fill", "#fff");
        label.setAttribute("style", "font: 600 10px system-ui, sans-serif");
        label.textContent = safePresenceLabel(peer.user.name);
        group.append(arrow, pill, label);
        layer.appendChild(group);
        // pill width fits the text — measurable only once in the live SVG
        pill.setAttribute("width", String(Math.ceil(label.getComputedTextLength()) + 12));
      }
    }
  };

  const offRemote = presence.onRemote((next) => {
    peers = next;
    scheduleRender();
  });

  container.addEventListener("pointermove", onPointerMove, { passive: true });
  container.addEventListener("pointerleave", onPointerLeave);
  modeler.on("selection.changed", onSelectionChanged);
  // zoom changes glyph scale; imports/edits move or replace outlined elements
  modeler.on("canvas.viewbox.changed", scheduleRender);
  modeler.on("import.done", scheduleRender);
  modeler.on("elements.changed", scheduleRender);

  return {
    destroy(): void {
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
      modeler.off("selection.changed", onSelectionChanged);
      modeler.off("canvas.viewbox.changed", scheduleRender);
      modeler.off("import.done", scheduleRender);
      modeler.off("elements.changed", scheduleRender);
      offRemote();
      if (raf !== 0) cancelAnimationFrame(raf);
      clearTimeout(trailing);
      try {
        const layer = canvas.getLayer(LAYER);
        while (layer.firstChild) layer.firstChild.remove();
      } catch {
        /* canvas already destroyed with the modeler */
      }
      presence.setLocal(null); // drop our cursor for peers right away
    },
  };
}
