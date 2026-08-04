/**
 * The live upgrade: mint a single-use ws ticket over the bridge, open the
 * SAME Hocuspocus/Yjs session the web SPA uses (openLiveSession + bindBpmn),
 * and hand the modeler over to CRDT sync — remote edits appear live, local
 * edits persist continuously, no autosave round-trips.
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
 */
import { openLiveSession } from "@bpmiq/live-client";
import { bindBpmn } from "@bpmiq/live-client/bpmn-sync";
import type { App } from "@modelcontextprotocol/ext-apps";

import { mintWsTicket, type ProcessRef } from "./bridge";
import type { ModelerHandle } from "./modeler";

const SYNC_TIMEOUT_MS = 6000;

export interface LiveHandle {
  destroy(): void;
  /** the room state this session last knew (its local Y.Text replica) — the
   *  caller's post-death reconcile compares it against a fresh bridge read */
  snapshot(): string;
}

export interface TryLiveHooks {
  /** overlapping concurrent edit — the remote change won (model-sync rule 4) */
  onConflict(message: string): void;
  /** runs after sync, before the first Yjs import replaces the canvas — flush
   *  unsaved state through the bridge here; false aborts the upgrade */
  beforeBind(): Promise<boolean>;
  /** the ESTABLISHED session died: any ws drop is final, because the
   *  auto-reconnect re-sends the consumed single-use ticket and can never
   *  re-authenticate; fires at most once per session */
  onDead(): void;
}

export async function tryLive(
  app: App,
  ref: ProcessRef,
  modeler: ModelerHandle,
  hooks: TryLiveHooks,
): Promise<LiveHandle | undefined> {
  let ticket: Awaited<ReturnType<typeof mintWsTicket>>;
  try {
    ticket = await mintWsTicket(app, ref);
  } catch {
    return undefined; // tool absent (read-only host) or denied — stay on autosave
  }
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
    const session = openLiveSession({
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
    const timer = setTimeout(() => finish(undefined), SYNC_TIMEOUT_MS);

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
        // the Y.Text is the source of truth from here on — bindBpmn imports it
        // and keeps both directions in sync (the web SPA's exact mechanism)
        const unbind = bindBpmn(modeler.raw as never, session.content, session.doc, hooks.onConflict);
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
