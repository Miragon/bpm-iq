/** dmn-js ships no types — the slice of its API the editor and the decision
 *  widget use. Per-view options carry the additionalModules the simulation
 *  add-on is mounted through (@emaarco/dmn-js-simulation). */
declare module "dmn-js/lib/Modeler" {
  export interface DmnView {
    /** "drd" | "decisionTable" | "literalExpression" */
    type: string;
    id?: string;
    name?: string;
    /** the moddle element the view renders (a decision, for a table view) */
    element?: { id?: string; name?: string };
  }
  export interface DmnViewer {
    get(service: string, strict?: boolean): unknown;
    on(event: string, cb: (...args: unknown[]) => void): void;
    off(event: string, cb: (...args: unknown[]) => void): void;
  }
  /** one per view kind: drd, decisionTable, literalExpression */
  export interface DmnViewOptions {
    additionalModules?: unknown[];
  }
  export interface DmnOptions {
    container: HTMLElement;
    drd?: DmnViewOptions;
    decisionTable?: DmnViewOptions;
    literalExpression?: DmnViewOptions;
  }
  export default class DmnModeler {
    constructor(options: DmnOptions);
    importXML(xml: string): Promise<{ warnings: string[] }>;
    saveXML(options?: { format?: boolean }): Promise<{ xml?: string }>;
    getActiveView(): DmnView | null;
    getActiveViewer(): DmnViewer | null;
    getViews(): DmnView[];
    open(view: DmnView): Promise<unknown>;
    on(event: string, cb: (event: never) => void): void;
    off(event: string, cb: (event: never) => void): void;
    destroy(): void;
  }
}

declare module "dmn-js/lib/Viewer" {
  import type { DmnOptions, DmnView, DmnViewer } from "dmn-js/lib/Modeler";
  /** the read-only surface (LIVE_MCP_READONLY): no saveXML, no editing */
  export default class DmnViewerManager {
    constructor(options: DmnOptions);
    importXML(xml: string): Promise<{ warnings: string[] }>;
    getActiveView(): DmnView | null;
    getActiveViewer(): DmnViewer | null;
    getViews(): DmnView[];
    open(view: DmnView): Promise<unknown>;
    on(event: string, cb: (event: never) => void): void;
    off(event: string, cb: (event: never) => void): void;
    destroy(): void;
  }
}
