import type { PackSource } from "../world/content/resolveContent";
import { ContentError, Reader, type ContentIssue, type RawObject } from "../world/content/contentReader";
import type { ColorTuple } from "../world/terrain/pipeline/pipelineTypes";
import { characterEntries } from "./raceDef";
import { sided } from "./characterConsts";

export { sided };

/**
 * One piece of gear (gear/<id>.json5, see CHARACTERS.md, *Gear as geometry*): what it paints on
 * the body, and the geometry it adds - shells over stretches of the body, a skirt hanging from the
 * waist, rigid pieces on a bone. Everything is given relative to the body (stretches along its
 * regions, offsets from its joints), so one piece fits every race and both sexes.
 */
export interface GearDef {
  id: string;
  name: string;
  slot: string;
  paint: GearPaint[];
  shells: GearShell[];
  skirts: GearSkirt[];
  pieces: GearPiece[];
  covers: GearCover[];
  /** The piece's own texture, cut like the real thing (CHARACTERS.md, *Pieces and islands*); the
   *  shells and skirts that name an island are drawn in it, the rest tile their materials. */
  texture: PieceTextureDef | null;
}

/**
 * A piece's own texture: its islands - the panels it is cut in, each a rectangle of the texture
 * that a shell or skirt is unrolled into - and how each is made. `density` is texels a metre.
 */
export interface PieceTextureDef {
  density: number;
  islands: Record<string, IslandDef>;
}

/** One panel of a piece: its cloth, which way the threads run and what is done to it. */
export interface IslandDef {
  material: string;
  tint: ColorTuple;
  /** The warp: "down" along the panel (a tunic's body), or "across" it. */
  grain: "down" | "across";
  /** A panel of a left and right pair is made once for each side, `at`s mirrored on the left. */
  sided: boolean;
  features: IslandFeature[];
}

/** What a tailor does to a panel (metres throughout, along the panel's real edges - its top, bottom
 *  and "join" edges, an armhole): a `seam` up and down it, `at` how far round
 *  (0-1; the front is in the middle, 0.5), between `from` and `to` shares of the panel's height from
 *  its top (a side seam stops at the armhole); a `hem` folded and stitched, or a `binding` of another cloth sewn over, along
 *  its top or bottom edge; a `join`, where it is sewn to the next panel, a stitch row `inset` in. */
export type IslandFeature =
  | { kind: "seam"; at: number; from: number; to: number }
  | { kind: "hem"; edge: "top" | "bottom"; width: number }
  | { kind: "binding"; edge: "top" | "bottom"; width: number; tint: ColorTuple }
  | { kind: "join"; edge: "top" | "bottom" | "join" | "seam"; inset: number };

/** A material and its colour, as gear names them. */
export interface GearSurface {
  material: string;
  tint: ColorTuple;
}

/** Cloth or leather painted on the body's atlas: over the regions named (a group - "arms", "legs",
 *  "hands", "feet" - meaning both), from and to shares of each one's length from its top, with a
 *  darker hem at its edges unless `hem` is off. */
export interface GearPaint extends GearSurface {
  regions: string[];
  from: number;
  to: number;
  hem: boolean;
}

/**
 * A shell: the body's own curves along a chain of bones grown outward by `thickness`, from and to
 * shares of the chain's length - a breastplate over the torso, greaves over the legs, a helm over
 * the head (`cap` closing its top). `flare` widens it further at its ends; `rim` is the colour of
 * its edges, which show its thickness.
 */
export interface GearShell extends GearSurface {
  chain: string;
  from: number;
  to: number;
  thickness: number;
  flare: [number, number];
  loops: number;
  verts: number | null;
  cap: boolean;
  rim: ColorTuple;
  /** The island of the piece's texture it is unrolled into (a sided chain's is made for each side),
   *  or null to tile its material; and whether it turns an edge in at its start and end. */
  island: string | null;
  lips: [boolean, boolean];
}

/**
 * Cloth cut from the body's own surface (CHARACTERS.md, *Pieces and islands*): the triangles of a
 * region from and to shares of its axis, moved out along their normals by `thickness`, with the
 * body's own skin weights - so it fits the shoulders, the armholes and every curve the body has,
 * the torso's and the arm's sharing the vertices where they meet. It is unrolled as the atlas
 * unrolls the body, into `island`. `hide` takes the body triangles under it out of the drawing.
 */
export interface GearCover extends GearSurface {
  region: string;
  from: number;
  to: number;
  thickness: number;
  /** The pattern pieces it is cut into, each a panel of the piece's texture, and how far round
   *  the body (0-1; the front is 0.5, the back 0) the middle of each is: a front and a back, cut at
   *  the sides; or one piece, a sleeve, cut open at the side opposite its middle. */
  pieces: CoverPiece[];
  hide: boolean;
}

export interface CoverPiece {
  island: string;
  centre: number;
}

/** A skirt hanging from the torso at `from` (a share of its length): a robe's, a tabard's, plate
 *  tassets - `length` metres long, `flare` times as wide at its hem as at its top. */
export interface GearSkirt extends GearSurface {
  from: number;
  length: number;
  flare: number;
  thickness: number;
  loops: number;
  rim: ColorTuple;
  /** The island it is unrolled into, continuing down from the island's end (a tunic's body). */
  island: string | null;
  /** Or the pieces it is cut into, as a cover's (a front and a back that carry on the cover's). */
  pieces: CoverPiece[];
}

/**
 * A rigid piece on one bone: a `dome` (a pauldron, `layers` lames stepping down the arm) or a
 * `blade` (a sword in the hand, its hilt in `hilt`'s material). Offsets are in metres from the
 * bone's head in the character's space, their x mirrored for the -x side; `sides` says which.
 */
export interface GearPiece extends GearSurface {
  kind: "dome" | "blade";
  bone: string;
  sides: ("R" | "L" | "")[];
  at: [number, number, number];
  axis: [number, number, number];
  radius: number;
  height: number;
  layers: number;
  length: number;
  width: number;
  hilt: GearSurface;
  rim: ColorTuple;
}

/** A named set of gear (outfits/<id>.json5), worn in order: later pieces paint over earlier ones. */
export interface OutfitDef {
  id: string;
  name: string;
  gear: string[];
}

const CHAINS = ["torso", "head", "armR", "armL", "arms", "handR", "handL", "hands", "legR", "legL", "legs", "footR", "footL", "feet"];
const REGIONS = ["torso", "head", "armR", "armL", "arms", "handR", "handL", "hands", "legR", "legL", "legs", "footR", "footL", "feet"];

export function resolveGear(packs: PackSource[]): Map<string, GearDef> {
  const issues: ContentIssue[] = [];
  const gear = new Map<string, GearDef>();
  for (const [id, entry] of characterEntries(packs, "gear", issues)) gear.set(id, readGear(id, entry.data, new Reader(issues, entry.file)));
  if (issues.length > 0) throw new ContentError(issues);
  return gear;
}

export function resolveOutfits(packs: PackSource[], gear: Map<string, GearDef>): Map<string, OutfitDef> {
  const issues: ContentIssue[] = [];
  const outfits = new Map<string, OutfitDef>();
  for (const [id, entry] of characterEntries(packs, "outfits", issues)) {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["name", "gear"]);
    const list = reader.stringList(obj, "gear", "");
    list.forEach((piece, i) => {
      if (!gear.has(piece)) reader.fail(`gear[${i}]`, `no gear "${piece}" (known: ${[...gear.keys()].join(", ")})`);
    });
    outfits.set(id, { id, name: reader.optionalString(obj, "name", "") ?? id, gear: list });
  }
  if (issues.length > 0) throw new ContentError(issues);
  return outfits;
}

function readGear(id: string, data: unknown, reader: Reader): GearDef {
  const obj = reader.object(data, "");
  reader.onlyKeys(obj, "", ["name", "slot", "paint", "shells", "skirts", "pieces", "covers", "texture"]);
  const list = (key: string): { raw: RawObject; path: string }[] => reader.optionalArray(obj, key, "").map((raw, i) => ({ raw: reader.object(raw, `${key}[${i}]`), path: `${key}[${i}]` }));
  return {
    id,
    name: reader.optionalString(obj, "name", "") ?? id,
    slot: reader.string(obj, "slot", ""),
    paint: list("paint").map(({ raw, path }) => {
      reader.onlyKeys(raw, path, ["regions", "from", "to", "material", "tint", "hem"]);
      const regions = reader.stringList(raw, "regions", path);
      regions.forEach((r, i) => {
        if (!REGIONS.includes(r)) reader.fail(`${path}.regions[${i}]`, `no region "${r}" (expected one of: ${REGIONS.join(", ")})`);
      });
      return { ...surface(raw, path, reader), regions, from: reader.optionalNumber(raw, "from", path, 0), to: reader.optionalNumber(raw, "to", path, 1), hem: reader.boolean(raw, "hem", path, true) };
    }),
    shells: list("shells").map(({ raw, path }) => {
      reader.onlyKeys(raw, path, ["chain", "from", "to", "thickness", "flare", "loops", "verts", "cap", "material", "tint", "rim", "island", "lips"]);
      const chain = reader.string(raw, "chain", path);
      if (!CHAINS.includes(chain)) reader.fail(`${path}.chain`, `no chain "${chain}" (expected one of: ${CHAINS.join(", ")})`);
      const flare = raw.flare === undefined ? [0, 0] : pair(raw.flare, `${path}.flare`, reader);
      const base = surface(raw, path, reader);
      return {
        ...base,
        chain,
        from: reader.optionalNumber(raw, "from", path, 0),
        to: reader.optionalNumber(raw, "to", path, 1),
        thickness: reader.number(raw, "thickness", path, { min: 0, max: 0.2 }),
        flare: flare as [number, number],
        loops: reader.optionalNumber(raw, "loops", path, 4, { min: 0, max: 16, integer: true }),
        verts: raw.verts === undefined ? null : reader.number(raw, "verts", path, { min: 4, max: 32, integer: true }),
        cap: reader.boolean(raw, "cap", path, false),
        rim: raw.rim === undefined ? darker(base.tint) : reader.color(raw, "rim", path),
        island: reader.optionalString(raw, "island", path) || null,
        lips: raw.lips === undefined ? [true, true] : (pair(raw.lips, `${path}.lips`, reader).map((v) => v !== 0) as [boolean, boolean]),
      };
    }),
    skirts: list("skirts").map(({ raw, path }) => {
      reader.onlyKeys(raw, path, ["from", "length", "flare", "thickness", "loops", "material", "tint", "rim", "island", "pieces"]);
      const base = surface(raw, path, reader);
      return {
        ...base,
        from: reader.number(raw, "from", path),
        length: reader.number(raw, "length", path, { min: 0.02, max: 2 }),
        flare: reader.optionalNumber(raw, "flare", path, 1.3, { min: 0.5, max: 4 }),
        thickness: reader.optionalNumber(raw, "thickness", path, 0.015, { min: 0, max: 0.2 }),
        loops: reader.optionalNumber(raw, "loops", path, 4, { min: 1, max: 16, integer: true }),
        rim: raw.rim === undefined ? darker(base.tint) : reader.color(raw, "rim", path),
        island: reader.optionalString(raw, "island", path) || null,
        pieces: raw.pieces === undefined ? [] : coverPieces(raw, path, reader),
      };
    }),
    pieces: list("pieces").map(({ raw, path }) => {
      reader.onlyKeys(raw, path, ["kind", "bone", "sides", "at", "axis", "radius", "height", "layers", "length", "width", "material", "tint", "rim", "hilt"]);
      const base = surface(raw, path, reader);
      const sidesRaw = raw.sides === undefined ? "" : reader.oneOf(raw, "sides", path, ["both", "R", "L"] as const);
      const hiltRaw = raw.hilt === undefined ? null : reader.object(raw.hilt, `${path}.hilt`);
      if (hiltRaw) reader.onlyKeys(hiltRaw, `${path}.hilt`, ["material", "tint"]);
      return {
        ...base,
        kind: reader.oneOf(raw, "kind", path, ["dome", "blade"] as const),
        bone: reader.string(raw, "bone", path),
        sides: (sidesRaw === "both" ? ["R", "L"] : [sidesRaw]) as ("R" | "L" | "")[],
        at: raw.at === undefined ? [0, 0, 0] : triple(raw.at, `${path}.at`, reader),
        axis: raw.axis === undefined ? [0, 1, 0] : triple(raw.axis, `${path}.axis`, reader),
        radius: reader.optionalNumber(raw, "radius", path, 0.1, { min: 0.005, max: 1 }),
        height: reader.optionalNumber(raw, "height", path, 0.06, { min: 0.005, max: 1 }),
        layers: reader.optionalNumber(raw, "layers", path, 1, { min: 1, max: 5, integer: true }),
        length: reader.optionalNumber(raw, "length", path, 0.8, { min: 0.05, max: 3 }),
        width: reader.optionalNumber(raw, "width", path, 0.06, { min: 0.005, max: 1 }),
        hilt: hiltRaw ? surface(hiltRaw, `${path}.hilt`, reader) : base,
        rim: raw.rim === undefined ? darker(base.tint) : reader.color(raw, "rim", path),
      };
    }),
    covers: list("covers").map(({ raw, path }) => {
      reader.onlyKeys(raw, path, ["region", "from", "to", "thickness", "island", "pieces", "hide", "material", "tint"]);
      const region = reader.string(raw, "region", path);
      if (!REGIONS.includes(region)) reader.fail(`${path}.region`, `no region "${region}" (expected one of: ${REGIONS.join(", ")})`);
      return {
        ...surface(raw, path, reader),
        region,
        from: reader.optionalNumber(raw, "from", path, 0),
        to: reader.optionalNumber(raw, "to", path, 1),
        thickness: reader.number(raw, "thickness", path, { min: 0, max: 0.1 }),
        pieces: coverPieces(raw, path, reader),
        hide: reader.boolean(raw, "hide", path, false),
      };
    }),
    texture: raw_texture(obj, reader),
  };
}

/** The pieces a cover or skirt is cut into: `pieces: [{ island, centre }]`, or `island` alone, one
 *  piece whose middle is the front (the back is where it is cut open). */
function coverPieces(raw: RawObject, path: string, reader: Reader): CoverPiece[] {
  if (raw.pieces === undefined) return [{ island: reader.string(raw, "island", path), centre: 0.5 }];
  return reader.array(raw, "pieces", path).map((item, i) => {
    const piece = reader.object(item, `${path}.pieces[${i}]`);
    reader.onlyKeys(piece, `${path}.pieces[${i}]`, ["island", "centre"]);
    return { island: reader.string(piece, "island", `${path}.pieces[${i}]`), centre: reader.optionalNumber(piece, "centre", `${path}.pieces[${i}]`, 0.5, { min: 0, max: 1 }) };
  });
}

function raw_texture(obj: RawObject, reader: Reader): PieceTextureDef | null {
  if (obj.texture === undefined) return null;
  const texture = reader.object(obj.texture, "texture");
  reader.onlyKeys(texture, "texture", ["density", "islands"]);
  const islandsRaw = reader.object(texture.islands, "texture.islands");
  const islands: Record<string, IslandDef> = {};
  for (const name of Object.keys(islandsRaw)) {
    const path = `texture.islands.${name}`;
    const raw = reader.object(islandsRaw[name], path);
    reader.onlyKeys(raw, path, ["material", "tint", "grain", "sided", "features"]);
    const features = reader.optionalArray(raw, "features", path).map((item, i): IslandFeature => {
      const fpath = `${path}.features[${i}]`;
      const f = reader.object(item, fpath);
      const kind = reader.oneOf(f, "kind", fpath, ["seam", "hem", "binding", "join"] as const);
      if (kind === "seam") {
        reader.onlyKeys(f, fpath, ["kind", "at", "from", "to"]);
        return { kind, at: reader.number(f, "at", fpath, { min: 0, max: 1 }), from: reader.optionalNumber(f, "from", fpath, 0, { min: 0, max: 1 }), to: reader.optionalNumber(f, "to", fpath, 1, { min: 0, max: 1 }) };
      }
      if (kind === "join") {
        reader.onlyKeys(f, fpath, ["kind", "edge", "inset"]);
        return { kind, edge: reader.oneOf(f, "edge", fpath, ["top", "bottom", "join", "seam"] as const), inset: reader.number(f, "inset", fpath, { min: 0.004, max: 0.1 }) };
      }
      reader.onlyKeys(f, fpath, kind === "hem" ? ["kind", "edge", "width"] : ["kind", "edge", "width", "tint"]);
      const edge = reader.oneOf(f, "edge", fpath, ["top", "bottom"] as const);
      const width = reader.number(f, "width", fpath, { min: 0.002, max: 0.2 });
      return kind === "hem" ? { kind, edge, width } : { kind, edge, width, tint: reader.color(f, "tint", fpath) };
    });
    islands[name] = {
      material: reader.string(raw, "material", path),
      tint: raw.tint === undefined ? [1, 1, 1] : reader.color(raw, "tint", path),
      grain: reader.optionalString(raw, "grain", path) === "across" ? "across" : "down",
      sided: reader.boolean(raw, "sided", path, false),
      features,
    };
  }
  return { density: reader.optionalNumber(texture, "density", "texture", 300, { min: 50, max: 1200 }), islands };
}

function surface(raw: RawObject, path: string, reader: Reader): GearSurface {
  return { material: reader.string(raw, "material", path), tint: raw.tint === undefined ? [1, 1, 1] : reader.color(raw, "tint", path) };
}

function darker(c: ColorTuple): ColorTuple {
  return [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6];
}

function pair(value: unknown, path: string, reader: Reader): [number, number] {
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number" && Number.isFinite(v))) return value as [number, number];
  reader.fail(path, "expected [start, end]");
  return [0, 0];
}

function triple(value: unknown, path: string, reader: Reader): [number, number, number] {
  if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && Number.isFinite(v))) return value as [number, number, number];
  reader.fail(path, "expected [x, y, z]");
  return [0, 0, 0];
}
