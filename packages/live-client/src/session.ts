/**
 * openLiveSession — the ONE place a bpmiq client opens a collaborative session
 * against the Live Host. Previously this Hocuspocus wiring existed three times
 * (web editor, VS Code extension, headless guest test) with drift between them.
 *
 * Socket policy: one HocuspocusProviderWebsocket PER session, owned by the
 * session — exactly what every pre-extraction call site did (none shared a
 * socket across providers; the VS Code extension opens one socket per document).
 * destroy() therefore always tears down provider AND socket; the extension's
 * old dispose path destroyed only providers and leaked the sockets.
 */
import {
  AWARENESS_CANVAS_KEY,
  AWARENESS_USER_KEY,
  type CanvasPresence,
  CONTENT_KEY,
  type PresenceUser,
  roomName,
} from "@bpmiq/contracts/live";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type * as Y from "yjs";

// re-exported so session consumers don't need a second import for the contract
export { type CanvasPresence, CONTENT_KEY, type PresenceUser, roomName };

export interface LiveSessionOptions {
  /** WebSocket URL of the Live Host */
  url: string;
  /** room name — build it with roomName(repoFullName, repoRelativePath) */
  room: string;
  token: string;
  /** Node consumers pass the `ws` implementation; browsers omit it */
  WebSocketPolyfill?: unknown;
  onAuthenticationFailed?: (reason: string) => void;
}

/** the provider's awareness handle (y-protocols Awareness | null) */
export type LiveAwareness = HocuspocusProvider["awareness"];

/** one REMOTE client's awareness state */
export interface AwarenessPeer {
  clientId: number;
  user?: PresenceUser;
  canvas?: CanvasPresence;
}

// ── awareness payloads are PEER INPUT — shape-check at this boundary ────────
// (a hostile or version-skewed client can put arbitrary JSON into its fields;
// consumers must never see a malformed CanvasPresence)

/** exported for tests — the session applies it to every peer state */
export function sanitizeUser(raw: unknown): PresenceUser | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  if (typeof u.name !== "string" || typeof u.color !== "string") return undefined;
  return u as unknown as PresenceUser;
}

/** exported for tests — the session applies it to every peer state */
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

export interface LiveSession {
  readonly doc: Y.Doc;
  /** the ONE Y.Text carrying the document content (CONTENT_KEY) */
  readonly content: Y.Text;
  readonly awareness: LiveAwareness;
  /** event form — fires on every (re)sync; returns the unsubscribe */
  onSynced(cb: () => void): () => void;
  /** fires whenever the ws connection closes (the provider auto-reconnects
   *  and re-authenticates on its own); returns the unsubscribe */
  onDisconnect(cb: () => void): () => void;
  /** fires when the server closes THIS document over a still-open socket
   *  (doc-level CLOSE message, e.g. after rejecting an oversized update) —
   *  the provider does NOT auto-reconnect after it; returns the unsubscribe */
  onDocClose(cb: () => void): () => void;
  /** promise form — resolves on first sync, rejects on auth failure or timeout */
  whenSynced(timeoutMs?: number): Promise<void>;
  setUser(user: PresenceUser): void;
  /** publish the local canvas presence (cursor + selection, model coords) —
   *  its own awareness field, never colliding with y-monaco's "selection" */
  setCanvasPresence(presence: CanvasPresence | null): void;
  /** presence roster (awareness "user" fields); calls back immediately, returns the unsubscribe */
  onPresence(cb: (users: PresenceUser[]) => void): () => void;
  /** REMOTE awareness states (self excluded), clientId-keyed — the surface
   *  cursors/selections render from; calls back immediately, returns the
   *  unsubscribe */
  onAwarenessStates(cb: (peers: AwarenessPeer[]) => void): () => void;
  /** tears down provider AND socket — always both */
  destroy(): void;
}

export function openLiveSession(opts: LiveSessionOptions): LiveSession {
  const socket = new HocuspocusProviderWebsocket({
    url: opts.url,
    // only forward the polyfill when given — an explicit `undefined` would
    // override the provider's own browser-WebSocket default
    ...(opts.WebSocketPolyfill !== undefined ? { WebSocketPolyfill: opts.WebSocketPolyfill } : {}),
  });
  let authFailure: string | null = null;
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: opts.room,
    token: opts.token,
    onAuthenticationFailed: ({ reason }) => {
      authFailure = reason;
      opts.onAuthenticationFailed?.(reason);
    },
  });
  provider.attach();

  return {
    doc: provider.document,
    content: provider.document.getText(CONTENT_KEY),
    awareness: provider.awareness,

    onSynced(cb: () => void): () => void {
      provider.on("synced", cb);
      return () => provider.off("synced", cb);
    },

    onDisconnect(cb: () => void): () => void {
      provider.on("disconnect", cb);
      return () => provider.off("disconnect", cb);
    },

    onDocClose(cb: () => void): () => void {
      provider.on("close", cb);
      return () => provider.off("close", cb);
    },

    whenSynced(timeoutMs = 10_000): Promise<void> {
      if (authFailure !== null) return Promise.reject(new Error(`auth failed: ${authFailure}`));
      if (provider.synced) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const settle = (finish: () => void) => {
          clearTimeout(timer);
          provider.off("synced", onSync);
          provider.off("authenticationFailed", onAuthFailed);
          finish();
        };
        const onSync = () => settle(resolve);
        const onAuthFailed = ({ reason }: { reason: string }) =>
          settle(() => reject(new Error(`auth failed: ${reason}`)));
        const timer = setTimeout(() => settle(() => reject(new Error("Live Host sync timeout"))), timeoutMs);
        provider.on("synced", onSync);
        provider.on("authenticationFailed", onAuthFailed);
      });
    },

    setUser(user: PresenceUser): void {
      provider.setAwarenessField(AWARENESS_USER_KEY, user);
    },

    setCanvasPresence(presence: CanvasPresence | null): void {
      provider.setAwarenessField(AWARENESS_CANVAS_KEY, presence);
    },

    onPresence(cb: (users: PresenceUser[]) => void): () => void {
      // diff-gated: awareness "change" fires for EVERY field write — with live
      // cursors that is ~30/s per moving pointer, and an un-gated callback
      // would re-render a React consumer at that cadence for an unchanged
      // roster. Only a genuine roster change reaches the callback.
      let lastKey: string | undefined;
      const render = () => {
        const states = [...(provider.awareness?.getStates().values() ?? [])];
        const users = states
          .map((s) => sanitizeUser((s as { user?: unknown }).user))
          .filter((u): u is PresenceUser => u !== undefined);
        const key = JSON.stringify(users);
        if (key === lastKey) return;
        lastKey = key;
        cb(users);
      };
      provider.awareness?.on("change", render);
      render();
      return () => provider.awareness?.off("change", render);
    },

    onAwarenessStates(cb: (peers: AwarenessPeer[]) => void): () => void {
      // diff-gated like onPresence: our OWN cursor publishes fire "change"
      // too, but self is excluded from the output — without the gate every
      // local pointer move would re-run every consumer for identical data
      let lastKey: string | undefined;
      const render = () => {
        const awareness = provider.awareness;
        if (!awareness) return; // no awareness handle — nothing will ever fire
        const peers: AwarenessPeer[] = [];
        awareness.getStates().forEach((state, clientId) => {
          if (clientId === awareness.clientID) return; // self renders live, not via echo
          const s = state as { user?: unknown; canvas?: unknown };
          const user = sanitizeUser(s.user);
          const canvas = sanitizeCanvas(s.canvas);
          peers.push({ clientId, ...(user ? { user } : {}), ...(canvas ? { canvas } : {}) });
        });
        const key = JSON.stringify(peers);
        if (key === lastKey) return;
        lastKey = key;
        cb(peers);
      };
      provider.awareness?.on("change", render);
      render();
      return () => provider.awareness?.off("change", render);
    },

    destroy(): void {
      provider.destroy();
      socket.destroy();
    },
  };
}
