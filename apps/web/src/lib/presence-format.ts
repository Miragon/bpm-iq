/**
 * Presence payload sanitizers — awareness states arrive from REMOTE peers and
 * are UNTRUSTED input (any authenticated client can put arbitrary strings into
 * its awareness fields). Everything presence-rendered goes through here:
 * colors land in generated CSS text (injection surface), names in CSS
 * `content` strings and SVG labels, avatar urls in an <img src>.
 */

/** hex colors only — anything else could smuggle CSS past a generated rule */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const FALLBACK_PRESENCE_COLOR = "#71717a";

export function safePresenceColor(color: unknown): string {
  return typeof color === "string" && HEX_COLOR.test(color) ? color : FALLBACK_PRESENCE_COLOR;
}

/** display label: control chars and CSS-string breakers stripped, length capped */
export function safePresenceLabel(name: unknown): string {
  if (typeof name !== "string") return "?";
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f\\"]/g, "").trim();
  return clean === "" ? "?" : clean.slice(0, 24);
}

/** hosts a roster avatar may load from — the identity providers the platform
 *  logs in with, plus the page's own origin (self-hosted proxies). Anything
 *  else falls back to initials: a peer-chosen <img src> fetches on every
 *  co-editor's machine, i.e. an IP/timing beacon to an arbitrary host. */
const AVATAR_HOSTS = /(^|\.)githubusercontent\.com$|(^|\.)workoscdn\.com$/;

export function safeAvatarUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url, location.origin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.origin === location.origin || AVATAR_HOSTS.test(parsed.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** `#rrggbb` → `rgba(r,g,b,alpha)` — selection washes need transparency and
 *  the sanitizer guarantees hex input */
export function withAlpha(hexColor: string, alpha: number): string {
  const hex = safePresenceColor(hexColor).slice(1);
  const size = hex.length === 3 || hex.length === 4 ? 1 : 2;
  const channel = (i: number): number => parseInt(hex.slice(i * size, (i + 1) * size).padEnd(2, hex[i * size]!), 16);
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${alpha})`;
}
