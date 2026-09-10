/**
 * Short-lived, single-use sign-in codes for EDITOR logins (the VS Code
 * extension — http/editor-login.ts).
 *
 * The browser completes the provider's OAuth dance, but the credential must
 * end up in the editor, not in a browser cookie: the callback hands the editor
 * a CODE through its custom URI scheme instead of the session id. The code is
 * worth exactly one POST /auth/exchange within a minute — a URL lingering in a
 * browser history or a URI-handler log is dead by then. Same construction as
 * the ws tickets (ws-tickets.ts): derived from a session that already exists,
 * carrying less authority than it (one use, one minute), in-memory on purpose
 * (one process per cell, ADR 0002 — a restart costs one retry).
 */
import { randomBytes } from "node:crypto";

const TTL_MS = 60_000;

export class LoginCodeStore {
  private readonly codes = new Map<string, { sessionId: string; expiresAt: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  issue(sessionId: string): string {
    // opportunistic sweep — the map only ever holds a minute's worth of codes
    for (const [c, v] of this.codes) if (v.expiresAt <= this.now()) this.codes.delete(c);
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { sessionId, expiresAt: this.now() + TTL_MS });
    return code;
  }

  /** single-use: a code dies on its first presentation, valid or expired */
  redeem(code: string): string | undefined {
    const hit = this.codes.get(code);
    if (!hit) return undefined;
    this.codes.delete(code);
    if (hit.expiresAt <= this.now()) return undefined;
    return hit.sessionId;
  }
}
