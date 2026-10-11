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
  /** How it meets the ground: `level` - the ground under it levelled to it (a stack, a crate) - or
   *  `slope` - lying on the ground as it is, tilted to it (a felled log). */
  ground: "level" | "slope";
  /** The ground round it painted with a material of its own, or none (see Spill). */
  spill: Spill | null;
  /** How it is set down in a room (see FURNITURE.md). */
  mount: Mount;
  /** The light it gives, or none (see LIGHTS.md) - where, its generator says. */
  light: PropLight | null;
  /** What it says to a player standing by it, or nothing: `place` - the name of the place it is set
   *  down for (a wayside sign, its inn's name). */
  label: PropLabel | null;
}

export const PROP_LABELS = ["place"] as const;
export type PropLabel = (typeof PROP_LABELS)[number];

/**
 * The light a prop gives - a fire, a lantern, a candle: its colour, its strength, how far it reaches
 * (metres, where it falls to nothing), and how big its source is (metres across - a candle's flame,
 * a fire's bed: what softens its shadows). Where it burns, the prop's generator says
 * (PropContext.light), as it builds the flame.
 */
export interface PropLight {
  color: Rgb;
  intensity: number;
  radius: number;
  size: number;
}

/**
 * How a prop is set down in a room: on the `floor` (the default), on a `wall` - its back flat on it,
 * `height` metres up from the floor (rolled) - or hung from the `ceiling`, its top against it.
 */
export interface Mount {
  kind: "floor" | "wall" | "ceiling";
  height: [number, number];
}

/**
 * The ground round a prop or building painted with a material of its own - sawdust round a sawbuck,
 * chips round a chopping block: over everything else there, fading out `reach` metres past its
 * footprint, its edge frayed (see features/spill.ts).
 */
export interface Spill {
  /** A ground material (a pack's materials/ folder). */
  material: string;
  reach: number;
}

/**
 * One member of a prop group: a prop, where it stands in the group (x, z metres, the group's front
 * toward +z) - or `on` an earlier member, standing on its top - turned by `turn` (degrees, rolled),
 * made with `chance` (a member on one left out is left out too).
 */
export interface GroupMember {
  prop: PropDef;
  at: [number, number];
  on: number | null;
  turn: [number, number];
  chance: number;
}

/**
 * A group of props (a pack's propGroups/ folder) set down together - a pile of crates and barrels,
 * a sawbuck by a log stack: its members as a list, each placed relative to the group. Each member
 * is its own prop, built and drawn on its own; the group only says where they stand.
 */
export interface PropGroupDef {
  id: string;
  name: string;
  members: GroupMember[];
}
