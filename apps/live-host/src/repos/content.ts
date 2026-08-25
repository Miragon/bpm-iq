/**
 * The content-repo contract (bpmiq.yml) lives in @bpmiq/notations/content — the
 * ONE definition shared by the Live Host, the MCP server and the validator.
 * Re-exported here so the existing live-host import paths stay stable.
 */
export {
  buildRepoIndex,
  CONTENT_CONFIG_FILE,
  type ContentConfig,
  discoverDecisions,
  type DiscoveredDecision,
  type DiscoveredModel,
  type DiscoveredProcess,
  discoverModels,
  discoverProcesses,
  loadContentConfig,
  type RepoIndex,
  type ResolvedReference,
} from "@bpmiq/notations/content";
