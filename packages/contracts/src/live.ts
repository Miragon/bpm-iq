/**
 * The live-document contract — how a client addresses a collaborative document
 * on the Live Host. Shared by the server-side collab hooks, the web editor,
 * the VS Code extension and headless test guests, so the literals can't drift.
 *
 * NB the ONLY value exports in @bpmiq/contracts live here, and all are
 * erasable-syntax-safe (plain const / arrow function) — the type-stripped
 * backends can import them at runtime.
 */

/** the ONE Y.Text field carrying a TEXT-shaped live document's content */
export const CONTENT_KEY = "content";

/**
 * The STRUCTURED doc shape (docShape: "structured", epic #118 step 8) — the
 * element-wise CRDT lane for canvas notations. ELEMENTS_KEY holds a
 * Y.Map<elementId, Y.Map<attr, value>> (attribute-level merge: two users
 * editing different attributes of one EXISTING element converge — concurrent
 * CREATION of the same element id resolves whole-element last-writer-wins,
 * and the losing client's retained Y.Map reference is orphaned: re-read the
 * element from ELEMENTS_KEY after syncs and use collision-safe ids),
 * META_KEY a flat
 * Y.Map of document-level values. At rest the doc IS its canonical text
 * (the notation's DocCodec) — git/PR review, CAS, history and the validator
 * all keep working on text. CONTENT_KEY stays untouched: the two shapes
 * coexist per room, selected by the notation's descriptor.
 */
export const ELEMENTS_KEY = "elements";
export const META_KEY = "meta";

/** room name = "<repo-full-name>/<repo-relative-path>" (multi-repo contract) */
export const roomName = (repoFullName: string, path: string): string => `${repoFullName}/${path}`;

/** every room of one repo starts with this — the trailing slash keeps
 *  "acme/models-2" from ever matching "acme/models" */
export const roomPrefix = (repoFullName: string): string => `${repoFullName}/`;

// ── presence (awareness) — ephemeral, NEVER in the Y.Doc ─────────────────────
// Awareness is scoped per room (a room IS one file), so no docPath rides in
// the payload. y-monaco owns the awareness field "selection" — the canvas
// presence uses its own key.

export const AWARENESS_USER_KEY = "user";
export const AWARENESS_CANVAS_KEY = "canvas";

/** who a client is — the roster avatar and the cursor label */
export interface PresenceUser {
  name: string;
  color: string;
  avatarUrl?: string | null;
  /** reserved for AI-participant presence — agents joining awareness declare
   *  themselves so clients can render them distinctly */
  kind?: "human" | "agent";
}

/** where a client is on the CANVAS — model coordinates (the space the DI
 *  uses), zoom/pan-independent; null cursor = pointer off-canvas */
export interface CanvasPresence {
  cursor: { x: number; y: number } | null;
  /** selected element ids */
  selection: string[];
}
