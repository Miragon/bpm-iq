/**
 * The MCP tool-result codec — ONE definition of the wire convention the two
 * bpmiq MCP servers emit and the widget client decodes. It existed as three
 * copies before ("packages/mcp/tools.ts house style" said one of them out
 * loud): packages/mcp, the Live Host's /mcp, and the widget bridge's decoder.
 *
 * Browser-safe on purpose (zero imports): the widget bundles value-import this
 * entry. The node-only transport mount lives behind ./mount.
 */

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** a successful tool result: strings pass through, everything else is
 *  pretty-printed JSON in the first text block */
export const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/** an errored tool result — `message` must be agent-actionable text */
export const fail = (message: string): ToolResult => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

/**
 * Wrap a tool handler: thrown errors become `fail(...)` results. The prefix is
 * a deliberate per-server policy, not an accident of the old copies: the Live
 * Host passes none (its AppErrors carry actionable, agent-readable messages —
 * validation findings, conflict guidance, authz denials), the read-only server
 * marks everything unexpected.
 */
export const safe =
  // eslint-safe any: the SDK validates args against the zod shape before the handler runs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn: (args: any) => unknown, opts: { prefix?: string } = {}) =>
    async (args: unknown): Promise<ToolResult> => {
      try {
        return (await fn(args ?? {})) as ToolResult;
      } catch (err) {
        return fail(`${opts.prefix ?? ""}${(err as Error).message}`);
      }
    };

/** tool annotations: repo-local read */
export const READ = { readOnlyHint: true, openWorldHint: false } as const;
/** tool annotations: repo-local write */
export const WRITE = { readOnlyHint: false, openWorldHint: false } as const;

/**
 * Client-side inverse of `ok()`: first text block, parsed as JSON; a tool
 * `isError` becomes a throw carrying the server's message verbatim.
 *
 * JSON-only BY CONTRACT: the Live Host always returns JSON, but the read-only
 * server deliberately answers some empty results with prose — results from
 * THOSE tools must not go through this.
 */
export function unwrapToolResult<T>(
  result: { content?: Array<{ type: string; text?: string }>; isError?: boolean },
  name: string,
): T {
  const text = result.content?.find((c): c is { type: "text"; text: string } => c.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text || `${name} failed`);
  return JSON.parse(text) as T;
}

/** "capability absent on this host" (hide the UI) vs a real tool error (show
 *  it). There is no tools/list over the MCP-App bridge, so absence is detected
 *  on the first call — by the host's not-found message naming the tool. */
export const isMissingTool = (err: unknown, tool: string): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(tool) && /not found/i.test(message);
};
