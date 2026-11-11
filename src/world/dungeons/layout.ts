// The dungeon generator (DUNGEONS.md, *The generator*): pure and deterministic - a style, a size, a
// seed, where the entrance stands and the ground over it in; a layout of placed parts and the
// sockets joining them out. Every part but the entrance lies the style's cover under the ground.
import { deriveSeed, mulberry32 } from "../rng";
import { quatFromEuler, quatMul, vec3, type Aabb, type Quat, type ShapeDesc, type Vec3 } from "../collision/index";
import { socketsJoin, type DungeonContent, type DungeonPartDef, type DungeonStyleDef, type SocketDef } from "./dungeonDefs";
import type { Polyline } from "./kitShapes";

/** What the generator knows of the world above: the ground's height, and whether a building stands there. */
export interface DungeonGround {
  heightAt(x: number, z: number): number;
  builtAt(x: number, z: number): boolean;
}

/** Where the entrance's `surface` socket stands, and which way its opening faces (degrees, 0 = +z). */
export interface DungeonSite {
  x: number;
  y: number;
  z: number;
  facing: number;
}

export interface PlacedPart {
  part: DungeonPartDef;
  /** Its origin in the world and its turn about y, radians (facing 0 = +z, as sockets). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  bounds: Aabb;
  /** Which of its sockets it was joined by (-1: the entrance), and to which part. */
  entry: number;
  parent: number;
  role: "entrance" | "room" | "way" | "boss" | "cap";
}

export interface Join {
  a: number;
  socketA: number;
  b: number;
  socketB: number;
  /** Grown from a to b, or a loop closing two open ends. */
  loop: boolean;
}

export interface DungeonLayout {
  style: string;
  size: string;
  seed: number;
  /** The attempt that succeeded (0 the first); `minimal` when none did. */
  attempt: number;
  minimal: boolean;
  parts: PlacedPart[];
  joins: Join[];
  boss: number;
  /** The join locked on the way to the boss, and the part its key lies in; -1 for none. */
  lock: number;
  key: number;
  /** Why each failed attempt failed. */
  failures: string[];
}

interface WorldSocket {
  part: number;
  socket: number;
  at: Vec3;
  facing: number;
  def: SocketDef;
}

const DEG = Math.PI / 180;
/** Ways taken back from dead ends, an attempt, before it gives up. */
const MAX_BACKTRACKS = 40;

/** A point in a part's frame, in the world. */
export function toWorld(p: PlacedPart, local: Vec3): Vec3 {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  return vec3(p.x + local.x * c + local.z * s, p.y + local.y, p.z - local.x * s + local.z * c);
}

function socketOf(placed: PlacedPart[], part: number, socket: number): WorldSocket {
  const p = placed[part];
  const def = p.part.sockets[socket];
  return { part, socket, at: toWorld(p, def.at), facing: normalDegrees(def.facing + p.yaw / DEG), def };
}

const normalDegrees = (d: number): number => ((d % 360) + 360) % 360;

function boundsOf(part: DungeonPartDef, x: number, y: number, z: number, yaw: number): Aabb {
  const probe: PlacedPart = { part, x, y, z, yaw, bounds: part.bounds, entry: -1, parent: -1, role: "way" };
  const min = vec3(Infinity, Infinity, Infinity), max = vec3(-Infinity, -Infinity, -Infinity);
  const b = part.bounds;
  for (const lx of [b.min.x, b.max.x]) for (const ly of [b.min.y, b.max.y]) for (const lz of [b.min.z, b.max.z]) {
    const p = toWorld(probe, vec3(lx, ly, lz));
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
  }
  return { min, max };
}

/** Puts `part` so its socket `entry` meets the open socket `to`, facing it. */
function placeAt(part: DungeonPartDef, entry: number, to: WorldSocket): Omit<PlacedPart, "parent" | "role"> {
  const s = part.sockets[entry];
  const yaw = normalDegrees(to.facing + 180 - s.facing) * DEG;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const x = to.at.x - (s.at.x * c + s.at.z * sn);
  const y = to.at.y - s.at.y;
  const z = to.at.z - (-s.at.x * sn + s.at.z * c);
  return { part, x, y, z, yaw, bounds: boundsOf(part, x, y, z, yaw), entry };
}

/** Whether two boxes overlap by more than a sliver (parts touch where they join). */
function overlaps(a: Aabb, b: Aabb, slack = 0.05): boolean {
  return a.min.x < b.max.x - slack && a.max.x > b.min.x + slack && a.min.y < b.max.y - slack && a.max.y > b.min.y + slack && a.min.z < b.max.z - slack && a.max.z > b.min.z + slack;
}

/**
 * Generates a layout: tries `rules.attempts` seeds derived from `seed`, the first that passes every
 * check kept; failing all, the minimal one - the entrance, a room if one fits, and caps.
 */
export function generateLayout(content: DungeonContent, styleId: string, size: string, seed: number, site: DungeonSite, ground: DungeonGround): DungeonLayout {
  const style = content.styles.get(styleId);
  if (!style) throw new Error(`no dungeon style "${styleId}"`);
  const range = style.sizes[size];
  if (!range) throw new Error(`the dungeon style "${styleId}" has no size "${size}" (it has ${Object.keys(style.sizes).join(", ")})`);
  const heights = new Map<string, { h: number; built: boolean }>();
  const failures: string[] = [];
  // Mixed first, so small neighbouring seeds' attempts never share a seed.
  const root = deriveSeed(deriveSeed(seed, 0x6d2b79f5), seed);
  for (let attempt = 0; attempt < content.rules.attempts; attempt++) {
    const result = attemptLayout(content, style, size, deriveSeed(root, attempt + 1), site, ground, heights, false);
    if (typeof result === "string") { failures.push(result); continue; }
    return { ...result, seed, attempt, failures };
  }
  const minimal = attemptLayout(content, style, size, deriveSeed(root, 0), site, ground, heights, true);
  if (typeof minimal === "string") throw new Error(`not even the minimal ${styleId} layout fits here: ${minimal}`);
  return { ...minimal, seed, attempt: content.rules.attempts, minimal: true, failures };
}

type Attempt = Omit<DungeonLayout, "seed" | "attempt" | "failures">;

function attemptLayout(content: DungeonContent, style: DungeonStyleDef, size: string, seed: number, site: DungeonSite, ground: DungeonGround, heights: Map<string, { h: number; built: boolean }>, minimal: boolean): Attempt | string {
  const rules = content.rules;
  const random = mulberry32(seed);
  const roll = ([lo, hi]: [number, number]): number => lo + Math.floor(random() * (hi - lo + 1));
  const targetRooms = minimal ? 1 : roll(style.sizes[size].rooms);
  const placed: PlacedPart[] = [];
  const joins: Join[] = [];

  /** The ground at a point of the sampling grid, cached across attempts. */
  const groundAt = (gx: number, gz: number): { h: number; built: boolean } => {
    const key = `${gx},${gz}`;
    let g = heights.get(key);
    if (!g) {
      const x = gx * rules.sample, z = gz * rules.sample;
      g = { h: ground.heightAt(x, z), built: ground.builtAt(x, z) };
      heights.set(key, g);
    }
    return g;
  };
  /** The least rock over a box (negative: it shows), under buildings counting half. */
  const coverOver = (b: Aabb): number => {
    let least = Infinity;
    const s = rules.sample;
    for (let gx = Math.floor((b.min.x - rules.around) / s); gx <= Math.ceil((b.max.x + rules.around) / s); gx++) {
      for (let gz = Math.floor((b.min.z - rules.around) / s); gz <= Math.ceil((b.max.z + rules.around) / s); gz++) {
        const g = groundAt(gx, gz);
        const rock = g.h - b.max.y;
        least = Math.min(least, g.built ? rock / 2 : rock);
      }
    }
    return least;
  };
  const coverAt = (x: number, z: number): number => groundAt(Math.round(x / rules.sample), Math.round(z / rules.sample)).h;

  /** Whether a part may stand where it was put: clear of every other part, deep enough. */
  const fits = (b: Aabb, except: readonly number[]): string | null => {
    for (let i = 0; i < placed.length; i++) if (!except.includes(i) && overlaps(b, placed[i].bounds)) return "overlap";
    if (b.min.y < site.y - style.deepest) return "too deep";
    if (coverOver(b) < style.cover) return "too near the surface";
    return null;
  };

  // 1. The entrance, its `surface` socket at the site.
  const entrances = style.entrances.filter((p) => p.sockets.some((s) => s.type === "surface"));
  const entrancePart = pickWeighted(entrances, (p) => p.weight, random);
  if (!entrancePart) return "no entrance";
  const mouth = entrancePart.sockets.findIndex((s) => s.type === "surface");
  const surface: WorldSocket = { part: -1, socket: -1, at: vec3(site.x, site.y, site.z), facing: normalDegrees(site.facing + 180), def: entrancePart.sockets[mouth] };
  placed.push({ ...placeAt(entrancePart, mouth, surface), entry: mouth, parent: -1, role: "entrance" });

  /** Ends to grow from; ends set aside by the branching roll, grown from only if the others run
   *  out; ends nothing would fit at. All three are capped at the close. */
  const open: WorldSocket[] = [];
  const spare: WorldSocket[] = [];
  const toCap: WorldSocket[] = [];
  /** A placed part's sockets other than the one it came in by: the best into the hill first; the
   *  first kept open, each further one kept by the style's branching, the rest spare. */
  const openSocketsOf = (index: number, all: boolean): void => {
    const p = placed[index];
    const others = p.part.sockets.map((_, i) => i).filter((i) => i !== p.entry).map((i) => socketOf(placed, index, i));
    const ahead = (s: WorldSocket): number => coverAt(s.at.x + Math.sin(s.facing * DEG) * 10, s.at.z + Math.cos(s.facing * DEG) * 10) - coverAt(s.at.x, s.at.z);
    others.sort((a, b) => ahead(b) - ahead(a));
    others.forEach((s, i) => (all || i === 0 || random() < style.branching ? open : spare).push(s));
  };
  openSocketsOf(0, false);

  let rooms = 0;
  const maxParts = targetRooms * 6 + 10;
  /** Options taken back from an end, as led nowhere: by "part:socket", the "partId:entry"s. */
  const refused = new Map<string, Set<string>>();
  let backtracks = 0;
  /** Picks and places a part at an open socket, or returns why none fit. */
  const grow = (at: WorldSocket, pool: readonly DungeonPartDef[], role: (p: DungeonPartDef) => PlacedPart["role"], except: number[]): number | string => {
    const headroom = coverAt(at.at.x, at.at.z) - (at.at.y + at.def.size[1]);
    const diving = headroom < style.cover + rules.thinCover;
    const stage = rooms / Math.max(1, targetRooms);
    const options: { part: DungeonPartDef; entry: number; weight: number }[] = [];
    for (const part of pool) {
      if (stage < part.stage[0] - 1e-9 || stage > part.stage[1] + 1e-9) continue;
      part.sockets.forEach((s, entry) => {
        if (s.type === "surface" || !socketsJoin(rules, s.type, at.def.type)) return;
        const rise = Math.max(0, ...part.sockets.filter((_, i) => i !== entry).map((o) => o.at.y - s.at.y));
        const drop = Math.min(0, ...part.sockets.filter((_, i) => i !== entry).map((o) => o.at.y - s.at.y));
        let weight = part.weight / part.sockets.length;
        if (refused.get(`${at.part}:${at.socket}`)?.has(`${part.id}:${entry}`)) return;
        if (diving) {
          if (rise > 0.5) return;
          if (drop < -1) weight *= rules.diveWeight;
        }
        options.push({ part, entry, weight });
      });
    }
    let why = "nothing joins";
    // Picked by weight, each option once, up to the rules' tries.
    for (let t = 0; t < rules.triesPerSocket && options.length > 0; t++) {
      const option = pickWeighted(options, (o) => o.weight, random)!;
      options.splice(options.indexOf(option), 1);
      const put = placeAt(option.part, option.entry, at);
      const problem = fits(put.bounds, [at.part, ...except]);
      if (problem) { why = problem; continue; }
      placed.push({ ...put, parent: at.part, role: role(option.part) });
      const index = placed.length - 1;
      joins.push({ a: at.part, socketA: at.socket, b: index, socketB: option.entry, loop: false });
      return index;
    }
    return why;
  };

  // 2. Grow, breadth first, until there are rooms enough.
  while (rooms < targetRooms && placed.length < maxParts) {
    if (open.length === 0 && spare.length > 0) open.push(spare.shift()!);
    if (open.length === 0) break;
    const at = open.shift()!;
    const made = grow(at, style.parts, (p) => (p.room ? "room" : "way"), []);
    if (typeof made === "string") {
      // A dead end with nothing else to grow from, at the end of a way just laid (a corridor, a
      // stair): take the way back and try something else where it began.
      const last = placed.length - 1;
      if (open.length === 0 && spare.length === 0 && at.part === last && last > 0 && placed[last].role === "way" && backtracks < MAX_BACKTRACKS) {
        backtracks++;
        const way = placed.pop()!;
        const k = joins.findIndex((j) => j.b === last);
        const back = socketOf(placed, joins[k].a, joins[k].socketA);
        joins.splice(k, 1);
        for (const list of [open, spare, toCap]) for (let i = list.length - 1; i >= 0; i--) if (list[i].part === last) list.splice(i, 1);
        const key = `${back.part}:${back.socket}`;
        if (!refused.has(key)) refused.set(key, new Set());
        refused.get(key)!.add(`${way.part.id}:${way.entry}`);
        open.push(back);
        continue;
      }
      toCap.push(at);
      continue;
    }
    if (placed[made].part.room) rooms++;
    openSocketsOf(made, false);
  }
  // The rolled count is what it grows toward; the size's least is what it must reach.
  if (rooms < style.sizes[size].rooms[0] && !minimal) return `grew only ${rooms} of ${targetRooms} rooms (${placed.length} parts${placed.length >= maxParts ? ", the most allowed" : ""})`;

  // 3. Loops: two open sockets meeting face to face, joined as they are.
  const loopsWanted = minimal ? 0 : roll(style.loops);
  let loops = 0;
  const ends = [...open, ...spare, ...toCap];
  for (let i = 0; i < ends.length && loops < loopsWanted; i++) {
    for (let j = i + 1; j < ends.length && loops < loopsWanted; j++) {
      const a = ends[i], b = ends[j];
      if (a.part === b.part || !socketsJoin(rules, a.def.type, b.def.type)) continue;
      if (Math.abs(normalDegrees(a.facing - b.facing) - 180) > 0.5) continue;
      if (Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y, a.at.z - b.at.z) > rules.loopReach) continue;
      joins.push({ a: a.part, socketA: a.socket, b: b.part, socketB: b.socket, loop: true });
      loops++;
      for (const s of [a, b]) {
        for (const list of [open, spare, toCap]) { const k = list.indexOf(s); if (k >= 0) list.splice(k, 1); }
      }
    }
  }

  // 4. The boss: on the room furthest from the entrance with only one way in, or at the furthest open end.
  const distance = graphDistances(placed.length, joins, 0);
  type Spot = { at: WorldSocket; replaces: number; d: number };
  const spots: Spot[] = [];
  for (let i = 1; i < placed.length; i++) {
    const links = joins.filter((j) => j.a === i || j.b === i);
    if (placed[i].role === "room" && links.length === 1 && placed[i].part.sockets.length === 1) {
      spots.push({ at: socketOf(placed, placed[i].parent, joins.find((j) => j.b === i)!.socketA), replaces: i, d: distance[i] });
    }
  }
  for (const s of [...open, ...spare, ...toCap]) spots.push({ at: s, replaces: -1, d: distance[s.part] + 1 });
  spots.sort((a, b) => b.d - a.d);
  /** The boss room at a spot - straight on, or past a way (a corridor, a stair) when it will not fit there. */
  const placeBoss = (spot: Spot): number | null => {
    const except = spot.replaces >= 0 ? [spot.replaces] : [];
    const direct = grow(spot.at, style.bosses, () => "boss", except);
    if (typeof direct !== "string") return direct;
    const ways = style.parts.filter((p) => !p.room);
    for (let t = 0; t < 4; t++) {
      const way = grow(spot.at, ways, () => "way", except);
      if (typeof way === "string") return null;
      const others = placed[way].part.sockets.map((_, i) => i).filter((i) => i !== placed[way].entry);
      for (const si of others) {
        const made = grow(socketOf(placed, way, si), style.bosses, () => "boss", except);
        if (typeof made === "string") continue;
        for (const o of others) if (o !== si) toCap.push(socketOf(placed, way, o));
        return made;
      }
      placed.pop();
      joins.pop();
    }
    return null;
  };
  let boss = -1;
  for (const spot of spots) {
    const made = placeBoss(spot);
    if (made === null) continue;
    boss = made;
    if (spot.replaces >= 0) {
      // The boss takes the leaf room's place: the room goes, its join with it.
      const old = spot.replaces;
      const k = joins.findIndex((j) => j.b === old);
      joins.splice(k, 1);
      placed.splice(old, 1);
      boss--;
      for (const j of joins) { if (j.a > old) j.a--; if (j.b > old) j.b--; }
      for (const p of placed) if (p.parent > old) p.parent--;
      for (const list of [open, spare, toCap]) for (const s of list) if (s.part > old) s.part--;
    } else {
      for (const list of [open, spare, toCap]) { const k = list.indexOf(spot.at); if (k >= 0) list.splice(k, 1); }
    }
    break;
  }
  if (boss < 0 && !minimal) return "no room for the boss";

  // 5. A lock on the way into the boss room, its key in the furthest other room.
  let lock = -1, key = -1;
  if (boss >= 0 && roll(style.locks) > 0) {
    lock = joins.findIndex((j) => j.b === boss || j.a === boss);
    const d = graphDistances(placed.length, joins.filter((_, i) => i !== lock), 0);
    let best = -1;
    placed.forEach((p, i) => { if (p.role === "room" && d[i] < Infinity && (best < 0 || d[i] > d[best])) best = i; });
    if (best < 0) return "no room for the key";
    key = best;
  }

  // 6. Close every open socket.
  for (const s of [...open, ...spare, ...toCap]) {
    const options = style.caps.flatMap((part) => part.sockets.map((c, entry) => ({ part, entry, c })).filter(({ c }) => socketsJoin(rules, c.type, s.def.type)));
    const option = pickWeighted(options, (o) => o.part.weight, random);
    if (!option) return `nothing caps a "${s.def.type}" socket`;
    placed.push({ ...placeAt(option.part, option.entry, s), parent: s.part, role: "cap" });
    joins.push({ a: s.part, socketA: s.socket, b: placed.length - 1, socketB: option.entry, loop: false });
  }

  // 7. Check: everything reachable, every part deep enough.
  const reach = graphDistances(placed.length, joins, 0);
  if (reach.some((d) => d === Infinity)) return "a part cannot be reached";
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].role !== "cap" && coverOver(placed[i].bounds) < style.cover - 1e-6) return `${placed[i].part.id} too near the surface`;
  }
  return { style: style.id, size, minimal, parts: placed, joins, boss, lock, key };
}

/** Steps from `from` to every part, over the joins. */
export function graphDistances(count: number, joins: readonly Join[], from: number): number[] {
  const d = new Array<number>(count).fill(Infinity);
  d[from] = 0;
  const queue = [from];
  while (queue.length > 0) {
    const i = queue.shift()!;
    for (const j of joins) {
      const other = j.a === i ? j.b : j.b === i ? j.a : -1;
      if (other >= 0 && d[other] === Infinity) { d[other] = d[i] + 1; queue.push(other); }
    }
  }
  return d;
}

function pickWeighted<T>(items: readonly T[], weight: (item: T) => number, random: () => number): T | undefined {
  let total = 0;
  for (const item of items) total += weight(item);
  if (total <= 0) return items[0];
  let r = random() * total;
  for (const item of items) {
    r -= weight(item);
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

/** A placed part's colliders, in the world. */
export function placedShapes(p: PlacedPart): ShapeDesc[] {
  const turn: Quat = quatFromEuler(p.yaw);
  return p.part.shapes.map((s): ShapeDesc => {
    if (s.kind === "box") return { ...s, center: toWorld(p, s.center), rotation: s.rotation ? quatMul(turn, s.rotation) : turn };
    if (s.kind === "convex") return { kind: "convex", points: s.points.map((q) => toWorld(p, q)), layers: s.layers };
    return s;
  });
}

/** A placed part's walk lines, in the world. */
export function placedPaths(p: PlacedPart): Polyline[] {
  return p.part.paths.map((line) => line.map((q) => toWorld(p, q)));
}

/** A placed part's sockets, in the world. */
export function placedSockets(layout: DungeonLayout, index: number): WorldSocket[] {
  return layout.parts[index].part.sockets.map((_, i) => socketOf(layout.parts, index, i));
}
