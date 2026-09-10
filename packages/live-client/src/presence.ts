/**
 * Presence payload sanitizers — awareness states arrive from REMOTE peers and
 * are UNTRUSTED input (a hostile or version-skewed client can put arbitrary
 * JSON into its fields). Every consumer shape-checks at its boundary through
 * these: the live session (session.ts) before a peer reaches the canvas, and
 * the Live Host before a room's presence is answered to an MCP client.
 * Dependency-free on purpose — importable without the Hocuspocus provider.
 */
import type { CanvasPresence, PresenceUser } from "@bpmiq/contracts/live";

/** the roster identity, or undefined when the peer has not announced one */
export function sanitizeUser(raw: unknown): PresenceUser | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  if (typeof u.name !== "string" || typeof u.color !== "string") return undefined;
  // kind is a closed enum ("agent" renders distinctly) — anything else is
  // dropped, on a COPY: the state object belongs to the awareness protocol
  const { kind, ...rest } = u;
  return { ...rest, ...(kind === "agent" || kind === "human" ? { kind } : {}) } as unknown as PresenceUser;
}

/** the canvas state normalized to the contract shape, or undefined when the
 *  field is not an object at all */
export function sanitizeCanvas(raw: unknown): CanvasPresence | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const c = raw as { cursor?: unknown; selection?: unknown };
  const cur = c.cursor as { x?: unknown; y?: unknown } | null | undefined;
  const cursor =
    cur !== null && cur !== undefined && typeof cur === "object" && Number.isFinite(cur.x) && Number.isFinite(cur.y)
      ? { x: cur.x as number, y: cur.y as number }
      : null;
  const selection = Array.isArray(c.selection) ? c.selection.filter((id): id is string => typeof id === "string") : [];
  return { cursor, selection };
}
