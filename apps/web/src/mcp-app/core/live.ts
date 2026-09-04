/**
 * The live upgrade: mint a single-use ws ticket over the bridge, open the
 * SAME Hocuspocus/Yjs session the web SPA uses (openLiveSession + the
 * engine's own live-client binding), and hand the canvas over to CRDT sync —
 * remote edits appear live, local edits persist continuously, no autosave
 * round-trips.
 *
 * Strictly progressive: if the host CSP blocks the socket, the ticket tool is
 * absent (read-only host), or the sync never arrives, we resolve undefined and
 * the caller stays on the bridge-autosave path. The widget must never be
 * broken by a host that doesn't honour connectDomains.
 *
 * Two hooks keep the hand-over lossless: beforeBind flushes unsaved canvas
 * state BEFORE the first Yjs import replaces the canvas, and onDead reports a
 * post-upgrade death — the ticket is single-use, so the provider's automatic
 * reconnect re-sends a consumed token and can never re-authenticate; the
 * caller must re-mint a ticket or fall back to autosave.
 *
 * Moved from mcp-app/live.ts (#156): the App became an injected mint(), the
 * session opener is injectable (the node --test suite fakes the socket), and
 * the one bpmn-specific line — bindBpmn — became the engine's bindLive.
 */
import { openLiveSession } from "@bpmiq/live-client";

import type { LiveEngine } from "./engine.ts";
import type { LiveHandle, LiveHooks } from "./lifecycle.ts";

export const SYNC_TIMEOUT_MS = 6000;

export interface WsTicket {
  ticket: string;
  url: string;
  room: string;
  expiresInSeconds: number;
}

/** what tryLive uses of a live-client session — the test fakes exactly this */
export type LiveSessionLike = Pick<
  ReturnType<typeof openLiveSession>,
  "doc" | "content" | "onSynced" | "onDisconnect" | "onDocClose" | "destroy"
>;

export interface LiveDeps {
  /** mint_ws_ticket over the bridge — a throw (tool absent on a read-only
   *  host, denied) means "stay on autosave" */
  mint(): Promise<WsTicket>;
  /** openLiveSession — injectable so the tests fake the socket */
  open?: (opts: Parameters<typeof openLiveSession>[0]) => LiveSessionLike;
  /** default SYNC_TIMEOUT_MS */
  syncTimeoutMs?: number;
}

export type TryLiveHooks = LiveHooks;

export async function tryLive(
  deps: LiveDeps,
  engine: LiveEngine,
  hooks: TryLiveHooks,
): Promise<LiveHandle | undefined> {
  let ticket: WsTicket;
  try {
    ticket = await deps.mint();
  } catch {
    return undefined; // tool absent (read-only host) or denied — stay on autosave
  }
  const open = deps.open ?? openLiveSession;
  const syncTimeoutMs = deps.syncTimeoutMs ?? SYNC_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let established = false; // a handle was handed out — deaths go to onDead
    let dead = false;
    let upgrading = false; // onSynced fires on every (re)sync — upgrade once
    let brokenDuringUpgrade = false; // drop/doc-close between sync and bind
    function die(): void {
      if (dead) return;
      dead = true;
      hooks.onDead();
    }
    // a break between sync and bind must abort the upgrade, not establish a
    // handle on a dead transport (the "sync arrived, the ws works" assumption
    // is stale once the flush round-trips have run)
    function broke(): void {
      if (established) die();
      else if (upgrading) brokenDuringUpgrade = true;
    }
    const session = open({
      url: ticket.url,
      room: ticket.room,
      token: ticket.ticket,
      onAuthenticationFailed: () => {
        if (established) {
          die();
          return;
        }
        finish(undefined);
      },
    });
    // post-upgrade, a drop IS the death — don't wait for the reconnect to
    // reach the server and be refused; if it never reaches it (host down,
    // user offline), the auth failure would never fire and the widget would
    // keep claiming live sync while edits pile up in the local doc only.
    // Pre-sync drops are the provider's normal retry dance — ignored.
    session.onDisconnect(broke);
    // the server can also close just THIS document over a live socket (e.g.
    // it rejected an oversized update) — no reconnect follows, so it is a
    // death too, not a drop
    session.onDocClose(broke);
    const timer = setTimeout(() => finish(undefined), syncTimeoutMs);

    function finish(handle: LiveHandle | undefined): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!handle) session.destroy();
      resolve(handle);
    }

    session.onSynced(() => {
      if (settled || upgrading) return;
      upgrading = true;
      // sync arrived, the ws works — don't let the flush (bridge save
      // round-trips) race the connect timeout
      clearTimeout(timer);
      void (async () => {
        const proceed = await hooks.beforeBind().catch(() => false);
        if (settled) return; // auth died during the flush — session is gone
        if (!proceed || brokenDuringUpgrade) {
          finish(undefined);
          return;
        }
        // the Y.Text is the source of truth from here on — the engine's
        // binding imports it and keeps both directions in sync (the web
        // SPA's exact mechanism)
        const unbind = engine.bindLive(session.content, session.doc, {
          onConflict: hooks.onConflict,
          onImportError: hooks.onImportError,
        });
        established = true;
        finish({
          snapshot: () => session.content.toString(),
          destroy() {
            dead = true; // a deliberate teardown must not report a death
            unbind();
            session.destroy();
          },
        });
      })();
    });
  });
}
