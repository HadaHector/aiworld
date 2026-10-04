import type { TextureDef } from "../materials/textureGen";

/**
 * A building is an asset of its own (a pack's buildings/ folder), like a tree kind: one file gives
 * any number of variants, each from a seed. Features (a settlement, a quarry, a camp) place them.
 *
 * How a building is built is up to its generator - a timber house, a tent and a round tower have
 * little in common - so a building names one (its `type`), and gives it its own block of settings
 * under the generator's name. Every generator produces the same thing: a BuildingModel.
 */
export const BUILDING_GENERATORS = ["boxes", "house"] as const;
export type BuildingGenerator = (typeof BUILDING_GENERATORS)[number];

export type Rgb = [number, number, number];

/**
 * What buildings are made of (a pack's buildingMaterials/ folder): a texture, baked like a ground
 * material's, laid on a building's faces `size` metres to a repeat - and how much it shines.
 */
export interface BuildingMaterialDef {
  id: string;
  name: string;
  texture: TextureDef;
  /** Metres one repeat of the texture covers, across and up a face. */
  size: [number, number];
  /** 0-1: how glossy and reflective it is, from matte plaster (0) to glass (1). Its texture's own
   *  roughness still varies it across the surface. */
  shine: number;
}

/** How one face of a building is drawn: a building material (by id - null for plain colour), and a
 *  tint its colour is multiplied by. */
export interface Paint {
  material: string | null;
  tint: Rgb;
}

/** The placeholder generator: a main box, and a few smaller boxes against its sides. Each range is
 *  rolled per variant. */
export interface BoxesSpec {
  /** The main box: along its front, back from it, and up from the floor. */
  width: [number, number];
  depth: [number, number];
  height: [number, number];
  /** How many smaller boxes stand against its sides and back, and how big each is against it. */
  annexes: [number, number];
  annexSize: [number, number];
  /** Walls and tops, a colour picked from each list per box. */
  walls: Rgb[];
  tops: Rgb[];
}

export const ROOF_TYPES = ["gable", "hip"] as const;
export type RoofType = (typeof ROOF_TYPES)[number];

/**
 * A traditional house, one storey for now: its plan is tiles - a main block, and maybe a wing at
 * the back and one at a side - and from the plan come its plinth, walls, corner posts, door and
 * windows and a roof over each block. Lengths are metres; tile counts are whole tiles; each range is
 * rolled per variant.
 */
export interface HouseSpec {
  /** A tile's side: one bay of wall, one window's worth. */
  tile: [number, number];
  /** The main block, in tiles: along the front, and back from it. */
  width: [number, number];
  depth: [number, number];
  /** How likely a wing at the back, and one at a side, how many tiles each reaches out, and how many
   *  wide it is - always narrower than the main block, so the most a block allows caps the width,
   *  and a block that cannot take the least width gets no wing. */
  backWing: number;
  sideWing: number;
  wingLength: [number, number];
  wingWidth: [number, number];
  /** Floor to eaves (a storey), how high the plinth lifts the floor, and how far it stands out from
   *  the walls. */
  wallHeight: [number, number];
  plinth: [number, number];
  plinthOutset: number;
  /** The corner posts' width, either way. */
  post: [number, number];
  /** Picked per variant. Every block of a house has the same pitch and eave height, so where two
   *  roofs meet their slopes cut each other along clean valleys. */
  roofs: RoofType[];
  /** Degrees. */
  pitch: [number, number];
  /** How far the roof reaches past the walls, every way, and how thick it is. */
  overhang: number;
  roofThickness: number;
  /** The door, and how wide its frame is. */
  door: { width: number; height: number; frame: number };
  /** Each bay of wall gets a window with this chance. Closed: a frame and a pane on the wall, on a
   *  sill `sill` above the floor that reaches `sillReach` past the frame either side and out. */
  window: { width: number; height: number; sill: number; frame: number; sillReach: number; chance: number };
  /** What each part is made of, and the tints - one picked per house - its colour is multiplied by.
   *  Timber is the posts, the frames, and the roof's underside and edges. */
  parts: Record<HousePart, { material: string; tints: Rgb[] }>;
}

export const HOUSE_PARTS = ["walls", "timber", "roof", "plinth", "door", "glass"] as const;
export type HousePart = (typeof HOUSE_PARTS)[number];

export interface BuildingDef {
  id: string;
  name: string;
  generator: BuildingGenerator;
  boxes: BoxesSpec | null;
  house: HouseSpec | null;
}

/**
 * One building, built: its geometry in its own space - the floor at y 0, the footprint centred on
 * the origin, the front facing +z - and what a feature needs to place it.
 */
export interface BuildingModel {
  positions: number[];
  normals: number[];
  /** Per vertex: the direction the texture's u runs (its v runs along normal x tangent), and where
   *  on the texture it is, in metres - a material's size turns those into repeats. */
  tangents: number[];
  uvs: number[];
  /** Per vertex, the tint (RGBA) and which of `materials` it is made of (-1: plain colour). */
  colors: number[];
  materialSlots: number[];
  /** The building materials this model uses, by id. */
  materials: string[];
  indices: number[];
  /** Half-extents of what it stands on, along x and z. */
  halfWidth: number;
  halfDepth: number;
  /** Where its door is, on the footprint's edge - what a street or track leads to. */
  door: { x: number; z: number };
  height: number;
  /** The plan's tiles, for a generator that has one - drawn over the ground in the workbench. */
  tiles?: { x0: number; z0: number; x1: number; z1: number }[];
}
