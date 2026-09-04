import { widgetConfig } from "./vite.widget.config.ts";

// the context map modeler widget — served by the Live Host as the ui:// resource of
// open_context_map_modeler (apps/live-host/src/http/mcp.ts widget registry)
export default widgetConfig("mcp-app-context-map.html");
