/** dmn-js ships no types — the slice of the Modeler API the editor uses */
declare module "dmn-js/lib/Modeler" {
  export interface DmnView {
    type: string;
    id?: string;
    name?: string;
  }
  export interface DmnViewer {
    get(service: string, strict?: boolean): unknown;
    on(event: string, cb: (...args: unknown[]) => void): void;
    off(event: string, cb: (...args: unknown[]) => void): void;
  }
  export default class DmnModeler {
    constructor(options: { container: HTMLElement });
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
