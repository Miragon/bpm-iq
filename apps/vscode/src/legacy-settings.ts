/**
 * The one-time settings carry-over from the side-loaded dev builds that
 * predate the rename: they kept the host URL under the old section, which
 * nothing registers any more. vscode's inspect() still reports the raw values
 * of an unregistered key, so activation copies them to the new key — pure
 * (no vscode API) so the decision is unit-tested
 * (src/test/unit/legacy-settings.test.ts); extension.ts does the writing.
 */

/** the section the dev builds used — read only, never written */
export const LEGACY_SECTION = "bpmLive"; // legacy-name-ok: settings.json key of pre-rename dev builds

/** the per-target values of one setting, as configuration.inspect() reports
 *  them — only the targets a "window"-scoped setting can be written to */
export interface TargetValues<T> {
  globalValue?: T;
  workspaceValue?: T;
}

export type Target = "global" | "workspace";

/** what to copy where: per target, the legacy value — only where the old key
 *  holds one and the new key holds none (a value set since always wins) */
export function legacyCopies<T>(
  legacy: TargetValues<T> | undefined,
  current: TargetValues<T> | undefined,
): { target: Target; value: T }[] {
  const copies: { target: Target; value: T }[] = [];
  if (legacy?.globalValue !== undefined && current?.globalValue === undefined) {
    copies.push({ target: "global", value: legacy.globalValue });
  }
  if (legacy?.workspaceValue !== undefined && current?.workspaceValue === undefined) {
    copies.push({ target: "workspace", value: legacy.workspaceValue });
  }
  return copies;
}
