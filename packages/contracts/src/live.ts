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

// ── editor sign-in (the VS Code extension) ───────────────────────────────────
// A login started with ?editor=<uri scheme>&editor_state=<nonce> lands in the
// editor: the callback bounces the browser to
// <scheme>://EDITOR_EXTENSION_ID EDITOR_LOGIN_PATH?code=…&state=… and the
// editor exchanges the one-time code for its session (POST /auth/exchange —
// EditorLoginExchangeBody in ./live-host.ts). The Live Host BUILDS this target
// (live-host http/editor-login.ts); the extension registers the URI handler
// under the same id — a literal shared here so the two cannot drift.

/** publisher.name of the VS Code extension (apps/vscode/package.json) */
export const EDITOR_EXTENSION_ID = "miragon-gmbh.bpm-live";
/** the path of the extension's sign-in URI handler */
export const EDITOR_LOGIN_PATH = "/auth";

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
  /** "agent" = an AI client acting through the Live Host's /mcp on behalf of
   *  a person (the name says whom). SERVER-ASSERTED: the Live Host stamps it
   *  on the presence it publishes for agents and strips it from every
   *  ws-originated state, so a browser peer can never pose as one. Absent =
   *  human. */
  kind?: "human" | "agent";
}

/** presence color, DETERMINISTIC per principal — the same person shows up in
 *  the same color on every device, session and client (web, VS Code, the
 *  Live Host's agent presence). Erasable-syntax-safe on purpose: the
 *  type-stripped backend calls it at runtime. */
export const presenceColor = (principal: string): string => {
  const palette = ["#fa8100", "#0aa2c0", "#7c4dff", "#2e7d32", "#c2185b", "#00695c", "#5d4037"] as const;
  let hash = 0;
  for (const ch of principal) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return palette[hash % palette.length] ?? palette[0];
};

/** where a client is on the CANVAS — model coordinates (the space the DI
 *  uses), zoom/pan-independent; null cursor = pointer off-canvas */
export interface CanvasPresence {
  cursor: { x: number; y: number } | null;
  /** selected element ids */
  selection: string[];
}
