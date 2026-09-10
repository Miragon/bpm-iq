/**
 * Room presence read-model — who is in a model's live room right now, for the
 * MCP get_presence tool: every person with the model open (name, selection,
 * pointer) and the AI clients acting in it (application/agent-presence.ts).
 *
 * The identity behind a peer comes from the SERVER, never from the payload:
 * Hocuspocus records which ws connection announced which awareness clientId,
 * and the connection carries the user onAuthenticate admitted. That is what
 * makes `you` trustworthy — the caller's own human presence, the person the
 * agent acts for — so "the element I selected" resolves to a real selection.
 *
 * Reads a LOADED document only (server.ts composes peersOf over
 * hocuspocus.documents): an unloaded room has nobody in it by definition, and
 * answering must never load one.
 */
import type { PresencePeerWire } from "@bpmiq/contracts/live-host";
import { sanitizeCanvas, sanitizeUser } from "@bpmiq/live-client/presence";

/** one raw awareness state of a room + the login of the ws connection that
 *  announced it (absent for server-published states — the agent leases) */
export interface RoomPeer {
  clientId: number;
  login?: string;
  state: unknown;
}

export interface RoomPresenceDeps {
  /** the raw peers of a LOADED room; [] (or absent) = nobody has it open */
  peersOf?: (room: string) => RoomPeer[];
}

/** the minimal structural surface of a Hocuspocus Document this reads */
export interface RoomDocLike {
  awareness: { clientID: number; getStates(): Map<number, unknown> };
  getConnections(): Array<{ context?: unknown }>;
  getClients(connection: { context?: unknown }): Set<number>;
}

/** every awareness state of a loaded document except the document's own,
 *  stamped with the announcing connection's login */
export function peersOfDocument(doc: RoomDocLike): RoomPeer[] {
  const loginOf = new Map<number, string>();
  for (const connection of doc.getConnections()) {
    const login = (connection.context as { user?: { login?: unknown } } | undefined)?.user?.login;
    if (typeof login !== "string") continue;
    for (const clientId of doc.getClients(connection)) loginOf.set(clientId, login);
  }
  const peers: RoomPeer[] = [];
  for (const [clientId, state] of doc.awareness.getStates()) {
    if (clientId === doc.awareness.clientID) continue;
    const login = loginOf.get(clientId);
    peers.push({ clientId, ...(login !== undefined ? { login } : {}), state });
  }
  return peers;
}

/** the room's peers as the tool answers them — un-announced peers (no user
 *  field yet) are not there to speak of */
export function roomPresence(deps: RoomPresenceDeps, room: string, callerLogin: string): PresencePeerWire[] {
  const out: PresencePeerWire[] = [];
  for (const peer of deps.peersOf?.(room) ?? []) {
    const s = peer.state as { user?: unknown; canvas?: unknown } | null | undefined;
    const user = sanitizeUser(s?.user);
    if (!user) continue;
    const canvas = sanitizeCanvas(s?.canvas) ?? { cursor: null, selection: [] };
    const kind = user.kind === "agent" ? "agent" : "human";
    out.push({
      name: user.name,
      kind,
      you: kind === "human" && peer.login === callerLogin,
      selection: canvas.selection,
      cursor: canvas.cursor,
    });
  }
  return out;
}
