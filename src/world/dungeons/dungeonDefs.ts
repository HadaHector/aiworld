// Dungeon styles and parts from the packs (DUNGEONS.md): `dungeonStyles/`, `dungeonParts/` and
// `rules/dungeons.json5`, read and checked - every part's walk lines 6 m wide and high on its own
// colliders, every style able to start, grow and close.
import { ContentError, Reader, type ContentIssue, type RawObject } from "../content/contentReader";
import { DUNGEON_FOLDERS, orderPacks, parseFile, type PackSource } from "../content/resolveContent";
import { vec3, type Aabb, type ShapeDesc, type Vec3 } from "../collision/index";
import { boxShape, doorwayGeometry, DOORWAY_KINDS, spiralGeometry, stairGeometry, type DoorwaySpec, type Polyline } from "./kitShapes";
import { checkPaths } from "./clearance";

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
  /** How it is lit (DUNGEONS.md, *Light*). */
  light: DungeonLight;
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
  door: DungeonPaint;
}

export interface DungeonLight {
  /** The light everywhere, lit or not, so unlit rock is a dark shape rather than a hole. */
  ambient: [number, number, number];
  /** The prop standing at a part's `light` spots (a wall torch), and the share of spots that have one. */
  fixture: string;
  lit: number;
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

const PART_KEYS = ["tags", "weight", "stage", "bounds", "sockets", "colliders", "paths", "spots", "room", "doorway"];

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
      jamb: reader.optionalNumber(raw, "jamb", "doorway", 2, { min: 0.1 }),
      lintel: reader.optionalNumber(raw, "lintel", "doorway", 1.5, { min: 0.1 }),
      rise: reader.optionalNumber(raw, "rise", "doorway", 1.5, { min: 0.1 }),
    };
    const geometry = doorwayGeometry(doorway);
    shapes.push(...geometry.shapes);
    visuals.push(...geometry.visuals);
    paths.push(...geometry.paths);
  }
  reader.optionalArray(obj, "colliders", "").forEach((value, i) => {
    const path = `colliders[${i}]`;
    const raw = reader.object(value, path);
    const keys = Object.keys(raw);
    if (keys.length !== 1) { reader.fail(path, "expected one of { box }, { stair }, { spiral }"); return; }
    try {
      if (raw.box !== undefined) {
        const b = raw.box;
        if (!Array.isArray(b) || b.length !== 6 || !b.every((v) => typeof v === "number")) { reader.fail(`${path}.box`, "expected [x0, y0, z0, x1, y1, z1]"); return; }
        shapes.push(boxShape(b[0], b[1], b[2], b[3], b[4], b[5]));
      } else if (raw.stair !== undefined) {
        const s = reader.object(raw.stair, `${path}.stair`);
        reader.onlyKeys(s, `${path}.stair`, ["from", "to", "width", "rise", "ceiling", "walls"]);
        const geometry = stairGeometry({
          from: vector(reader, s.from, `${path}.stair.from`),
          to: vector(reader, s.to, `${path}.stair.to`),
          width: reader.number(s, "width", `${path}.stair`, { min: 1 }),
          rise: reader.optionalNumber(s, "rise", `${path}.stair`, 0.25, { min: 0.05 }),
          ceiling: reader.optionalNumber(s, "ceiling", `${path}.stair`, 0, { min: 0 }),
          walls: reader.boolean(s, "walls", `${path}.stair`, false),
        });
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
      } else {
        reader.fail(path, `unknown collider "${keys[0]}" (expected box, stair or spiral)`);
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
  const tags = obj.tags === undefined ? [] : reader.stringList(obj, "tags", "");
  const part: DungeonPartDef = {
    id: entry.id,
    tags,
    weight: reader.optionalNumber(obj, "weight", "", 1, { min: 0 }),
    stage: obj.stage === undefined ? [0, 1] : reader.range(obj, "stage", "", { allowEqual: true }),
    bounds,
    sockets,
    shapes,
    paths,
    spots,
    room: reader.boolean(obj, "room", "", false),
    rounds,
    doorway,
    visuals,
    whole,
    plain,
  };
  // Every way through it, on its own colliders: floor under the walk lines, and 6 m wide and high.
  const before = issues.length;
  if (shapes.length > 0 && issues.length === before) {
    // (A cap has no way through: nothing to measure, its sockets closed.)
    if (paths.length > 0) for (const problem of checkPaths(shapes, paths, rules.minClear, sockets)) reader.fail("paths", problem);
  }
  return part;
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

const STYLE_KEYS = ["name", "builder", "sizes", "branching", "loops", "boss", "keys", "cover", "deepest", "parts", "entrance", "caps", "connector", "look", "light", "doorways"];

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

function readLook(reader: Reader, raw: RawObject): KitLook {
  reader.onlyKeys(raw, "look", ["floor", "wall", "ceiling", "steps", "tread", "riser", "frame", "door"]);
  const stone: DungeonPaint = { material: "stoneBricks", tint: [1, 1, 1] };
  const floor = paintOf(reader, raw, "floor", stone);
  const wall = paintOf(reader, raw, "wall", stone);
  const steps = paintOf(reader, raw, "steps", floor);
  return { floor, wall, ceiling: paintOf(reader, raw, "ceiling", stone), steps, tread: paintOf(reader, raw, "tread", steps), riser: paintOf(reader, raw, "riser", steps), frame: paintOf(reader, raw, "frame", wall), door: paintOf(reader, raw, "door", { material: "doorBoards", tint: [1, 1, 1] }) };
}

function readLight(reader: Reader, raw: RawObject): DungeonLight {
  reader.onlyKeys(raw, "light", ["ambient", "fixture", "lit"]);
  return {
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
    light: readLight(reader, obj.light === undefined ? {} : reader.object(obj.light, "light")),
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
