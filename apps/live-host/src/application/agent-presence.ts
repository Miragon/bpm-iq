/**
 * Agent presence — AI clients show up in a room's awareness like a co-editor.
 *
 * The MCP write path never joins a room: every tool call opens a server-side
 * direct connection, transacts and disconnects within milliseconds, and the
 * /mcp transport is stateless — so from a co-editor's perspective an agent
 * editing the model was invisible (no roster avatar, no cursor). This module
 * gives each (room, principal) an awareness LEASE: a model-touching tool call
 * `touch`es it, the lease publishes a presence state (kind "agent", named
 * after the person the agent acts for, the elements its last save changed as
 * the selection) into the room's awareness, and it expires TTL after the last
 * touch — a removal every client sees.
 *
 * Mechanics: one private y-protocols Awareness per lease (its own Y.Doc, so
 * its own clientID) whose every update is re-encoded into the room's
 * awareness — the room broadcasts it to every ws client exactly like a
 * peer's state, and Hocuspocus sends the current states to whoever connects
 * later. The private instance's own re-announce (every ~15 s, y-protocols)
 * rides the same path, which keeps the state alive past the clients' 30 s
 * outdated-purge. `awarenessOf` answers only for a LOADED room (someone has
 * it open): nobody in the room means nobody to show the agent to — and no
 * document is ever pinned live for the sake of a presence marker.
 *
 * Never in the Y.Doc (presence is ephemeral — the live contract). kind
 * "agent" is asserted HERE and stripped from every ws-originated state in
 * collab.ts, so a browser peer cannot pose as an agent.
 */
import {
  AWARENESS_CANVAS_KEY,
  AWARENESS_USER_KEY,
  type CanvasPresence,
  presenceColor,
  type PresenceUser,
} from "@bpmiq/contracts/live";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import { MAX_CHANGED_IDS } from "../domain/model-diff.ts";

export interface AgentPresenceDeps {
  /** the awareness of a LOADED room; undefined when nobody has it open */
  awarenessOf(room: string): Awareness | undefined;
  /** lease after the last touch — default DEFAULT_TTL_MS */
  ttlMs?: number;
}

/** the person an agent acts for — what the presence is named after */
export interface AgentPrincipal {
  login: string;
  name: string;
}

export const DEFAULT_TTL_MS = 60_000;

/** the origin the room's awareness sees — not a connection, so Hocuspocus
 *  does no per-connection bookkeeping and just broadcasts */
const AGENT_ORIGIN = { source: "local", context: "agent-presence" } as const;

/** the presence user an agent publishes — exported for the tests and the
 *  ws-ticket mint (the widget's HUMAN presence uses the same palette) */
export function agentPresenceUser(principal: AgentPrincipal): PresenceUser {
  return {
    name: `AI · ${principal.name || principal.login}`,
    // its own hue, deterministic per person: the agent and the person it
    // acts for are two participants on the canvas
    color: presenceColor(`agent:${principal.login}`),
    avatarUrl: null,
    kind: "agent",
  };
}

interface Lease {
  doc: Y.Doc;
  awareness: Awareness;
  canvas: CanvasPresence;
  expiry?: ReturnType<typeof setTimeout>;
}

export class AgentPresence {
  private readonly leases = new Map<string, Lease>();
  private readonly deps: AgentPresenceDeps;
  private readonly ttlMs: number;

  constructor(deps: AgentPresenceDeps) {
    this.deps = deps;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Announce (or renew) the agent acting for `principal` in `room`. `canvas`
   * is a THUNK so callers can hand over a save diff that is only computed
   * when there is a room to show it in; omitted = keep the last canvas state
   * (a read after a save must not clear the outlines of what the agent did).
   */
  touch(room: string, principal: AgentPrincipal, canvas?: () => CanvasPresence | undefined): void {
    const key = `${room}\0${principal.login}`;
    let lease = this.leases.get(key);
    if (!lease) {
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      // the private instance re-announces its state every ~15 s on its own
      // check interval; a live-host process must never be kept alive by it
      (awareness as unknown as { _checkInterval?: { unref?: () => void } })._checkInterval?.unref?.();
      awareness.on("update", () => this.forward(room, awareness));
      lease = { doc, awareness, canvas: { cursor: null, selection: [] } };
      this.leases.set(key, lease);
    }
    clearTimeout(lease.expiry);
    // a room WITH peers is the only reason to compute the canvas state — but
    // the state must also be right for a peer who joins during the lease, so
    // compute it whenever the room is loaded at all
    if (canvas && this.deps.awarenessOf(room)) {
      const next = canvas();
      if (next) lease.canvas = { cursor: next.cursor, selection: next.selection.slice(0, MAX_CHANGED_IDS) };
    }
    lease.awareness.setLocalState({
      [AWARENESS_USER_KEY]: agentPresenceUser(principal),
      [AWARENESS_CANVAS_KEY]: lease.canvas,
    });
    lease.expiry = setTimeout(() => this.release(key), this.ttlMs);
    lease.expiry.unref();
  }

  /** live leases (tests, diagnostics) */
  get size(): number {
    return this.leases.size;
  }

  /** end every lease now — the removals reach the rooms (shutdown, tests) */
  destroy(): void {
    for (const key of [...this.leases.keys()]) this.release(key);
  }

  private release(key: string): void {
    const lease = this.leases.get(key);
    if (!lease) return;
    this.leases.delete(key);
    clearTimeout(lease.expiry);
    // destroy() nulls the local state FIRST (y-protocols) — that one update
    // is forwarded as the removal the room broadcasts — and only then drops
    // the listeners and the check interval
    lease.awareness.destroy();
    lease.doc.destroy();
  }

  /** re-encode the lease's own state into the room — a no-op while nobody
   *  has the room open (the next re-announce or touch tries again) */
  private forward(room: string, awareness: Awareness): void {
    const target = this.deps.awarenessOf(room);
    if (!target) return;
    applyAwarenessUpdate(target, encodeAwarenessUpdate(awareness, [awareness.clientID]), AGENT_ORIGIN);
  }
}
