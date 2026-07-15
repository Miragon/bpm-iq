/**
 * The live-document contract — how a client addresses a collaborative document
 * on the Live Host. Shared by the server-side collab hooks, the web editor,
 * the VS Code extension and headless test guests, so the literals can't drift.
 *
 * NB the ONLY value exports in @bpmiq/contracts live here, and both are
 * erasable-syntax-safe (plain const / arrow function) — the type-stripped
 * backends can import them at runtime.
 */

/** the ONE Y.Text field carrying a live document's content */
export const CONTENT_KEY = "content";

/** room name = "<repo-full-name>/<repo-relative-path>" (multi-repo contract) */
export const roomName = (repoFullName: string, path: string): string => `${repoFullName}/${path}`;
