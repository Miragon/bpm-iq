import { widgetConfig } from "./vite.widget.config.ts";

// the Wardley map modeler widget — served by the Live Host as the ui:// resource of
// open_wardley_modeler (apps/live-host/src/http/mcp.ts widget registry)
export default widgetConfig("mcp-app-wardley.html");
