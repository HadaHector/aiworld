import type { Rgb } from "../buildings/buildingTypes";

/**
 * A setting a prop generator takes, as its generator declares it (see propGenerators.ts) - so a
 * prop's file is read and checked the same way whatever its generator, and a new generator needs
 * nothing new in the content reader:
 *
 * - `range`: [lo, hi] metres (or any amount), rolled per prop;
 * - `count`: [lo, hi] whole numbers, rolled per prop;
 * - `chance`: 0-1, how likely something is;
 * - `number`: a fixed amount.
 */
export type PropParam =
  | { kind: "range"; default: [number, number] | null; min?: number; doc: string }
  | { kind: "count"; default: [number, number] | null; min?: number; doc: string }
  | { kind: "chance"; default: number | null; doc: string }
  | { kind: "number"; default: number | null; min?: number; max?: number; doc: string };

/** A prop's settings as read: each of its generator's params, by name. */
export type PropSettings = Record<string, number | [number, number]>;

/** What one of a prop's parts is painted: a building material (or none - a plain colour), and
 *  tints, one picked per prop. */
export interface PropPaint {
  material: string | null;
  tints: Rgb[];
}

/**
 * A prop (a pack's props/ folder): a thing set about a place - a log stack, a chopping block, a
 * barrel. Built by its generator from its settings, painted by part, the same kind of model a
 * building is (so it shares the buildings' materials, mesh and far detail).
 */
export interface PropDef {
  id: string;
  name: string;
  generator: string;
  settings: PropSettings;
  parts: Record<string, PropPaint>;
  /** Whether it is in the way - a stack, a barrel; not a scatter of chips. */
  collide: boolean;
}
