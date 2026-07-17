/** bpmn-js-differ ships no types — the ChangeHandler result, keyed by element id */
declare module "bpmn-js-differ" {
  export interface DiffResult {
    _added: Record<string, unknown>;
    _removed: Record<string, unknown>;
    _changed: Record<string, unknown>;
    _layoutChanged: Record<string, unknown>;
  }
  /** a/b are bpmn-moddle definitions (BaseViewer#getDefinitions) */
  export function diff(a: unknown, b: unknown): DiffResult;
}
