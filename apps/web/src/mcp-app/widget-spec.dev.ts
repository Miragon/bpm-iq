/**
 * The dev-server resolution of `@/mcp-app/widget-spec` (vite.config.ts): the
 * renderer spec named in the query string — `/mcp-app-miragon.html?notation=<id>`
 * previews any Miragon widget without a Live Host (a raw boot marker means
 * editable, this origin as the deep-link base — bridge.ts bootConfig). Never
 * part of a production bundle: those alias the spec statically, so exactly
 * one renderer is inlined.
 */
import { MIRAGON_RENDERERS } from "@/notations/miragon";

const wanted = new URLSearchParams(window.location.search).get("notation");

export const spec = MIRAGON_RENDERERS.find((s) => s.id === wanted) ?? MIRAGON_RENDERERS[0]!;
