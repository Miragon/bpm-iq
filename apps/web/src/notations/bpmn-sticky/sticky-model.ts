/**
 * Pure sticky-model helpers (#117) — the shared vocabulary of the sticky
 * modules: type/kind constants, moddle-tree readers and the canonical
 * ordering. No bpmn-js imports; everything works structurally on moddle
 * elements so the persistence module and tests stay decoupled from the
 * engine.
 */

export const STICKY_TYPE = "bpmiq:Sticky";

export const STICKY_KINDS = ["note", "question", "decision", "role"] as const;
export type StickyKind = (typeof STICKY_KINDS)[number];

export const STICKY_SIZE = { width: 120, height: 120 };

/** kind → fill/stroke — the classic workshop palette, muted for the canvas */
export const STICKY_COLORS: Record<StickyKind, { fill: string; stroke: string }> = {
  note: { fill: "#fff9c4", stroke: "#f9a825" },
  question: { fill: "#ffe0b2", stroke: "#ef6c00" },
  decision: { fill: "#c8e6c9", stroke: "#2e7d32" },
  role: { fill: "#bbdefb", stroke: "#1565c0" },
};

/** minimal structural view of a moddle element */
export interface ModdleLike {
  $type: string;
  $parent?: ModdleLike;
  [key: string]: unknown;
}

/** the sticky extension element's shape */
export interface StickyModdle extends ModdleLike {
  id: string;
  text?: string;
  x?: number;
  y?: number;
  kind?: string;
  attachedTo?: string;
}

/** a diagram-js element hosting a sticky businessObject */
export interface StickyElementLike {
  id: string;
  type?: string;
  businessObject?: ModdleLike;
}

export function isSticky(element: unknown): element is StickyElementLike & { businessObject: StickyModdle } {
  const el = element as StickyElementLike | null;
  return !!el && (el.type === STICKY_TYPE || el.businessObject?.$type === STICKY_TYPE);
}

export function stickyKindOf(sticky: StickyModdle): StickyKind {
  const kind = sticky.kind;
  return (STICKY_KINDS as readonly string[]).includes(kind ?? "") ? (kind as StickyKind) : "note";
}

/** every bpmn:Process in the definitions (plain and collaboration-referenced
 *  processes all live in rootElements) */
export function processesOf(definitions: ModdleLike): ModdleLike[] {
  const roots = (definitions.rootElements as ModdleLike[] | undefined) ?? [];
  return roots.filter((r) => r.$type === "bpmn:Process");
}

/** the stickies persisted on ONE process's extensionElements */
export function stickiesOf(process: ModdleLike): StickyModdle[] {
  const ext = process.extensionElements as ModdleLike | undefined;
  const values = (ext?.values as ModdleLike[] | undefined) ?? [];
  return values.filter((v): v is StickyModdle => v.$type === STICKY_TYPE);
}

// NB deliberately NO global sort of the values list: convergence comes from
// the shared Y.Text — every client serializes the SAME merged tree order.
// Re-sorting on create would rewrite many sticky lines for one added sticky,
// amplifying CRDT conflict surface for zero convergence gain (review #117).
