/**
 * The MCP-App tool names — ONE derivation for the two surfaces that must
 * agree on them: the Live Host registers `open_<notation>_modeler` per served
 * widget (apps/live-host/src/http/mcp.ts) and the SPA's "Analyse with AI"
 * doorway names the same tool in its first prompt line (assist.ts).
 *
 * bpmn and dmn keep their wire-pinned names (open_modeler /
 * open_decision_modeler — clients and docs know them); every later notation
 * is born generated from its registry id (`-` → `_`, MCP tool names allow no
 * dashes in some hosts' tool-name grammar). Own-property gated: a bare lookup
 * would resolve "toString" and friends off the prototype chain.
 */
const PINNED: Record<string, string> = {
  bpmn: "open_modeler",
  dmn: "open_decision_modeler",
};

export function mcpAppToolName(notation: string): string {
  return Object.hasOwn(PINNED, notation) ? PINNED[notation]! : `open_${notation.replaceAll("-", "_")}_modeler`;
}
