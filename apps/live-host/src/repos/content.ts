/**
 * The content-repo contract (bpmiq.yml) lives in @bpmiq/notations/content — the
 * ONE definition shared by the Live Host, the MCP server and the validator.
 * Re-exported here so the existing live-host import paths stay stable.
 */
export {
  buildRepoIndex,
  CONTENT_CONFIG_FILE,
  CONTENT_CONFIG_FILES,
  type ContentConfig,
  type ContentConfigConflict,
  contentConfigConflict,
  discoverDecisions,
  type DiscoveredDecision,
  type DiscoveredModel,
  type DiscoveredProcess,
  discoverModels,
  discoverProcesses,
  hasContentConfig,
  loadContentConfig,
  type RepoIndex,
  resolveContentConfigFile,
  type ResolvedReference,
} from "@bpmiq/notations/content";
