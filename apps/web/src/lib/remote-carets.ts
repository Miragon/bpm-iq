/**
 * Remote Monaco carets (#115) — y-monaco already decorates every remote
 * peer's cursor and selection with `.yRemoteSelection-<clientId>` /
 * `.yRemoteSelectionHead-<clientId>` classes, but ships NO styling for them:
 * without this sheet remote carets are invisible. One injected <style>
 * element carries a rule set per peer, colored from the peer's presence and
 * labeled with their name; peers come pre-sanitized (presence-format) because
 * awareness payloads are remote input landing in CSS text.
 */
import type { PresenceUser } from "@bpmiq/contracts/live";

import { safePresenceColor, safePresenceLabel, withAlpha } from "@/lib/presence-format";

export interface RemoteCaretStyles {
  update(peers: ReadonlyArray<{ clientId: number; user: PresenceUser }>): void;
  destroy(): void;
}

// shared shape of every caret head; per-peer rules add only color and label
const BASE_RULES = `
[class*="yRemoteSelectionHead-"] {
  position: absolute;
  box-sizing: border-box;
  height: 100%;
}
[class*="yRemoteSelectionHead-"]::after {
  position: absolute;
  top: -1.15em;
  left: -2px;
  padding: 0 4px;
  border-radius: 3px 3px 3px 0;
  font-size: 10px;
  line-height: 1.15em;
  font-family: system-ui, sans-serif;
  white-space: nowrap;
  color: #fff;
  pointer-events: none;
  z-index: 10;
}
`;

export function createRemoteCaretStyles(): RemoteCaretStyles {
  const sheet = document.createElement("style");
  sheet.dataset.bpmRemoteCarets = "";
  document.head.appendChild(sheet);
  let lastCss = "";

  return {
    update(peers) {
      const rules = [BASE_RULES];
      for (const peer of peers) {
        // clientId is numeric by the awareness protocol — coerce defensively,
        // a non-finite value must never break out of the selector
        const id = Number(peer.clientId);
        if (!Number.isFinite(id)) continue;
        const color = safePresenceColor(peer.user.color);
        const label = safePresenceLabel(peer.user.name);
        rules.push(
          `.yRemoteSelection-${id} { background-color: ${withAlpha(color, 0.25)}; }`,
          `.yRemoteSelectionHead-${id} { border-left: 2px solid ${color}; }`,
          `.yRemoteSelectionHead-${id}::after { content: "${label}"; background: ${color}; }`,
        );
      }
      // reassigning textContent re-parses the whole sheet even for identical
      // text — and update() runs on every awareness tick (cursor moves): only
      // touch the DOM when a caret-relevant value (clientId/color/name) changed
      const css = rules.join("\n");
      if (css === lastCss) return;
      lastCss = css;
      sheet.textContent = css;
    },
    destroy() {
      sheet.remove();
    },
  };
}
