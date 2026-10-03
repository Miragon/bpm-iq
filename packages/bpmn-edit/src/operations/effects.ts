/** What the semantic operations leave for the geometry step to do. */
import type { Row } from "./types.ts";

export interface Placement {
  /** the created shape */
  readonly id: string;
  /** the shape it is placed next to */
  readonly anchor: string;
  readonly row: Row;
  /** inserted into a flow: the node it now precedes (the former target of the split flow) */
  readonly before?: string;
}

/** A node that changed its lane: its shape moves into the lane's band. */
export interface Relocation {
  readonly id: string;
  readonly lane: string;
}

/** The horizontal span a removed shape leaves in its plane. */
export interface Gap {
  readonly plane: string;
  readonly left: number;
  readonly right: number;
}

export interface Effects {
  /** created flow nodes that need a place */
  readonly placements: Placement[];
  /** nodes that moved into another lane */
  readonly relocations: Relocation[];
  /** flows to route (created or reconnected) */
  readonly routes: Set<string>;
  /** elements whose label needs a place (renamed, created) */
  readonly labels: Set<string>;
  /** every element the batch created or changed, in the order of the operations */
  readonly changed: Set<string>;
  readonly removed: Set<string>;
  /** spans of removed shapes, closed when nothing else occupies them */
  readonly gaps: Gap[];
  /** modelling hints the batch caused, e.g. a second flow into an element that is no gateway */
  readonly warnings: string[];
}

export function noEffects(): Effects {
  return {
    placements: [],
    relocations: [],
    routes: new Set(),
    labels: new Set(),
    changed: new Set(),
    removed: new Set(),
    gaps: [],
    warnings: [],
  };
}
