// Dungeon styles and parts from the packs (DUNGEONS.md): `dungeonStyles/`, `dungeonParts/` and
// `rules/dungeons.json5`, read and checked - every part's walk lines 6 m wide and high on its own
// colliders, every style able to start, grow and close.
import type { ArcosoliaSpec, BreachSpec, LoculiSpec } from "../architecture/dents";
import type { CopingSpec, RibSpec, TrimProfile, WallTrims } from "../architecture/trims";
import { ContentError, Reader, type ContentIssue, type RawObject } from "../content/contentReader";
import { DUNGEON_FOLDERS, orderPacks, parseFile, type PackSource } from "../content/resolveContent";
import { vec3, type Aabb, type ShapeDesc, type Vec3 } from "../collision/index";
import { boxShape, doorwayGeometry, DOORWAY_KINDS, rotundaGeometry, spiralGeometry, stairGeometry, type DoorwaySpec, type Polyline, type Voussoir } from "./kitShapes";
import { checkPaths } from "./clearance";
import { altarBox, altarShape, benchShape, ledgerShape, placeBenches, placeLedgers, placeTombs, tombShape, type AltarDef, type BenchDef, type LedgerDef, type TombDef } from "./tombs";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** `rules/dungeons.json5`. */
export interface DungeonRules {
  /** The narrowest and lowest any way through may be: width, height. */
  minClear: [number, number];
  /** Socket types that join, each pair either way round; a type always joins itself. */
  joins: [string, string][];
  /** Layouts tried before the minimal one, each from a seed derived from the last. */
  attempts: number;
  /** Parts tried at an open socket before it is capped. */
  triesPerSocket: number;
  /** The ground is sampled this far apart over a part, and this far round it. */
  sample: number;
  around: number;
  /** Over an open socket with less rock than the style's cover plus this, the layout dives. */
  thinCover: number;
  /** How much likelier a part that goes down is while diving. */
  diveWeight: number;
  /** How far apart two open ends may be, straight, to be joined into a loop. */
  loopReach: number;
  /** How many joins apart, along the layout, two ends must be for joining them to make a loop
   *  worth getting lost in. */
  loopSpan: number;
}

/** A corner part entered by one socket and left by the other: how far in it turns, and which way. */
export interface CornerTurn {
  part: DungeonPartDef;
  entry: number;
  exit: number;
  /** From the way in to where it turns, and from there to the way out, metres. */
  reachIn: number;
  reachOut: number;
  /** 1 a right turn (facing +90°), -1 a left. */
  turn: 1 | -1;
}

/**
 * How the generator joins two open ends into a loop (DUNGEONS.md, *The generator*): corridors and
 * flights of stairs it sizes to fit, made like the kit's, and the style's corners to turn with.
 */
export interface ConnectorDef {
  socket: string;
  width: number;
  height: number;
  wall: number;
  rise: number;
  /** The shortest tread a flight may have: its run for a drop is at least drop / rise * tread. */
  tread: number;
  corners: CornerTurn[];
}

export interface SocketDef {
  at: Vec3;
  /** Which way the opening faces, out of the part, in degrees: 0 north (+z), 90 east (+x). */
  facing: number;
  type: string;
  /** The way through's width and height. */
  size: [number, number];
  /** How far a doorway set across it may reach into this part (its walls' depth, or more where it
   *  may stand proud of them - a hall's - or must cover a curve - a spiral's). */
  reach: number;
  /** How far its lintel may: less where something passes close over the doorway (a spiral's next lap). */
  reachOver: number;
}

export interface DungeonPartDef {
  id: string;
  tags: string[];
  weight: number;
  /** Where in the dungeon it may go, as a share of the rooms placed: 0 the mouth, 1 the last. */
  stage: [number, number];
  /** Never joined straight onto a part with any of these tags, nor one onto it (a spiral stair
   *  straight after the spiral way down). */
  apart: string[];
  /** What it takes up, in its own frame (from its colliders, unless given). */
  bounds: Aabb;
  sockets: SocketDef[];
  /** Kit builder: its colliders and the lines its floor is walked along, in its own frame. */
  shapes: ShapeDesc[];
  paths: Polyline[];
  /** Anchors for what fills it (DUNGEONS.md, *What fills it*). */
  spots: Record<string, Vec3[]>;
  /** Counts toward the style's rooms (a hall, a tomb) rather than joining them (a corridor, a stair). */
  room: boolean;
  /** A cap's face, other than a plain wall: a wall tomb (the style's arcosolium in it) or an iron gate
   *  with the dark past it. */
  ending?: "tomb" | "gate";
  /** Centres (x, z) its round walls and pillars turn about - a spiral's - so their textures run round them. */
  rounds: [number, number][];
  /** A doorway, set across every join (DUNGEONS.md, *Doorways*): how it is built - its depth
   *  either side the joined sockets' `reach` - or null for any other part. */
  doorway: DoorwaySpec | null;
  /** What is drawn but not in the way - a doorway's leaves standing open. */
  visuals: ShapeDesc[];
  /** Which of `shapes` are drawn whole, uncut by the rest: a spiral's pillar. */
  whole: number[];
  /** Which are wall all over, whatever their shape: a railing. */
  plain: number[];
  /** A doorway's arch stones, each textured as one block. */
  voussoirs: Voussoir[];
  /** Tombs standing free on its floor (./tombs.ts): each a collider at the end of `shapes`, drawn by
   *  the style as a carved chest rather than as the box it collides as. */
  tombs?: TombDef[];
  /** Stone benches against its walls (./tombs.ts): colliders after its tombs, drawn as a seat on two blocks. */
  benches?: BenchDef[];
  /** Ledger stones let into its floor (./tombs.ts): colliders after its benches, drawn bevelled. */
  ledgers?: LedgerDef[];
  /** How many of `shapes` are drawn as they are (the rest - its tombs, benches and ledgers - are not); all when unset. */
  drawn?: number;
  /** A barrel vault it may be drawn with instead of its flat one (kitMesh.ts), the style's share of
   *  the time: over `over` (x0, z0, x1, z1 - the room's inside), its axis along x or z, springing
   *  where the flat vault's underside is, rising `rise` over that. Drawn only: it collides with its
   *  flat vault. Its bounds reach over it. */
  barrel?: BarrelDef;
  /** An altar against a wall (a boss room's): a collider after its own, before its tombs (which
   *  keep clear of it), drawn as the style's altar prop. */
  altar?: AltarDef;
  /** Its outside, where it stands on the surface (an entrance's house - a crypt's mausoleum): drawn
   *  in sunlight with the world, not baked. */
  exterior?: ExteriorDef;
}

/** A part's outside (kitMesh.ts, `exteriorModel`): its walls round `walls` (x0, z0, x1, z1) from `foot`
 *  (under the ground) to the eaves at `eave`, a gabled roof rising `roof` over them along its longer
 *  side; its doors where its surface sockets are. */
export interface ExteriorDef {
  walls: [number, number, number, number];
  foot: number;
  eave: number;
  roof: number;
  /** Which way its ridge runs: along x or z (its gables at the other two sides). */
  ridge: "x" | "z";
}

/**
 * A style's creatures: its `groups` (each a list of species or kind ids - the undead, grave robbers,
 * spiders), `pick` of which each dungeon holds; a group at each of its parts' `spawns` spots, a level
 * higher every `deeper` parts in from the entrance; at its boss's spot the strongest of them, `boss`
 * levels up.
 */
export interface DungeonCreatures {
  groups: { id: string; kinds: string[]; weight: number }[];
  pick: number;
  deeper: number;
  boss: number;
}

export interface BarrelDef {
  over: [number, number, number, number];
  along: "x" | "z";
  spring: number;
  rise: number;
}

export interface DungeonSize {
  rooms: [number, number];
  entry: "seamless" | "space";
}

export interface DungeonStyleDef {
  id: string;
  name: string;
  builder: "kit";
  sizes: Record<string, DungeonSize>;
  /** The chance a part's further sockets are left open to grow from, rather than capped. */
  branching: number;
  loops: [number, number];
  /** Rock over every part's top, and how far under the entrance it may reach. */
  cover: number;
  deepest: number;
  /** Its parts by role: those it grows from, the entrance, the boss room, the caps. */
  parts: DungeonPartDef[];
  entrances: DungeonPartDef[];
  bosses: DungeonPartDef[];
  caps: DungeonPartDef[];
  /** Locks on the way to the boss, each with its key in another room. */
  locks: [number, number];
  /** How loops are made; null for a style without. */
  connector: ConnectorDef | null;
  /** What a kit's faces are made of, by what they are to the way through (DUNGEONS.md, *Materials*). */
  look: KitLook;
  /** The doorways set across its joins and caps; none, and parts meet bare. */
  doorways: DungeonPartDef[];
  /** The bands along its walls (src/world/architecture/trims.ts): a plinth at their feet, a cornice
   *  at their heads - none where not given. */
  trims: WallTrims;
  /** How it is lit (DUNGEONS.md, *Light*). */
  light: DungeonLight;
  /** Urns (a prop) set in its open loculi and on its benches: the share of each such place that has one. */
  urns?: { prop: string; share: number };
  /** The prop drawn at a part's altar. */
  altar?: string;
  /** Chandeliers (a prop) hung from the vaults of its large rooms: the share of the places for one that have one. */
  chandeliers?: { prop: string; share: number };
  /** What lives in it (DUNGEONS.md, *What fills it*): see DungeonCreatures. */
  creatures?: DungeonCreatures;
  /** The share of the parts that may have a barrel vault (`DungeonPartDef.barrel`) drawn with it. */
  barrels: number;
}

/** A face's building material (by id; null for plain colour) and the tint its colour is multiplied by. */
export interface DungeonPaint {
  material: string | null;
  tint: [number, number, number];
}

/** A kit's materials: the floor walked on, the walls, the vault overhead, and stairs' treads and risers. */
export interface KitLook {
  floor: DungeonPaint;
  wall: DungeonPaint;
  ceiling: DungeonPaint;
  steps: DungeonPaint;
  /** A step's top and its front face, laid by the step (from the nosing back, from the foot up). */
  tread: DungeonPaint;
  riser: DungeonPaint;
  /** A doorway's stone, and its leaves. */
  frame: DungeonPaint;
  /** The trims' (plinths, cornices, a niche's frame). */
  trim: DungeonPaint;
  /** A niche cut into a wall: its inside, its frame, its slab. */
  niche: DungeonPaint;
  /** A tomb, standing free or lying in an arcosolium: each piece of it one stone, no joints. */
  tomb: DungeonPaint;
  door: DungeonPaint;
  /** Ironwork: a gate's bars. */
  iron: DungeonPaint;
  /** What is seen of the dark past a gate. */
  dark: DungeonPaint;
  /** A wall's core, where its facing blocks have fallen out (a breach). */
  breach: DungeonPaint;
  /** A part's outside (an entrance's house): its walls, and its roof. */
  outside: DungeonPaint;
  roof: DungeonPaint;
}

export interface DungeonLight {
  /** The light everywhere, lit or not, so unlit rock is a dark shape rather than a hole. */
  ambient: [number, number, number];
  /** The prop standing at a part's `light` spots (a wall torch), and the share of spots that have one. */
  fixture: string;
  lit: number;
  /** Candles (a prop, a cluster of them) left on its benches, on its ledger stones and at its tombs'
   *  heads: the share of each such place that has some. */
  candles?: { prop: string; share: number };
}

export interface DungeonContent {
  rules: DungeonRules;
  parts: Map<string, DungeonPartDef>;
  styles: Map<string, DungeonStyleDef>;
}

interface Entry {
  id: string;
  file: string;
  data: unknown;
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Every dungeon style and part in the packs, checked. Throws a ContentError listing every problem. */
export function resolveDungeons(packs: readonly PackSource[]): DungeonContent {
  const issues: ContentIssue[] = [];
  const folders = new Map<string, Map<string, Entry>>([...DUNGEON_FOLDERS].map((f) => [f, new Map()]));
  let rulesEntry: Entry | undefined;
  for (const pack of orderPacks([...packs], issues)) {
    for (const { path, text } of pack.files) {
      const parts = path.split("/");
      if (parts.length !== 2) continue;
      const id = parts[1].replace(/\.json5$/, "");
      const file = `${pack.id}/${path}`;
      if (parts[0] === "rules") {
        if (id !== "dungeons") continue;
        const data = parseFile(file, text, issues);
        if (data !== undefined) rulesEntry = { id, file, data };
        continue;
      }
      if (!folders.has(parts[0])) continue;
      if (!ID_PATTERN.test(id)) {
        issues.push({ file, path: "", message: "file names (which are ids) may only use letters, digits, - and _" });
        continue;
      }
      const data = parseFile(file, text, issues);
      if (data !== undefined) folders.get(parts[0])!.set(id, { id, file, data });
    }
  }
  const entries = (folder: string): Entry[] => [...folders.get(folder)!.values()].sort(byId);
  const rules = readRules(rulesEntry, issues);

  const parts = new Map<string, DungeonPartDef>();
  for (const entry of entries("dungeonParts")) {
    const part = readPart(entry, rules, issues);
    if (part) parts.set(part.id, part);
  }
  const styles = new Map<string, DungeonStyleDef>();
  for (const entry of entries("dungeonStyles")) styles.set(entry.id, readStyle(entry, parts, rules, issues));
  if (issues.length > 0) throw new ContentError(issues);
  return { rules, parts, styles };
}

function readRules(entry: Entry | undefined, issues: ContentIssue[]): DungeonRules {
  const reader = new Reader(issues, entry?.file ?? "rules/dungeons.json5");
  const obj = entry ? reader.object(entry.data, "") : {};
  reader.onlyKeys(obj, "", ["minClear", "joins", "attempts", "triesPerSocket", "sample", "around", "thinCover", "diveWeight", "loopReach", "loopSpan"]);
  const minClear = obj.minClear === undefined ? ([6, 6] as [number, number]) : pair(reader, obj, "minClear", "");
  const joins = reader.optionalArray(obj, "joins", "").map((value, i): [string, string] => {
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "string")) return [value[0], value[1]];
    reader.fail(`joins[${i}]`, "expected a pair of socket types, [\"a\", \"b\"]");
    return ["", ""];
  });
  return {
    minClear,
    joins,
    attempts: reader.optionalNumber(obj, "attempts", "", 8, { min: 1, integer: true }),
    triesPerSocket: reader.optionalNumber(obj, "triesPerSocket", "", 6, { min: 1, integer: true }),
    sample: reader.optionalNumber(obj, "sample", "", 2, { min: 0.5 }),
    around: reader.optionalNumber(obj, "around", "", 2, { min: 0 }),
    thinCover: reader.optionalNumber(obj, "thinCover", "", 10, { min: 0 }),
    diveWeight: reader.optionalNumber(obj, "diveWeight", "", 4, { min: 1 }),
    loopReach: reader.optionalNumber(obj, "loopReach", "", 60, { min: 0 }),
    loopSpan: reader.optionalNumber(obj, "loopSpan", "", 4, { min: 1, integer: true }),
  };
}

/** Whether two socket types join. */
export function socketsJoin(rules: DungeonRules, a: string, b: string): boolean {
  return a === b || rules.joins.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

function pair(reader: Reader, obj: RawObject, key: string, path: string): [number, number] {
  const value = obj[key];
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number" && v > 0)) return [value[0], value[1]];
  reader.fail(path ? `${path}.${key}` : key, "expected [width, height], both above 0");
  return [1, 1];
}

/** A socket's `reach` (1 m, the walls' depth, if not given) and `reachOver` (its reach, if not). */
function reaches(reader: Reader, raw: RawObject, path: string): { reach: number; reachOver: number } {
  const reach = reader.optionalNumber(raw, "reach", path, 1, { min: 0.1 });
  return { reach, reachOver: reader.optionalNumber(raw, "reachOver", path, reach, { min: 0.1 }) };
}

function vector(reader: Reader, value: unknown, path: string): Vec3 {
  if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && Number.isFinite(v))) return vec3(value[0], value[1], value[2]);
  reader.fail(path, "expected [x, y, z]");
  return vec3();
}

const PART_KEYS = ["tags", "weight", "stage", "apart", "tombs", "benches", "ledgers", "ending", "bounds", "sockets", "colliders", "paths", "spots", "room", "doorway", "barrel", "altar", "exterior"];

function readPart(entry: Entry, rules: DungeonRules, issues: ContentIssue[]): DungeonPartDef | null {
  const reader = new Reader(issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", PART_KEYS);
  const sockets = reader.array(obj, "sockets", "").map((value, i): SocketDef => {
    const path = `sockets[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["at", "facing", "type", "size", "reach", "reachOver"]);
    const size = pair(reader, raw, "size", path);
    if (size[0] < rules.minClear[0] - 1e-6 || size[1] < rules.minClear[1] - 1e-6) reader.fail(`${path}.size`, `under the rules' minimum way through, ${rules.minClear.join(" x ")}`);
    return { at: vector(reader, raw.at, `${path}.at`), facing: reader.number(raw, "facing", path), type: reader.string(raw, "type", path), size, ...reaches(reader, raw, path) };
  });
  if (sockets.length === 0) reader.fail("sockets", "a part needs at least one socket to be joined by");
  const shapes: ShapeDesc[] = [];
  const paths: Polyline[] = [];
  const rounds: [number, number][] = [];
  const visuals: ShapeDesc[] = [];
  const whole: number[] = [];
  const plain: number[] = [];
  const voussoirs: Voussoir[] = [];
  let doorway: DoorwaySpec | null = null;
  if (obj.doorway !== undefined) {
    // A doorway: its shapes from its kind and its socket's size.
    const raw = reader.object(obj.doorway, "doorway");
    reader.onlyKeys(raw, "doorway", ["kind", "jamb", "lintel", "rise"]);
    if (sockets.length !== 1) reader.fail("sockets", "a doorway has one socket, in the plane it stands across");
    const size = sockets[0]?.size ?? rules.minClear;
    // Set down, it is built again for the two sockets it stands between (layout.ts, doorwayPart);
    // on its own, 1 m either side.
    doorway = {
      kind: reader.oneOf(raw, "kind", "doorway", DOORWAY_KINDS),
      width: size[0],
      height: size[1],
      back: 1,
      front: 1,
      backOver: 1,
      frontOver: 1,
      jamb: reader.optionalNumber(raw, "jamb", "doorway", 1.5, { min: 0.1 }),
      lintel: reader.optionalNumber(raw, "lintel", "doorway", 1.5, { min: 0.1 }),
      rise: reader.optionalNumber(raw, "rise", "doorway", 1.5, { min: 0.1 }),
    };
    const geometry = doorwayGeometry(doorway);
    voussoirs.push(...geometry.voussoirs.map((v) => ({ ...v, shape: v.shape + shapes.length })));
    shapes.push(...geometry.shapes);
    visuals.push(...geometry.visuals);
    paths.push(...geometry.paths);
  }
  reader.optionalArray(obj, "colliders", "").forEach((value, i) => {
    const path = `colliders[${i}]`;
    const raw = reader.object(value, path);
    // `plain`: wall all over, whatever its shape - a railing, narrow on top, is no step.
    const keys = Object.keys(raw).filter((k) => k !== "plain");
    if (keys.length !== 1) { reader.fail(path, "expected one of { box }, { convex }, { stair }, { spiral }, { rotunda }"); return; }
    if (raw.plain !== undefined && raw.box === undefined) reader.fail(`${path}.plain`, "only a box can be plain");
    if (raw.box !== undefined && reader.boolean(raw, "plain", path, false)) plain.push(shapes.length);
    try {
      if (raw.box !== undefined) {
        const b = raw.box;
        if (!Array.isArray(b) || b.length !== 6 || !b.every((v) => typeof v === "number")) { reader.fail(`${path}.box`, "expected [x0, y0, z0, x1, y1, z1]"); return; }
        shapes.push(boxShape(b[0], b[1], b[2], b[3], b[4], b[5]));
      } else if (raw.convex !== undefined) {
        // Any convex solid, from its corners (a wedge filling the space over a sloping vault).
        const pts = raw.convex;
        if (!Array.isArray(pts) || pts.length < 4) { reader.fail(`${path}.convex`, "expected four or more [x, y, z] corners"); return; }
        shapes.push({ kind: "convex", points: pts.map((q, k) => vector(reader, q, `${path}.convex[${k}]`)) });
      } else if (raw.stair !== undefined) {
        const s = reader.object(raw.stair, `${path}.stair`);
        reader.onlyKeys(s, `${path}.stair`, ["from", "to", "width", "rise", "ceiling", "walls", "railings"]);
        const geometry = stairGeometry({
          from: vector(reader, s.from, `${path}.stair.from`),
          to: vector(reader, s.to, `${path}.stair.to`),
          width: reader.number(s, "width", `${path}.stair`, { min: 1 }),
          rise: reader.optionalNumber(s, "rise", `${path}.stair`, 0.25, { min: 0.05 }),
          ceiling: reader.optionalNumber(s, "ceiling", `${path}.stair`, 0, { min: 0 }),
          walls: reader.boolean(s, "walls", `${path}.stair`, false),
          railings: reader.boolean(s, "railings", `${path}.stair`, false),
        });
        plain.push(...(geometry.plain ?? []).map((i) => i + shapes.length));
        shapes.push(...geometry.shapes);
        paths.push(...geometry.paths);
      } else if (raw.spiral !== undefined) {
        const s = reader.object(raw.spiral, `${path}.spiral`);
        const at = `${path}.spiral`;
        reader.onlyKeys(s, at, ["centre", "top", "inner", "outer", "wall", "start", "turns", "drop", "rise", "ceiling", "flat"]);
        const centre = Array.isArray(s.centre) && s.centre.length === 2 && s.centre.every((v) => typeof v === "number") ? (s.centre as [number, number]) : (reader.fail(`${at}.centre`, "expected [x, z]"), [0, 0] as [number, number]);
        const geometry = spiralGeometry({
          centre,
          top: reader.optionalNumber(s, "top", at, 0),
          inner: reader.number(s, "inner", at, { min: 0.5 }),
          outer: reader.number(s, "outer", at, { min: 1 }),
          wall: reader.optionalNumber(s, "wall", at, 1, { min: 0.1 }),
          start: reader.number(s, "start", at),
          turns: reader.number(s, "turns", at, { min: 0.25 }),
          drop: reader.number(s, "drop", at, { min: 0.25 }),
          rise: reader.optionalNumber(s, "rise", at, 0.25, { min: 0.05 }),
          ceiling: reader.number(s, "ceiling", at, { min: 1 }),
          flat: reader.optionalNumber(s, "flat", at, 20, { min: 0 }),
        });
        whole.push(...(geometry.whole ?? []).map((i) => i + shapes.length));
        plain.push(...(geometry.plain ?? []).map((i) => i + shapes.length));
        shapes.push(...geometry.shapes);
        paths.push(...geometry.paths);
        rounds.push(centre);
      } else if (raw.rotunda !== undefined) {
        // A round room: its floor, vault, wall with its doorways, and round pillars.
        const s = reader.object(raw.rotunda, `${path}.rotunda`);
        const at = `${path}.rotunda`;
        reader.onlyKeys(s, at, ["centre", "floor", "radius", "wall", "height", "doors", "pillars"]);
        const centre = Array.isArray(s.centre) && s.centre.length === 2 && s.centre.every((v) => typeof v === "number") ? (s.centre as [number, number]) : (reader.fail(`${at}.centre`, "expected [x, z]"), [0, 0] as [number, number]);
        const doors = reader.array(s, "doors", at).map((value, k) => {
          const d = reader.object(value, `${at}.doors[${k}]`);
          reader.onlyKeys(d, `${at}.doors[${k}]`, ["facing", "width", "height", "tunnel"]);
          return { facing: reader.number(d, "facing", `${at}.doors[${k}]`), width: reader.number(d, "width", `${at}.doors[${k}]`, { min: 1 }), height: reader.number(d, "height", `${at}.doors[${k}]`, { min: 1 }), tunnel: reader.optionalNumber(d, "tunnel", `${at}.doors[${k}]`, 0, { min: 0 }) };
        });
        const p = s.pillars === undefined ? null : reader.object(s.pillars, `${at}.pillars`);
        if (p) reader.onlyKeys(p, `${at}.pillars`, ["facings", "ring", "radius"]);
        const facings = p && Array.isArray(p.facings) ? p.facings.filter((v): v is number => typeof v === "number") : [];
        const geometry = rotundaGeometry({
          centre,
          floor: reader.optionalNumber(s, "floor", at, 0),
          radius: reader.number(s, "radius", at, { min: 3 }),
          wall: reader.optionalNumber(s, "wall", at, 1, { min: 0.1 }),
          height: reader.number(s, "height", at, { min: 2 }),
          doors,
          pillars: { facings, ring: p ? reader.number(p, "ring", `${at}.pillars`, { min: 0 }) : 0, radius: p ? reader.number(p, "radius", `${at}.pillars`, { min: 0.1 }) : 1 },
        });
        whole.push(...(geometry.whole ?? []).map((i) => i + shapes.length));
        plain.push(...(geometry.plain ?? []).map((i) => i + shapes.length));
        shapes.push(...geometry.shapes);
        rounds.push(centre);
        for (const f of facings) rounds.push([centre[0] + Math.sin((f * Math.PI) / 180) * (p ? Number(p.ring) : 0), centre[1] + Math.cos((f * Math.PI) / 180) * (p ? Number(p.ring) : 0)]);
      } else {
        reader.fail(path, `unknown collider "${keys[0]}" (expected box, convex, stair, spiral or rotunda)`);
      }
    } catch (error) {
      reader.fail(path, (error as Error).message);
    }
  });
  reader.optionalArray(obj, "paths", "").forEach((line, i) => {
    if (!Array.isArray(line) || line.length < 2) { reader.fail(`paths[${i}]`, "expected a list of two or more [x, y, z] points"); return; }
    paths.push(line.map((p, k) => vector(reader, p, `paths[${i}][${k}]`)));
  });
  const spots: Record<string, Vec3[]> = {};
  if (obj.spots !== undefined) {
    const raw = reader.object(obj.spots, "spots");
    for (const [key, list] of Object.entries(raw)) {
      spots[key] = Array.isArray(list) ? list.map((p, k) => vector(reader, p, `spots.${key}[${k}]`)) : (reader.fail(`spots.${key}`, "expected a list of [x, y, z]"), []);
    }
  }
  // Its bounds: as given, or round its colliders.
  let bounds: Aabb;
  if (obj.bounds !== undefined) {
    const b = obj.bounds;
    if (Array.isArray(b) && b.length === 2) bounds = { min: vector(reader, b[0], "bounds[0]"), max: vector(reader, b[1], "bounds[1]") };
    else { reader.fail("bounds", "expected [[x0, y0, z0], [x1, y1, z1]]"); bounds = { min: vec3(), max: vec3() }; }
  } else {
    bounds = shapesBounds(shapes);
  }
  const barrel = readBarrel(reader, obj);
  // Room over its vault for a barrel, and its vault's stone over that.
  if (barrel) bounds = { min: bounds.min, max: vec3(bounds.max.x, Math.max(bounds.max.y, barrel.spring + barrel.rise + 1), bounds.max.z) };
  const tags = obj.tags === undefined ? [] : reader.stringList(obj, "tags", "");
  // Tombs on its floor, as many as asked for and fit, clear of its ways - colliders like the rest.
  const drawn = shapes.length;
  // Its altar first: its tombs and benches keep clear of it.
  const altar = readAltar(reader, obj);
  if (altar) shapes.push(altarShape(altar));
  const tombs = placeTombs(shapes, paths, spots, reader.optionalNumber(obj, "tombs", "", 0, { min: 0 }));
  shapes.push(...tombs.map(tombShape));
  // Stone benches with their backs to its walls, clear of the ways and its tombs.
  const benches = placeBenches(shapes, paths, spots, sockets, reader.optionalNumber(obj, "benches", "", 0, { min: 0 }));
  shapes.push(...benches.map(benchShape));
  // Ledger stones in rows on its floor, round its tombs: a step high, so colliders too.
  // (Laid without the altar - its top is no floor - and none under it.)
  const altarAt = altar ? altarBox(altar) : null;
  const ledgers = placeLedgers(altar ? shapes.filter((_, i) => i !== drawn) : shapes, spots, sockets.map((s) => s.at), reader.optionalNumber(obj, "ledgers", "", 0, { min: 0, max: 1 })).filter(
    (l) => {
      if (!altarAt) return true;
      const r = Math.hypot(l.half[0], l.half[1]) + 0.3;
      return l.at.x + r < altarAt.min[0] || l.at.x - r > altarAt.max[0] || l.at.z + r < altarAt.min[2] || l.at.z - r > altarAt.max[2];
    },
  );
  shapes.push(...ledgers.map(ledgerShape));
  const part: DungeonPartDef = {
    id: entry.id,
    tags,
    weight: reader.optionalNumber(obj, "weight", "", 1, { min: 0 }),
    stage: obj.stage === undefined ? [0, 1] : reader.range(obj, "stage", "", { allowEqual: true }),
    apart: obj.apart === undefined ? [] : reader.stringList(obj, "apart", ""),
    bounds,
    sockets,
    shapes,
    paths,
    spots,
    room: reader.boolean(obj, "room", "", false),
    ending: readEnding(reader, obj),
    rounds,
    doorway,
    visuals,
    whole,
    plain,
    voussoirs,
    tombs,
    benches,
    ledgers,
    drawn,
    barrel,
    altar,
    exterior: readExterior(reader, obj),
  };
  // Every way through it, on its own colliders: floor under the walk lines, and 6 m wide and high.
  const before = issues.length;
  if (shapes.length > 0 && issues.length === before) {
    // (A cap has no way through: nothing to measure, its sockets closed.)
    // (A doorway may be narrower by its stop: the one exception to the rules' least way through.)
    if (paths.length > 0 && !doorway) for (const problem of checkPaths(shapes, paths, rules.minClear, sockets)) reader.fail("paths", problem);
  }
  return part;
}

/** A style's creatures (see DungeonCreatures). */
function readCreatures(reader: Reader, raw: RawObject): DungeonCreatures {
  reader.onlyKeys(raw, "creatures", ["groups", "pick", "deeper", "boss"]);
  const groups = reader.array(raw, "groups", "creatures").map((value, i) => {
    const at = `creatures.groups[${i}]`;
    const g = reader.object(value, at);
    reader.onlyKeys(g, at, ["id", "kinds", "weight"]);
    return { id: reader.string(g, "id", at), kinds: reader.stringList(g, "kinds", at), weight: reader.optionalNumber(g, "weight", at, 1, { min: 0 }) };
  });
  return {
    groups,
    pick: reader.optionalNumber(raw, "pick", "creatures", groups.length, { min: 1 }),
    deeper: reader.optionalNumber(raw, "deeper", "creatures", 8, { min: 1 }),
    boss: reader.optionalNumber(raw, "boss", "creatures", 2, { min: 0 }),
  };
}

/** A part's outside, if it has one (see `DungeonPartDef.exterior`). */
function readExterior(reader: Reader, obj: RawObject): ExteriorDef | undefined {
  if (obj.exterior === undefined) return undefined;
  const e = reader.object(obj.exterior, "exterior");
  reader.onlyKeys(e, "exterior", ["walls", "foot", "eave", "roof", "ridge"]);
  const w = e.walls;
  if (!Array.isArray(w) || w.length !== 4 || !w.every((v) => typeof v === "number") || w[2] <= w[0] || w[3] <= w[1]) {
    reader.fail("exterior.walls", "expected [x0, z0, x1, z1], x1 > x0 and z1 > z0");
    return undefined;
  }
  return { walls: w as [number, number, number, number], foot: reader.optionalNumber(e, "foot", "exterior", -1), eave: reader.number(e, "eave", "exterior"), roof: reader.number(e, "roof", "exterior", { min: 0.5 }), ridge: e.ridge === undefined ? (w[2] - w[0] >= w[3] - w[1] ? "x" : "z") : reader.oneOf(e, "ridge", "exterior", ["x", "z"] as const) };
}

/** A part's altar, if it has one (see `DungeonPartDef.altar`). */
function readAltar(reader: Reader, obj: RawObject): AltarDef | undefined {
  if (obj.altar === undefined) return undefined;
  const a = reader.object(obj.altar, "altar");
  reader.onlyKeys(a, "altar", ["at", "facing"]);
  const facing = reader.number(a, "facing", "altar");
  if (![0, 90, 180, 270].includes(facing)) reader.fail("altar.facing", "expected 0, 90, 180 or 270");
  return { at: vector(reader, a.at, "altar.at"), facing };
}

/** A part's barrel vault, if it has one (see `DungeonPartDef.barrel`). */
function readBarrel(reader: Reader, obj: RawObject): BarrelDef | undefined {
  if (obj.barrel === undefined) return undefined;
  const b = reader.object(obj.barrel, "barrel");
  reader.onlyKeys(b, "barrel", ["over", "along", "spring", "rise"]);
  const over = b.over;
  if (!Array.isArray(over) || over.length !== 4 || !over.every((v) => typeof v === "number") || over[2] <= over[0] || over[3] <= over[1]) {
    reader.fail("barrel.over", "expected [x0, z0, x1, z1], x1 > x0 and z1 > z0");
    return undefined;
  }
  const along = b.along;
  if (along !== "x" && along !== "z") {
    reader.fail("barrel.along", 'expected "x" or "z"');
    return undefined;
  }
  const across = along === "x" ? over[3] - over[1] : over[2] - over[0];
  const rise = reader.number(b, "rise", "barrel", { min: 0.5 });
  if (rise > across / 2 + 1e-6) reader.fail("barrel.rise", `at most half its width across (${across / 2})`);
  return { over: over as [number, number, number, number], along, spring: reader.number(b, "spring", "barrel"), rise };
}

/** The box round a set of shapes, in their own frame. */
export function shapesBounds(shapes: readonly ShapeDesc[]): Aabb {
  const min = vec3(Infinity, Infinity, Infinity), max = vec3(-Infinity, -Infinity, -Infinity);
  const take = (p: Vec3): void => {
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
  };
  for (const s of shapes) {
    if (s.kind === "convex") s.points.forEach(take);
    else if (s.kind === "box") {
      // Its corners, turned.
      const r = s.rotation;
      const yaw = r ? 2 * Math.atan2(r.y, r.w) : 0;
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const lx = sx * s.half.x, lz = sz * s.half.z;
        take(vec3(s.center.x + lx * c + lz * sn, s.center.y + sy * s.half.y, s.center.z - lx * sn + lz * c));
      }
    }
  }
  return { min, max };
}

const STYLE_KEYS = ["name", "builder", "sizes", "branching", "loops", "boss", "keys", "cover", "deepest", "parts", "entrance", "caps", "connector", "look", "light", "urns", "chandeliers", "altar", "creatures", "barrels", "doorways", "trims"];

function colour(reader: Reader, value: unknown, path: string, fallback: [number, number, number]): [number, number, number] {
  if (value === undefined) return fallback;
  if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && v >= 0)) return [value[0], value[1], value[2]];
  reader.fail(path, "expected [r, g, b], each 0 or more");
  return fallback;
}

function paintOf(reader: Reader, look: RawObject, key: string, fallback: DungeonPaint): DungeonPaint {
  if (look[key] === undefined) return fallback;
  const raw = reader.object(look[key], `look.${key}`);
  reader.onlyKeys(raw, `look.${key}`, ["material", "tint"]);
  return { material: raw.material === null ? null : (reader.optionalString(raw, "material", `look.${key}`) ?? fallback.material), tint: colour(reader, raw.tint, `look.${key}.tint`, [1, 1, 1]) };
}

/** A cap's `ending`: "tomb" or "gate", or none (a plain wall). */
function readEnding(reader: Reader, obj: RawObject): "tomb" | "gate" | undefined {
  const value = reader.optionalString(obj, "ending", "");
  if (value === undefined || value === "tomb" || value === "gate") return value;
  reader.fail("ending", `expected "tomb" or "gate", got "${value}"`);
  return undefined;
}

function readLook(reader: Reader, raw: RawObject): KitLook {
  reader.onlyKeys(raw, "look", ["floor", "wall", "ceiling", "steps", "tread", "riser", "frame", "door", "trim", "niche", "tomb", "iron", "dark", "breach", "outside", "roof"]);
  const stone: DungeonPaint = { material: "stoneBricks", tint: [1, 1, 1] };
  const floor = paintOf(reader, raw, "floor", stone);
  const wall = paintOf(reader, raw, "wall", stone);
  const steps = paintOf(reader, raw, "steps", floor);
  return { floor, wall, ceiling: paintOf(reader, raw, "ceiling", stone), steps, tread: paintOf(reader, raw, "tread", steps), riser: paintOf(reader, raw, "riser", steps), frame: paintOf(reader, raw, "frame", wall), trim: paintOf(reader, raw, "trim", paintOf(reader, raw, "frame", wall)), niche: paintOf(reader, raw, "niche", wall), tomb: paintOf(reader, raw, "tomb", paintOf(reader, raw, "trim", paintOf(reader, raw, "frame", wall))), door: paintOf(reader, raw, "door", { material: "doorBoards", tint: [1, 1, 1] }), iron: paintOf(reader, raw, "iron", { material: "iron", tint: [1, 1, 1] }), dark: paintOf(reader, raw, "dark", { material: "rubbleStone", tint: [0.04, 0.04, 0.045] }), breach: paintOf(reader, raw, "breach", { material: "rubbleStone", tint: [0.55, 0.52, 0.48] }), outside: paintOf(reader, raw, "outside", wall), roof: paintOf(reader, raw, "roof", { material: "roofTiles", tint: [1, 1, 1] }) };
}

function readTrims(reader: Reader, raw: RawObject): WallTrims {
  reader.onlyKeys(raw, "trims", ["plinth", "cornice", "ribs", "coping", "loculi", "arcosolia", "breaches"]);
  const band = (key: string): TrimProfile | undefined => {
    if (raw[key] === undefined) return undefined;
    const b = reader.object(raw[key], `trims.${key}`);
    reader.onlyKeys(b, `trims.${key}`, ["height", "proud"]);
    return { height: reader.number(b, "height", `trims.${key}`, { min: 0.05 }), proud: reader.number(b, "proud", `trims.${key}`, { min: 0.01 }) };
  };
  let ribs: RibSpec | undefined;
  if (raw.ribs !== undefined) {
    const r = reader.object(raw.ribs, "trims.ribs");
    reader.onlyKeys(r, "trims.ribs", ["spacing", "width", "depth", "pilaster"]);
    const p = r.pilaster === undefined ? undefined : reader.object(r.pilaster, "trims.ribs.pilaster");
    if (p) reader.onlyKeys(p, "trims.ribs.pilaster", ["width", "proud"]);
    ribs = {
      spacing: reader.number(r, "spacing", "trims.ribs", { min: 1 }),
      width: reader.number(r, "width", "trims.ribs", { min: 0.05 }),
      depth: reader.number(r, "depth", "trims.ribs", { min: 0.05 }),
      pilaster: p ? { width: reader.number(p, "width", "trims.ribs.pilaster", { min: 0.05 }), proud: reader.number(p, "proud", "trims.ribs.pilaster", { min: 0.01 }) } : undefined,
    };
  }
  let coping: CopingSpec | undefined;
  if (raw.coping !== undefined) {
    const c = reader.object(raw.coping, "trims.coping");
    reader.onlyKeys(c, "trims.coping", ["height", "overhang"]);
    coping = { height: reader.number(c, "height", "trims.coping", { min: 0.05 }), overhang: reader.number(c, "overhang", "trims.coping", { min: 0 }) };
  }
  let loculi: LoculiSpec | undefined;
  if (raw.loculi !== undefined) {
    const l = reader.object(raw.loculi, "trims.loculi");
    const at = "trims.loculi";
    reader.onlyKeys(l, at, ["width", "height", "depth", "gap", "rowGap", "above", "rows", "tallRows", "tallWall", "margin", "sealed", "frame"]);
    const fr = l.frame === undefined ? undefined : reader.object(l.frame, `${at}.frame`);
    if (fr) reader.onlyKeys(fr, `${at}.frame`, ["width", "proud", "bevel"]);
    loculi = {
      width: reader.number(l, "width", at, { min: 0.3 }),
      height: reader.number(l, "height", at, { min: 0.3 }),
      depth: reader.number(l, "depth", at, { min: 0.1 }),
      gap: reader.number(l, "gap", at, { min: 0.1 }),
      rowGap: reader.number(l, "rowGap", at, { min: 0.1 }),
      above: reader.number(l, "above", at, { min: 0 }),
      rows: reader.number(l, "rows", at, { min: 1 }),
      tallRows: l.tallRows === undefined ? undefined : reader.number(l, "tallRows", at, { min: 1 }),
      tallWall: l.tallWall === undefined ? undefined : reader.number(l, "tallWall", at, { min: 1 }),
      margin: reader.optionalNumber(l, "margin", at, 0.5, { min: 0 }),
      sealed: reader.optionalNumber(l, "sealed", at, 0.4, { min: 0, max: 1 }),
      frame: fr ? { width: reader.number(fr, "width", `${at}.frame`, { min: 0.02 }), proud: reader.number(fr, "proud", `${at}.frame`, { min: 0.01 }), bevel: reader.number(fr, "bevel", `${at}.frame`, { min: 0 }) } : undefined,
    };
  }
  let arcosolia: ArcosoliaSpec | undefined;
  if (raw.arcosolia !== undefined) {
    const at = "trims.arcosolia";
    const l = reader.object(raw.arcosolia, at);
    reader.onlyKeys(l, at, ["width", "rise", "depth", "above", "margin", "count", "frame", "tomb"]);
    const fr = l.frame === undefined ? undefined : reader.object(l.frame, `${at}.frame`);
    if (fr) reader.onlyKeys(fr, `${at}.frame`, ["width", "proud", "bevel"]);
    const tb = l.tomb === undefined ? undefined : reader.object(l.tomb, `${at}.tomb`);
    if (tb) reader.onlyKeys(tb, `${at}.tomb`, ["height", "inset", "lid", "lidOut"]);
    arcosolia = {
      width: reader.number(l, "width", at, { min: 1 }),
      rise: reader.number(l, "rise", at, { min: 0 }),
      depth: reader.number(l, "depth", at, { min: 0.1 }),
      above: reader.number(l, "above", at, { min: 0 }),
      margin: reader.optionalNumber(l, "margin", at, 0.5, { min: 0 }),
      count: reader.optionalNumber(l, "count", at, 2, { min: 0 }),
      frame: fr ? { width: reader.number(fr, "width", `${at}.frame`, { min: 0.02 }), proud: reader.number(fr, "proud", `${at}.frame`, { min: 0.01 }), bevel: reader.number(fr, "bevel", `${at}.frame`, { min: 0 }) } : undefined,
      tomb: tb ? { height: reader.number(tb, "height", `${at}.tomb`, { min: 0.1 }), inset: reader.number(tb, "inset", `${at}.tomb`, { min: 0 }), lid: reader.number(tb, "lid", `${at}.tomb`, { min: 0.02 }), lidOut: reader.number(tb, "lidOut", `${at}.tomb`, { min: 0 }) } : undefined,
    };
  }
  let breaches: BreachSpec | undefined;
  if (raw.breaches !== undefined) {
    const at = "trims.breaches";
    const b = reader.object(raw.breaches, at);
    reader.onlyKeys(b, at, ["share", "count", "width", "height", "depth", "above", "margin", "heap", "vaults"]);
    const v = b.vaults === undefined ? undefined : reader.object(b.vaults, `${at}.vaults`);
    if (v) reader.onlyKeys(v, `${at}.vaults`, ["share", "size", "heap"]);
    breaches = {
      share: reader.optionalNumber(b, "share", at, 0.2, { min: 0, max: 1 }),
      count: reader.optionalNumber(b, "count", at, 2, { min: 0, integer: true }),
      width: reader.range(b, "width", at, { allowEqual: true }),
      height: reader.range(b, "height", at, { allowEqual: true }),
      depth: reader.number(b, "depth", at, { min: 0.05 }),
      above: reader.optionalNumber(b, "above", at, 1, { min: 0 }),
      margin: reader.optionalNumber(b, "margin", at, 0.8, { min: 0 }),
      heap: reader.optionalNumber(b, "heap", at, 0.6, { min: 0.05 }),
      vaults: v ? { share: reader.optionalNumber(v, "share", `${at}.vaults`, 0.25, { min: 0, max: 1 }), size: reader.range(v, "size", `${at}.vaults`, { allowEqual: true }), heap: reader.optionalNumber(v, "heap", `${at}.vaults`, 0.9, { min: 0.05 }) } : undefined,
    };
  }
  return { plinth: band("plinth"), cornice: band("cornice"), ribs, coping, loculi, arcosolia, breaches };
}

/** A prop set at some share of the places it may go: `{ prop, share }`. */
function readPropShare(reader: Reader, raw: RawObject, path: string, prop: string): { prop: string; share: number } {
  reader.onlyKeys(raw, path, ["prop", "share"]);
  return { prop: reader.optionalString(raw, "prop", path) ?? prop, share: reader.optionalNumber(raw, "share", path, 0.4, { min: 0, max: 1 }) };
}

function readLight(reader: Reader, raw: RawObject): DungeonLight {
  reader.onlyKeys(raw, "light", ["ambient", "fixture", "lit", "candles"]);
  const candles = raw.candles === undefined ? undefined : readPropShare(reader, reader.object(raw.candles, "light.candles"), "light.candles", "candles");
  return {
    candles,
    ambient: colour(reader, raw.ambient, "light.ambient", [0.02, 0.02, 0.025]),
    fixture: reader.optionalString(raw, "fixture", "light") ?? "wallTorch",
    lit: reader.optionalNumber(raw, "lit", "light", 1, { min: 0, max: 1 }),
  };
}

function readStyle(entry: Entry, allParts: Map<string, DungeonPartDef>, rules: DungeonRules, issues: ContentIssue[]): DungeonStyleDef {
  const reader = new Reader(issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", STYLE_KEYS);
  const sizesRaw = reader.object(obj.sizes, "sizes");
  const sizes: Record<string, DungeonSize> = {};
  for (const [key, value] of Object.entries(sizesRaw)) {
    const raw = reader.object(value, `sizes.${key}`);
    reader.onlyKeys(raw, `sizes.${key}`, ["rooms", "entry"]);
    sizes[key] = { rooms: reader.range(raw, "rooms", `sizes.${key}`, { allowEqual: true }), entry: reader.oneOf(raw, "entry", `sizes.${key}`, ["seamless", "space"] as const) };
  }
  if (Object.keys(sizes).length === 0) reader.fail("sizes", "a style needs at least one size");
  /** The parts with every one of a selector's tags. */
  const select = (key: string, extra: string[] = []): DungeonPartDef[] => {
    const raw = obj[key] === undefined ? {} : reader.object(obj[key], key);
    reader.onlyKeys(raw, key, ["tags"]);
    const tags = [...(raw.tags === undefined ? [] : reader.stringList(raw, "tags", key)), ...extra];
    return [...allParts.values()].filter((p) => tags.every((t) => p.tags.includes(t)));
  };
  const all = select("parts");
  const allTags = (obj.parts === undefined ? [] : reader.stringList(reader.object(obj.parts, "parts"), "tags", "parts"));
  const inStyle = (key: string, fallback: string): DungeonPartDef[] => {
    const raw = obj[key] === undefined ? { tags: [fallback] } : reader.object(obj[key], key);
    reader.onlyKeys(raw, key, ["tags"]);
    const tags = raw.tags === undefined ? [] : reader.stringList(raw, "tags", key);
    return all.filter((p) => tags.every((t) => p.tags.includes(t)));
  };
  const entrances = inStyle("entrance", "entrance");
  const caps = inStyle("caps", "cap");
  const bossRaw = obj.boss === undefined ? { tags: ["boss"] } : reader.object(obj.boss, "boss");
  reader.onlyKeys(bossRaw, "boss", ["tags"]);
  const bossTags = bossRaw.tags === undefined ? [] : reader.stringList(bossRaw, "tags", "boss");
  const bosses = all.filter((p) => bossTags.every((t) => p.tags.includes(t)));
  const doorways = obj.doorways === undefined ? [] : inStyle("doorways", "doorway");
  const special = new Set([...entrances, ...caps, ...bosses, ...all.filter((p) => p.doorway)]);
  const parts = all.filter((p) => !special.has(p));
  const keys = obj.keys === undefined ? {} : reader.object(obj.keys, "keys");
  reader.onlyKeys(keys, "keys", ["locks"]);
  const style: DungeonStyleDef = {
    id: entry.id,
    name: reader.optionalString(obj, "name", "") ?? entry.id,
    builder: reader.oneOf(obj, "builder", "", ["kit"] as const),
    sizes,
    branching: reader.optionalNumber(obj, "branching", "", 0.35, { min: 0, max: 1 }),
    loops: obj.loops === undefined ? [0, 0] : reader.range(obj, "loops", "", { allowEqual: true }),
    cover: reader.optionalNumber(obj, "cover", "", 8, { min: 0 }),
    deepest: reader.optionalNumber(obj, "deepest", "", 60, { min: 1 }),
    parts,
    entrances,
    bosses,
    caps,
    locks: keys.locks === undefined ? [0, 0] : reader.range(keys, "locks", "keys", { allowEqual: true }),
    connector: obj.connector === undefined ? null : readConnector(reader, reader.object(obj.connector, "connector"), all, rules),
    look: readLook(reader, obj.look === undefined ? {} : reader.object(obj.look, "look")),
    doorways,
    trims: readTrims(reader, obj.trims === undefined ? {} : reader.object(obj.trims, "trims")),
    light: readLight(reader, obj.light === undefined ? {} : reader.object(obj.light, "light")),
    urns: obj.urns === undefined ? undefined : readPropShare(reader, reader.object(obj.urns, "urns"), "urns", "urn"),
    barrels: reader.optionalNumber(obj, "barrels", "", 0, { min: 0, max: 1 }),
    altar: reader.optionalString(obj, "altar", ""),
    creatures: obj.creatures === undefined ? undefined : readCreatures(reader, reader.object(obj.creatures, "creatures")),
    chandeliers: obj.chandeliers === undefined ? undefined : readPropShare(reader, reader.object(obj.chandeliers, "chandeliers"), "chandeliers", "chandelier"),
  };
  if (style.loops[1] > 0 && !style.connector) reader.fail("loops", "a style with loops needs a `connector` to make them with");
  // Able to start, grow, end and close.
  const where = allTags.length ? ` with the tags ${allTags.join(", ")}` : "";
  if (entrances.length === 0) reader.fail("entrance", `no part${where} is an entrance`);
  if (bosses.length === 0) reader.fail("boss", `no part${where} is a boss room`);
  if (!parts.some((p) => p.room)) reader.fail("parts", `no part${where} is a room to grow`);
  const types = new Set(all.flatMap((p) => p.sockets.map((s) => s.type)));
  for (const type of types) {
    if (type === "surface") continue;
    if (!caps.some((c) => c.sockets.some((s) => socketsJoin(rules, s.type, type)))) reader.fail("caps", `no cap closes a "${type}" socket, so a layout could not always be closed`);
  }
  for (const e of entrances) if (!e.sockets.some((s) => s.type === "surface")) reader.fail("entrance", `the entrance "${e.id}" has no "surface" socket to stand at the mouth`);
  return style;
}

function readConnector(reader: Reader, raw: RawObject, all: readonly DungeonPartDef[], rules: DungeonRules): ConnectorDef {
  const at = "connector";
  reader.onlyKeys(raw, at, ["socket", "corner", "width", "height", "wall", "rise", "tread"]);
  const cornerRaw = raw.corner === undefined ? { tags: ["corner"] } : reader.object(raw.corner, `${at}.corner`);
  reader.onlyKeys(cornerRaw, `${at}.corner`, ["tags"]);
  const tags = cornerRaw.tags === undefined ? [] : reader.stringList(cornerRaw, "tags", `${at}.corner`);
  const socket = reader.string(raw, "socket", at);
  const width = reader.optionalNumber(raw, "width", at, rules.minClear[0], { min: rules.minClear[0] });
  const height = reader.optionalNumber(raw, "height", at, rules.minClear[1], { min: rules.minClear[1] });
  // Each corner, entered either way: where its turn is, from its sockets alone.
  const corners: CornerTurn[] = [];
  for (const part of all.filter((p) => tags.every((t) => p.tags.includes(t)))) {
    if (part.sockets.length !== 2) { reader.fail(`${at}.corner`, `the corner "${part.id}" needs two sockets, has ${part.sockets.length}`); continue; }
    for (const entry of [0, 1]) {
      const exit = 1 - entry;
      const s = part.sockets[entry], x = part.sockets[exit];
      const inF = (s.facing + 180) * (Math.PI / 180), outF = x.facing * (Math.PI / 180);
      const h = [Math.sin(inF), Math.cos(inF)], h2 = [Math.sin(outF), Math.cos(outF)];
      const d = [x.at.x - s.at.x, x.at.z - s.at.z];
      const reachIn = d[0] * h[0] + d[1] * h[1], reachOut = d[0] * h2[0] + d[1] * h2[1];
      const across = Math.abs(h[0] * h2[0] + h[1] * h2[1]);
      const left = d[0] - h[0] * reachIn - h2[0] * reachOut, leftZ = d[1] - h[1] * reachIn - h2[1] * reachOut;
      if (across > 1e-6 || Math.hypot(left, leftZ) > 1e-6 || Math.abs(x.at.y - s.at.y) > 1e-6 || reachIn < 0 || reachOut < 0) {
        reader.fail(`${at}.corner`, `"${part.id}" is not a level quarter turn between its two sockets`);
        break;
      }
      const turn = ((((x.facing - (s.facing + 180)) % 360) + 360) % 360) === 90 ? 1 : -1;
      corners.push({ part, entry, exit, reachIn, reachOut, turn });
    }
  }
  if (!corners.some((c) => c.turn === 1) || !corners.some((c) => c.turn === -1)) reader.fail(`${at}.corner`, `no part${tags.length ? ` with the tags ${tags.join(", ")}` : ""} turns both ways, so loops could not be routed`);
  return {
    socket,
    width,
    height,
    wall: reader.optionalNumber(raw, "wall", at, 1, { min: 0.1 }),
    rise: reader.optionalNumber(raw, "rise", at, 0.25, { min: 0.05 }),
    tread: reader.optionalNumber(raw, "tread", at, 0.75, { min: 0.1 }),
    corners,
  };
}
