/**
 * Builds every MCP-App widget bundle into dist/ (after `vite build` built the
 * SPA): the two bespoke entries (bpmn and dmn keep their own HTML — the todo
 * and the tests side panels) and ONE Miragon-renderer bundle per spec in
 * src/notations/miragon — the list derives from the registry, so a new
 * Miragon notation needs no entry here. Plain Node (type stripping):
 * `node scripts/build-widgets.ts`, wired into package.json's `build`.
 */
import { build } from "vite";

import { MIRAGON_RENDERERS } from "../src/notations/miragon/index.ts";
import { miragonWidgetConfig, widgetConfig } from "../vite.widget.config.ts";

const configs = [
  widgetConfig("mcp-app.html"),
  widgetConfig("mcp-app-dmn.html"),
  ...MIRAGON_RENDERERS.map(miragonWidgetConfig),
];

for (const config of configs) {
  await build({ ...config, configFile: false });
}
