// Minimal ambient declaration for bpmn-moddle: the package ships no types for its root export. Only what this package
// reads is declared (semantic elements, the platform extensions of the adapters, the DI of every plane). Node executes
// the .ts through type stripping; this file only serves `tsc --noEmit`.
declare module "bpmn-moddle" {
  export interface ModdlePoint {
    readonly x: number;
    readonly y: number;
  }

  export interface ModdleBounds extends ModdlePoint {
    readonly width: number;
    readonly height: number;
  }

  /**
   * A moddle element (business object, extension or DI element). Dynamic by nature, so only the used fields are
   * typed; the fields the operations and the layout write are mutable.
   */
  export interface ModdleElement {
    readonly $type: string;
    $parent?: ModdleElement;
    /** attributes no loaded descriptor knows, by their qualified name */
    $attrs?: Record<string, string>;
    /** a property by its qualified name (`camunda:decisionRef`), typed or not — its type is the descriptor's */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- moddle properties are dynamic
    get(name: string): any;
    set(name: string, value: unknown): void;
    id?: string;
    name?: string;
    // semantic model
    rootElements?: ModdleElement[];
    flowElements?: ModdleElement[];
    readonly participants?: ModdleElement[];
    readonly processRef?: ModdleElement;
    laneSets?: ModdleElement[];
    lanes?: ModdleElement[];
    flowNodeRef?: ModdleElement[];
    readonly childLaneSet?: ModdleElement;
    extensionElements?: ModdleElement;
    documentation?: ModdleElement[];
    values?: ModdleElement[];
    eventDefinitions?: ModdleElement[];
    attachedToRef?: ModdleElement;
    cancelActivity?: boolean;
    sourceRef?: ModdleElement;
    targetRef?: ModdleElement;
    incoming?: ModdleElement[];
    outgoing?: ModdleElement[];
    default?: ModdleElement;
    conditionExpression?: ModdleElement;
    body?: string;
    errorRef?: ModdleElement;
    readonly messageRef?: ModdleElement;
    readonly signalRef?: ModdleElement;
    errorCode?: string;
    readonly timeDate?: ModdleElement;
    readonly timeDuration?: ModdleElement;
    readonly timeCycle?: ModdleElement;
    // platform extensions (Camunda 7 and 8)
    modelerTemplate?: string;
    modelerTemplateVersion?: number | string;
    readonly type?: string;
    inputParameters?: ModdleElement[];
    outputParameters?: ModdleElement[];
    source?: string;
    target?: string;
    key?: string;
    value?: string;
    processId?: string;
    decisionId?: string;
    propagateAllChildVariables?: boolean;
    calledElement?: string;
    // bpmiq stickies (on the extension elements of a process)
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    readonly resultVariable?: string;
    readonly formId?: string;
    readonly externalReference?: string;
    readonly expression?: string;
    readonly assignee?: string;
    readonly candidateGroups?: string;
    readonly candidateUsers?: string;
    // DI
    readonly diagrams?: ModdleElement[];
    readonly plane?: ModdleElement;
    planeElement?: ModdleElement[];
    bpmnElement?: ModdleElement;
    bounds?: ModdleBounds;
    label?: ModdleElement;
    waypoint?: ModdlePoint[];
    readonly isExpanded?: boolean;
  }

  export type ModdleAttributes = Record<
    string,
    string | number | boolean | ModdleElement | ModdleElement[] | undefined
  >;

  export class BpmnModdle {
    constructor(packages?: Record<string, object>);
    fromXML(xml: string): Promise<{ rootElement: ModdleElement; warnings: { message: string }[] }>;
    create(type: "dc:Bounds", attrs: ModdleBounds): ModdleBounds;
    create(type: "dc:Point", attrs: ModdlePoint): ModdlePoint;
    create(type: string, attrs?: ModdleAttributes): ModdleElement;
    toXML(element: ModdleElement, options?: { format?: boolean }): Promise<{ xml: string }>;
  }
}
