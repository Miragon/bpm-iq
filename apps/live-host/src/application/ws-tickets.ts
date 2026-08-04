/**
 * Short-lived, single-use WebSocket tickets for the MCP-App modeler widget.
 *
 * The widget iframe holds NO credential (bridge tool calls ride the host's
 * authenticated backend; the OAuth token never reaches the iframe), so it
 * cannot pass the ws onAuthenticate gate (session id / dev token). The
 * mint_ws_ticket tool closes that gap: an ALREADY-AUTHENTICATED caller whose
 * per-repo write access was just checked (requireRepo) mints a ticket bound
 * to exactly one room, redeemable exactly once, for a few seconds.
 *
 * This is deliberately NOT the broker session-mint ADR 0005 rejected: no
 * static secret, no identity assertion — the ticket DERIVES from a live
 * authenticated session and carries less authority than it (one room, one
 * use, ~1 minute). Authorization ran at mint time; the redeem window is far
 * shorter than the AccessCache TTL, so no re-check on redeem.
 *
 * In-memory on purpose: the Live Host is one process (ADR 0002 — a cell), and
 * a lost ticket on restart costs one retry.
 */
import { randomBytes } from "node:crypto";

/** what onAuthenticate returns as `user` — mirrors Session["user"] */
export interface TicketUser {
  login: string;
  name: string;
  avatarUrl: string | null;
  provider: string;
}

const TTL_MS = 60_000;

export class WsTicketStore {
  private readonly tickets = new Map<string, { user: TicketUser; room: string; expiresAt: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  issue(user: TicketUser, room: string): string {
    // opportunistic sweep — the map only ever holds seconds' worth of tickets
    for (const [t, v] of this.tickets) if (v.expiresAt <= this.now()) this.tickets.delete(t);
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { user, room, expiresAt: this.now() + TTL_MS });
    return ticket;
  }

  /** single-use: a hit is consumed even when the room does not match — a
   *  replayed or misdirected ticket must die, not survive for a second try */
  redeem(ticket: string, room: string): TicketUser | undefined {
    const hit = this.tickets.get(ticket);
    if (!hit) return undefined;
    this.tickets.delete(ticket);
    if (hit.expiresAt <= this.now()) return undefined;
    if (hit.room !== room) return undefined;
    return hit.user;
  }
}
