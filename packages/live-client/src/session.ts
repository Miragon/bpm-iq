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
import { CONTENT_KEY, roomName } from "@bpmiq/contracts/live";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type * as Y from "yjs";

// re-exported so session consumers don't need a second import for the contract
export { CONTENT_KEY, roomName };

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

export interface PresenceUser {
  name: string;
  color: string;
}

/** the provider's awareness handle (y-protocols Awareness | null) */
export type LiveAwareness = HocuspocusProvider["awareness"];

export interface LiveSession {
  readonly doc: Y.Doc;
  /** the ONE Y.Text carrying the document content (CONTENT_KEY) */
  readonly content: Y.Text;
  readonly awareness: LiveAwareness;
  /** event form — fires on every (re)sync; returns the unsubscribe */
  onSynced(cb: () => void): () => void;
  /** promise form — resolves on first sync, rejects on auth failure or timeout */
  whenSynced(timeoutMs?: number): Promise<void>;
  setUser(user: PresenceUser): void;
  /** presence roster (awareness "user" fields); calls back immediately, returns the unsubscribe */
  onPresence(cb: (users: PresenceUser[]) => void): () => void;
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
      provider.setAwarenessField("user", user);
    },

    onPresence(cb: (users: PresenceUser[]) => void): () => void {
      const render = () => {
        const states = [...(provider.awareness?.getStates().values() ?? [])];
        cb(states.map((s) => (s as { user?: PresenceUser }).user).filter((u): u is PresenceUser => !!u));
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
