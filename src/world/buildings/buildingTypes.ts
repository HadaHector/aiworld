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
  /** The posts and beams the walls are framed with (a framing building part) - none if null. */
  framing: BuildingPartDef | null;
  /** Picked per variant. Every block of a house has the same pitch and eave height, so where two
   *  roofs meet their slopes cut each other along clean valleys. */
  roofs: RoofType[];
  /** Degrees. */
  pitch: [number, number];
  /** How far the roof reaches past the walls, every way, and how thick it is. */
  overhang: number;
  roofThickness: number;
  /** The door, one of these (building parts) picked per house, in a middle bay of the front. */
  doors: PartChoice[];
  /** Everything else on the walls - windows, chimneys - placed in the bays the door leaves free. */
  wallExtras: WallExtra[];
  /** What each part is made of, and the tints - one picked per house - its colour is multiplied by.
   *  Timber is the posts, the frames, and the roof's underside and edges. */
  parts: Record<HousePart, { material: string; tints: Rgb[] }>;
}

export const HOUSE_PARTS = ["walls", "timber", "stone", "roof", "plinth", "door", "glass"] as const;
export type HousePart = (typeof HOUSE_PARTS)[number];

/** Which walls of a house: the front (where the door is), the back, and the sides. */
export const WALL_SIDES = ["front", "back", "side"] as const;
export type WallSide = (typeof WALL_SIDES)[number];

/**
 * A building part a house puts on its walls. Extras are placed highest `priority` first (in the
 * order listed where two are level): each tries every free spot of the walls it may go on, in a
 * random order, and takes one with its `chance` - up to `maxCount` of them (null: no limit). A part
 * may still turn a spot down (a chimney by an inner corner), and the bays it takes are not free to
 * the extras after it.
 */
export interface WallExtra {
  part: BuildingPartDef;
  priority: number;
  chance: number;
  maxCount: number | null;
  walls: WallSide[];
}

/** A building part a building can use, and how likely it is against the others it could. */
export interface PartChoice {
  part: BuildingPartDef;
  weight: number;
}

/**
 * A building part (a pack's buildingParts/ folder): one piece of a building - a door, a window -
 * built by a generator of its own into a slot the building gives it, so one house generator can wear
 * timber frames or stone arches. Like a building, it names its generator (`type`) and has its
 * settings under the generator's name.
 *
 * A part takes no materials of its own: each of its pieces is painted as one of the building's
 * parts (its `parts`: timber, glass, ...), so a house's windows, posts and door share one timber.
 */
export const BUILDING_PART_GENERATORS = ["framed", "chimney", "timberFrame", "stoneFrame"] as const;
export type BuildingPartGenerator = (typeof BUILDING_PART_GENERATORS)[number];

/**
 * An opening in a timber frame, closed: a panel (glass, or a door's boards) standing on the wall,
 * jambs either side of it, a head over it, maybe glazing bars across it and a sill under it. Lengths
 * are metres. It spans `span` bays of wall - a big door two or three - and keeps clear of the corner
 * posts, shrinking where the bays leave it too little room.
 */
export interface FramedSpec {
  span: number;
  /** The panel, and how high its foot is above the floor (0: a door). */
  width: number;
  height: number;
  sill: number;
  /** The jambs' and the head's width, and how far the head reaches past the jambs either way. */
  frame: number;
  headReach: number;
  /** Glazing bars (or a double door's middle stile): how many up the panel, and how many across. */
  bars: [number, number];
  /** A sill under the panel, reaching this far past the jambs either way and out - or none. */
  sillReach: number | null;
  /** Which of the building's parts the frame and the panel are painted as. */
  parts: { frame: HousePart; panel: HousePart };
}

/**
 * A chimney against the outside of a wall, on a foundation of its own: a broad breast up to its
 * shoulders, sloping in to a narrower stack that rises past the ridge, capped by a band with pots on
 * it. Lengths are metres; widths are along the wall, depths out from it.
 */
export interface ChimneySpec {
  span: number;
  /** The breast. */
  width: number;
  depth: number;
  /** How high above the floor its shoulders are, where it narrows to the stack. */
  shoulder: number;
  stackWidth: number;
  stackDepth: number;
  /** How far the stack's top stands above the ridge - rolled per chimney. */
  rise: [number, number];
  /** Its foundation: how far it reaches past the breast every way, and how high above the floor. */
  foundation: { reach: number; height: number };
  /** The band capping the stack: how tall, and how far it stands out from the stack every way. */
  cap: { height: number; reach: number };
  /** Chimney pots on the cap: how many, how wide and how tall. */
  pots: { count: number; width: number; height: number };
  /** Which of the building's parts the body, the cap and the pots are painted as. */
  parts: { body: HousePart; cap: HousePart; pots: HousePart };
}

/**
 * A house's walls framed in timber: a square post on every corner, a beam along the foot of each wall
 * and one along its top, a post between them wherever the wall or the roof over it changes, and a king
 * post up each gable to its ridge. Lengths are metres; out is how far each stands out from the wall.
 */
export interface TimberFrameSpec {
  /** The corner posts' width, either way - rolled per house. */
  corner: [number, number];
  /** The posts between the corners, and up the gables. */
  post: { width: number; out: number };
  /** The beam along the foot of the wall, and the one along its top. */
  sill: { height: number; out: number };
  plate: { height: number; out: number };
  /** Which of the building's parts it is painted as. */
  parts: { timber: HousePart };
}

/**
 * A house's walls framed in dressed stone: quoins up every outer corner - stones in courses, long
 * along one wall and short along the other, turn and turn about - a cornice along the top of every
 * wall, maybe a string course along its foot, and a pilaster wherever the wall or the roof over it
 * changes. Lengths are metres; out is how far each stands out from the wall.
 */
export interface StoneFrameSpec {
  /** About how tall each course of quoins is (fitted to the wall), how far its long and its short
   *  stone reach along the walls from the corner, and how far they stand out. */
  quoins: { course: number; long: number; short: number; out: number };
  pilaster: { width: number; out: number };
  cornice: { height: number; out: number };
  /** A string course along the foot of the wall - none if null. */
  band: { height: number; out: number } | null;
  /** Which of the building's parts it is painted as. */
  parts: { stone: HousePart };
}

export interface BuildingPartDef {
  id: string;
  name: string;
  generator: BuildingPartGenerator;
  framed: FramedSpec | null;
  chimney: ChimneySpec | null;
  timberFrame: TimberFrameSpec | null;
  stoneFrame: StoneFrameSpec | null;
}

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
