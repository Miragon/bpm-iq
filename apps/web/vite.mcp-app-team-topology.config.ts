import { widgetConfig } from "./vite.widget.config.ts";

// the team topology modeler widget — served by the Live Host as the ui:// resource of
// open_team_topology_modeler (apps/live-host/src/http/mcp.ts widget registry)
export default widgetConfig("mcp-app-team-topology.html");
