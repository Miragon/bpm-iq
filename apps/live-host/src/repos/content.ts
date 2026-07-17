/**
 * The content-repo contract (bpmiq.yml) lives in @bpmiq/notations/content — the
 * ONE definition shared by the Live Host, the MCP server and the validator.
 * Re-exported here so the existing live-host import paths stay stable.
 */
export {
  CONTENT_CONFIG_FILE,
  type ContentConfig,
  type DiscoveredProcess,
  discoverProcesses,
  loadContentConfig,
} from "@bpmiq/notations/content";
