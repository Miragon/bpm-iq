/**
 * `@/mcp-app/widget-spec` — the renderer spec of the Miragon widget being
 * built. A build-time seam, not a module: vite.widget.config.ts
 * (miragonWidgetConfig) aliases it to src/notations/miragon/<id>.ts per
 * single-file bundle, and vite.config.ts (the dev server) to
 * ./widget-spec.dev.ts. This declaration is what tsc sees.
 */
import type { MiragonRendererSpec } from "../notations/miragon/spec.ts";

export const spec: MiragonRendererSpec;
