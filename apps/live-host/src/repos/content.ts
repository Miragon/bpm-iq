/**
 * The content-repo contract (designiq.yml) lives in @designiq/notations/content — the
 * ONE definition shared by the Live Host, the MCP server and the validator.
 * Re-exported here so the existing live-host import paths stay stable.
 */
export {
  buildRepoIndex,
  CONTENT_CONFIG_FILE,
  CONTENT_CONFIG_FILES,
  CONTENT_CONFIG_NAMES,
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
  legacyContentConfigFile,
  loadContentConfig,
  notAContentRepoReason,
  type RepoIndex,
  resolveContentConfigFile,
  type ResolvedReference,
} from "@designiq/notations/content";
