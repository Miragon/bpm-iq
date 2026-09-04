import { widgetConfig } from "./vite.widget.config.ts";

// the event storming modeler widget — served by the Live Host as the ui:// resource of
// open_event_storming_modeler (apps/live-host/src/http/mcp.ts widget registry)
export default widgetConfig("mcp-app-event-storming.html");
