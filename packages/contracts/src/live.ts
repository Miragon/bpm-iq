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
