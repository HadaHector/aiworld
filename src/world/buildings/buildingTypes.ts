import type { BuildingCollision } from "./buildingColliders";
import type { InteriorLayout, ShellLevel } from "./interiorLayout";
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

/** A ridge cap's cross-section: a rounded back (clay ridge tiles), or two boards meeting along the
 *  top (a shingle or a board roof's). */
export const RIDGE_PROFILES = ["round", "peaked"] as const;
export type RidgeProfile = (typeof RIDGE_PROFILES)[number];
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
  /** How the plan is laid out round the main block - its masses, and what tops each: a generator
   *  (`type`), its settings under its own name. */
  plan: HousePlanSpec;
  /** How many storeys the main block stands above ground - the ground floor and those over it - and
   *  how many cellars are dug under the house. */
  storeys: [number, number];
  cellars: [number, number];
  /** Floor to ceiling: the ground storey's, the storeys' over it (null: as the ground storey's), and
   *  a cellar's. How high the plinth lifts the ground floor, and how far it stands out from the
   *  walls. */
  wallHeight: [number, number];
  upperHeight: [number, number] | null;
  cellarHeight: [number, number];
  plinth: [number, number];
  plinthOutset: number;
  /** The posts and beams the walls are framed with (a framing building part) - none if null. */
  framing: BuildingPartDef | null;
  /** Each storey over the ground one standing this much further out than the one under it, on these
   *  walls - the roof growing to match - or none. */
  jetty: { out: number; walls: WallSide[] } | null;
  /** The roof over the main block, and every block that stands as tall (a roof building part). */
  roof: BuildingPartDef;
  /** The door, one of these (building parts) picked per house, in a middle bay of the front. */
  doors: PartChoice[];
  /** Everything else on the walls - windows, chimneys - placed in the bays the door leaves free. */
  wallExtras: WallExtra[];
  /** What each part is made of, and the tints - one picked per house - its colour is multiplied by.
   *  Timber is the posts, the frames, and the roof's underside and edges. */
  parts: Record<HousePart, { material: string; tints: Rgb[] }>;
  /** What is inside it - a generator and its settings - or null: a house nobody goes into, its doors
   *  shut and nothing behind its walls. */
  interior: InteriorSpec | null;
}

export const INTERIOR_GENERATORS = ["rooms"] as const;

/** A house's interior generator, and its settings - see INTERIORS.md and interiorLayout.ts. */
export type InteriorSpec = { type: "rooms"; rooms: RoomsInterior };

/** The `rooms` interior: a list of rooms, each with what it needs, laid out in priority order. */
export interface RoomsInterior {
  /** How many doors lead out - the front one, and more on the walls of rooms on the ground. */
  exits: [number, number];
  /** The chance a room gets a fake door into the unbuilt space beside it. */
  fakeDoors: number;
  /** Once all are placed, how far past its largest `tiles` a room may grow into the space left over
   *  - a multiplier; a room's own `grow` overrides it. */
  grow: number;
  rooms: RoomRequest[];
}

export const ROOM_LEVELS = ["cellar", "ground", "upper"] as const;
export type RoomLevel = (typeof ROOM_LEVELS)[number];

/**
 * A room a house asks for. Placed highest `priority` first, `count` of them, each with `chance`; one
 * that does not fit is left out. `levels` tall, starting on a `level` of that kind, `tiles` in floor
 * area, each side at least `minSide` tiles. `at: "entrance"`: behind the front door; `near: "entrance"`: there if it can be. `next`, `under`, `over`: beside, below or above a
 * room of that type placed before it. `stair`: a stair up from it is put in it before any other
 * room. `windows`: it needs an outer wall. `oneBlock`: it stays inside one block of the plan - the
 * main block, a wing, a lean-to - never reaching across into another, growing included. `through`: it runs through its block from
 * its front wall to its back - a bay of a stable, a shed's end.
 */
export interface RoomRequest {
  room: RoomTypeDef;
  priority: number;
  chance: number;
  count: [number, number];
  levels: [number, number];
  level: RoomLevel;
  tiles: [number, number];
  /** The fewest tiles either of its sides may be - 2: never a corridor a tile wide - and the most
   *  (null: no limit), growing included. */
  minSide: number;
  maxSide: number | null;
  /** Its own growth multiplier (see RoomsInterior.grow), or null: the interior's. */
  grow: number | null;
  at: "entrance" | null;
  near: "entrance" | null;
  next: string | null;
  under: string | null;
  over: string | null;
  stair: boolean;
  windows: boolean;
  oneBlock: boolean;
  through: boolean;
}

/** What a room's surfaces are made of: a building material, and tints - one picked per room. */
export interface RoomSurface {
  material: string;
  tints: Rgb[];
}

export const STAIR_STYLES = ["solid", "open"] as const;
export const WINDOW_INSIDES = ["glass", "shutters"] as const;

/**
 * A kind of room (a pack's rooms/ folder): its style - the same through the whole room. Its floor,
 * walls and ceiling, beams under the ceiling (or none), and the timber of its doors, stairs, railings
 * and shutters; its stair solid steps or open treads; its windows seen from inside as they are
 * outside (`glass`) or with their shutters shut (`shutters`). `underRoof`: where nothing of the house
 * is over it, it is open up to the roof - its ceiling the roof's underside, its walls going up to it,
 * its beams tying across at the top of its walls - a loft, or a lean-to's room. `hearth`: it wants
 * the chimney - a house's chimneys try the walls behind such a room before any others. `stalls`: a
 * row of stalls along its back wall (the side away from the house's front), a bay each - see
 * StallsSpec.
 */
export interface RoomTypeDef {
  id: string;
  name: string;
  floor: RoomSurface;
  walls: RoomSurface;
  ceiling: RoomSurface;
  beams: RoomSurface | null;
  timber: RoomSurface;
  stair: (typeof STAIR_STYLES)[number];
  windows: (typeof WINDOW_INSIDES)[number];
  underRoof: boolean;
  hearth: boolean;
  stalls: StallsSpec | null;
}

/**
 * A room's stalls: along its back wall, `depth` tiles deep - the rest of the room, in front of them,
 * its aisle - one to a bay, split by board partitions `height` metres high, a post at each one's
 * open end, and a manger along the wall in each. No door opens into them; a room no deeper than
 * its stalls has none.
 */
export interface StallsSpec {
  depth: number;
  height: number;
}

export const HOUSE_PLAN_GENERATORS = ["house", "tower", "cabin"] as const;
export type HousePlanGenerator = (typeof HOUSE_PLAN_GENERATORS)[number];

/** A house's plan generator, and its settings - see housePlans.ts. */
export type HousePlanSpec =
  | { type: "house"; house: HousePlanSettings }
  | { type: "tower"; tower: TowerPlanSettings }
  | { type: "cabin"; cabin: CabinPlanSettings };

/** The walls of a cabin's main block a lean-to may stand against. */
export const LEAN_TO_WALLS = ["back", "side"] as const;

/**
 * A lean-to a cabin may have: a wing one storey tall against one of `walls` of its main block (a
 * side: either end), made with `chance`, reaching `depth` tiles out from it, along the whole wall
 * (`length` null) or `length` tiles of it, under a lean-to roof (`roof`, a leanTo part) rising to
 * the main block's wall. Each wall takes one at most.
 */
export interface LeanToSpec {
  walls: (typeof LEAN_TO_WALLS)[number][];
  chance: number;
  depth: [number, number];
  length: [number, number] | null;
  roof: BuildingPartDef;
}

/** The walls of a cabin's main block a porch may stand along. */
export const PORCH_WALLS = ["front", "back", "side"] as const;

/** A porch a cabin may have: along one of `walls` of its main block's ground storey (a side: either
 *  end), made with `chance`, along the whole wall (`length` null) or `length` tiles of it - a porch
 *  part (`part`). A wall takes a porch or a lean-to, not both. */
export interface PorchPlanSpec {
  walls: (typeof PORCH_WALLS)[number][];
  chance: number;
  length: [number, number] | null;
  part: BuildingPartDef;
}

/** The `cabin` plan: a long main block, its storeys over the ground one a loft under its roof, and
 *  lean-tos one storey tall against it - only on a cabin of two storeys or more, the wall a lean-to
 *  leans on being the main block's above its own - and porches along it. */
export interface CabinPlanSettings {
  leanTos: LeanToSpec[];
  porches: PorchPlanSpec[];
  /** An open shed instead (null: walled): the main block's storeys standing on posts (`post`, a
   *  support part) along its outer edges, spread evenly about every `postEvery` bays, open on every
   *  side, but for `closedBays` bays at one end, walled in - the shed's way in and its door - with no
   *  lean-tos or porches. */
  open: { closedBays: [number, number]; post: BuildingPartDef; postEvery: number } | null;
}

/** The `house` plan: a main block, maybe with a wing out of the back (a T or an L) and one out of a
 *  side, a front arcade and a top storey stood back. */
export interface HousePlanSettings {
  /** How likely a wing at the back, and one at a side, how many tiles each reaches out, and how many
   *  wide it is - always narrower than the main block, so the most a block allows caps the width,
   *  and a block that cannot take the least width gets no wing. */
  backWing: number;
  sideWing: number;
  wingLength: [number, number];
  wingWidth: [number, number];
  /** How many storeys a wing stands - no more than the main block's - or null: as many. A lower wing
   *  is topped with one of `lowTops`: a roof (stopping against the taller block's wall) or a terrace.
   *  None given: the house's own roof. */
  wingStoreys: [number, number] | null;
  lowTops: PartChoice[];
  /** With `chance`, the top storey stands back a tile from the front, the strip before it a terrace
   *  (one of `terraces`). Only on a house of two storeys or more, two tiles deep or more. */
  setback: { chance: number; terraces: PartChoice[] } | null;
  /** With `chance`, the ground storey's front row of tiles is left open - an arcade - the storeys over
   *  it standing on `support`s along its front, with a ceiling over it. Only on a house of two storeys
   *  or more, two tiles deep or more. */
  arcade: { chance: number; support: BuildingPartDef } | null;
}

/** The `tower` plan: the main block - a chapel's nave, a hall - with a square tower against one end,
 *  standing storeys taller under a roof of its own; the main block's roof stops against it. */
export interface TowerPlanSettings {
  /** The tower's side, in tiles - held to the main block's width, and centred on it. */
  width: [number, number];
  /** Which end of the main block it stands against, one picked per house: the front (the door in the
   *  tower's foot) or the back. */
  ends: ("front" | "back")[];
  /** How many storeys it stands over the main block's. */
  storeys: [number, number];
  /** Its roof (a roof building part) - a hipped one on a square tower is a pyramid. */
  roof: BuildingPartDef;
}

/** The parts a house is painted in. `endGrain` (a beam's cut end) and `boards` (a porch's deck) may
 *  be left out of a house's `parts`, and are then its timber. */
export const HOUSE_PARTS = ["walls", "timber", "stone", "roof", "plinth", "door", "glass", "endGrain", "boards"] as const;
export const OPTIONAL_HOUSE_PARTS: readonly HousePart[] = ["endGrain", "boards"];
export type HousePart = (typeof HOUSE_PARTS)[number];

/** Which walls of a house: the front (where the door is), the back, and the sides. */
export const WALL_SIDES = ["front", "back", "side"] as const;
export type WallSide = (typeof WALL_SIDES)[number];

/** Which storeys of a house: those dug under it, the ground one, and those over it. */
export const STOREY_KINDS = ["cellar", "ground", "upper"] as const;
export type StoreyKind = (typeof STOREY_KINDS)[number];

/** One level of a house, as built: what kind it is, and its floor and ceiling heights. */
export interface Level {
  kind: StoreyKind;
  floor: number;
  top: number;
}

/**
 * A building part a house puts on its walls. Extras are placed highest `priority` first (in the
 * order listed where two are level): each tries every free spot of the walls and storeys it may go
 * on, in a random order, and takes one with its `chance` - up to `maxCount` of them (null: no
 * limit). A part may still turn a spot down (a chimney by an inner corner), and the bays it takes -
 * on every storey it rises through - are not free to the extras after it.
 */
export interface WallExtra {
  part: BuildingPartDef;
  priority: number;
  chance: number;
  maxCount: number | null;
  walls: WallSide[];
  storeys: StoreyKind[];
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
export const BUILDING_PART_GENERATORS = ["framed", "chimney", "timberFrame", "stoneFrame", "logs", "pitched", "leanTo", "porch", "terrace", "support"] as const;
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
  /** How far its top stands above a line falling from the nearest ridge at `angle` degrees below
   *  level - the old rule for a chimney to draw: over the ridge right by it, lower further off. */
  angle: number;
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

/**
 * A house's walls built of hewn logs: at every outer corner each course of logs runs on past it as
 * a square beam, one wall's and the other's turn and turn about - the corner of a log house. The
 * walls' faces are flat, in a log wall material whose courses this must match (`course`): a beam is
 * one course tall, on the course's own lines, and its face is the wall's own paint in the wall's
 * plane, so the wall's logs run on into it unbroken. Lengths are metres.
 */
export interface LogsSpec {
  /** One course: a log's height - the height of a course of the walls' material. Courses lie on
   *  the model's own height, every `course` from 0, as the material's rows do. */
  course: number;
  /** How far a beam stands out past the corner - rolled per house - and how thick it is, back from
   *  the wall's face. */
  reach: [number, number];
  depth: number;
  /** How far off the middle of a beam's cut end the heart of the tree it was cut from may be - each
   *  its own, so no two ends show the same rings. Kept within the trunk the end grain material draws,
   *  so an end never reaches the bark. */
  endOffset: number;
  /** Which of the building's parts its faces (the walls', to run on from them), its top and
   *  underside (the grain along it), and its cut end are painted as. */
  parts: { face: HousePart; grain: HousePart; end: HousePart };
}

/**
 * A pitched roof over every block of a house: gables or hips at its free ends (one shape picked per
 * house), every block at one pitch and eave height, so where two roofs meet their slopes cut each
 * other along clean valleys. Thick slabs, with ridge tiles along the ridges and hips, sagging like an
 * old roof. Lengths are metres; ranges are rolled per house.
 */
export interface PitchedRoofSpec {
  shapes: RoofType[];
  /** Degrees. */
  pitch: [number, number];
  /** How far it reaches past the walls, every way, and how thick it is. */
  overhang: number;
  thickness: number;
  /** How far its ridges sink in the middle, and its rafters bow between eaves and ridge. */
  sag: { ridge: [number, number]; slope: [number, number] };
  /** The covering on its boards: how thick (of the whole), and how far it reaches past them at the
   *  eaves - and at the verges, where there is no bargeboard. */
  covering: { thickness: number; overhang: number };
  /** Boards up the gables' verges, on edge: how far they stand above the covering, and how thick -
   *  or none. */
  bargeboard: { height: number; thickness: number } | null;
  /** The size of the cells its slabs are split into to bend. */
  step: number;
  /** A ridge cap along the ridges and hips - a row of ridge tiles, as one rounded length: how wide,
   *  and how high above the slabs - or none. */
  ridgeTiles: { width: number; height: number; profile: RidgeProfile } | null;
  /** Which of the building's parts the covering, the underside and edges, the ridge tiles and the
   *  gables' wall are painted as. */
  parts: { covering: HousePart; underside: HousePart; ridge: HousePart; gable: HousePart };
}

/**
 * A lean-to roof: one slope over a lower block, from its outer wall up to the taller wall it leans
 * against - a slab, its covering on top and boards under it - and at its free ends a wall filling
 * the space under the slope. Lengths are metres; its pitch (degrees) is rolled per house, and held
 * low enough that it meets the wall it leans on below that wall's top.
 */
export interface LeanToRoofSpec {
  pitch: [number, number];
  /** How far it reaches past its outer wall and its free ends, and how thick its slab is. */
  overhang: number;
  thickness: number;
  /** Which of the building's parts its covering, its underside and edges, and the walls under its
   *  ends are painted as. */
  parts: { covering: HousePart; underside: HousePart; gable: HousePart };
}

/**
 * A porch along a wall: a plank deck at the floor's level and a step down from it, a post at every bay
 * along its front with a beam along their tops, and a lean-to roof from the wall - `drop` under the
 * storey's top - out over the posts, open at its ends. Lengths are metres; its depth and its pitch
 * (degrees) are rolled per house, the pitch held shallow enough to leave `headroom` under its front.
 */
export interface PorchSpec {
  depth: [number, number];
  pitch: [number, number];
  drop: number;
  headroom: number;
  /** How far its roof reaches past the posts and the ends, and how thick it is. */
  overhang: number;
  thickness: number;
  /** Its posts' width either way, the beam along their tops' height, and its step's depth. */
  post: number;
  beam: number;
  step: number;
  /** Which of the building's parts its deck and step, its posts and beam, its roof's covering, and
   *  its roof's underside and edges are painted as. */
  parts: { deck: HousePart; post: HousePart; covering: HousePart; underside: HousePart };
}

/**
 * A terrace on top of a storey that the storeys over it do not cover: a floor, its edge closed by a
 * band, and along its open sides - those not against a wall rising over it - a parapet: a low wall,
 * or a railing of posts and a rail. Lengths are metres.
 */
export interface TerraceSpec {
  /** The floor's band round its edge: how deep, and how far it stands out from the walls under it. */
  edge: { height: number; out: number };
  /** The parapet: how high and thick - and a wall, or a railing (posts `post` apart, a rail on top). */
  parapet: { height: number; thickness: number; style: ParapetStyle; post: number };
  /** Which of the building's parts the floor, its edge and the parapet are painted as. */
  parts: { floor: HousePart; edge: HousePart; parapet: HousePart };
}

export const PARAPET_STYLES = ["wall", "railing"] as const;
export type ParapetStyle = (typeof PARAPET_STYLES)[number];

/**
 * A support standing under a storey that overhangs open ground - an arcade's posts or pillars: a
 * square shaft `width` wide, with maybe a wider base at its foot and a capital at its head. Lengths
 * are metres.
 */
export interface SupportSpec {
  width: number;
  base: { height: number; reach: number } | null;
  capital: { height: number; reach: number } | null;
  /** Which of the building's parts the shaft, and its base and capital, are painted as. */
  parts: { shaft: HousePart; ends: HousePart };
}

export interface BuildingPartDef {
  id: string;
  name: string;
  generator: BuildingPartGenerator;
  framed: FramedSpec | null;
  chimney: ChimneySpec | null;
  timberFrame: TimberFrameSpec | null;
  stoneFrame: StoneFrameSpec | null;
  logs: LogsSpec | null;
  pitched: PitchedRoofSpec | null;
  leanTo: LeanToRoofSpec | null;
  porch: PorchSpec | null;
  terrace: TerraceSpec | null;
  support: SupportSpec | null;
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
  /** Its levels, cellars first, for a generator that has them - what an interior will be laid in. */
  levels?: Level[];
  /** Its interior's layout, where it has one: its rooms, stairs and doors, and where its tile (0, 0)
   *  starts (x, z), so a cell can be found from a point - and its doors out: the tile inside each,
   *  which way it faces, and where along the wall (x or z) its middle is. */
  interior?: { layout: InteriorLayout; levels: ShellLevel[]; X0: number; Z0: number; tile: number; exits: { i: number; j: number; k: number; dir: "px" | "nx" | "pz" | "nz"; along: number }[] };
  /** What it puts in the way (see buildingColliders.ts) - built with the near model only. */
  colliders?: BuildingCollision;
}
