// The dungeon generator (DUNGEONS.md, *The generator*): pure and deterministic - a style, a size, a
// seed, where the entrance stands and the ground over it in; a layout of placed parts and the
// sockets joining them out. Every part but the entrance lies the style's cover under the ground.
import { deriveSeed, mulberry32 } from "../rng";
import { quatFromEuler, quatMul, vec3, type Aabb, type Quat, type ShapeDesc, type Vec3 } from "../collision/index";
import { shapesBounds, socketsJoin, type ConnectorDef, type CornerTurn, type DungeonContent, type DungeonPartDef, type DungeonStyleDef, type SocketDef } from "./dungeonDefs";
import { boxShape, doorwayGeometry, stairGeometry, type Polyline } from "./kitShapes";

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
  /** What it takes up, as a box in the world (round it, when it is turned) ... */
  bounds: Aabb;
  /** ... and as a box in the layout's own frame, where it is square to the axes: exact. Parts are
   *  kept apart, and the ground over them sampled, by this one. */
  box: Aabb;
  /** Which of its sockets it was joined by (-1: the entrance), and to which part. */
  entry: number;
  parent: number;
  role: "entrance" | "room" | "way" | "boss" | "cap" | "doorway";
}

export interface Join {
  a: number;
  socketA: number;
  b: number;
  socketB: number;
  /** Grown from a to b, or a loop closing two open ends. */
  loop: boolean;
  /** The doorway set across it (a part's index), or -1. */
  doorway: number;
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
  /** The layout's own frame: the entrance's site, turned to its door's facing - every part square to it. */
  frame: DungeonFrame;
}

/** A frame square to a layout's parts: (fx, fz) in it is world (x, z) + fx and fz turned by `yaw`. */
export interface DungeonFrame {
  x: number;
  z: number;
  yaw: number;
}

/** A frame point in the world. */
export function frameToWorld(f: DungeonFrame, fx: number, fz: number): { x: number; z: number } {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  return { x: f.x + fx * c + fz * s, z: f.z - fx * s + fz * c };
}

/** A world point in a frame. */
export function worldToFrame(f: DungeonFrame, x: number, z: number): { fx: number; fz: number } {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw), dx = x - f.x, dz = z - f.z;
  return { fx: dx * c - dz * s, fz: dx * s + dz * c };
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

/** A placed part's bounds in the world and in the layout's frame. */
function boundsOf(part: DungeonPartDef, x: number, y: number, z: number, yaw: number, frame: DungeonFrame): { bounds: Aabb; box: Aabb } {
  const probe = { part, x, y, z, yaw } as PlacedPart;
  const bounds = { min: vec3(Infinity, Infinity, Infinity), max: vec3(-Infinity, -Infinity, -Infinity) };
  const box = { min: vec3(Infinity, Infinity, Infinity), max: vec3(-Infinity, -Infinity, -Infinity) };
  const take = (b: Aabb, px: number, py: number, pz: number): void => {
    b.min.x = Math.min(b.min.x, px); b.min.y = Math.min(b.min.y, py); b.min.z = Math.min(b.min.z, pz);
    b.max.x = Math.max(b.max.x, px); b.max.y = Math.max(b.max.y, py); b.max.z = Math.max(b.max.z, pz);
  };
  const b = part.bounds;
  for (const lx of [b.min.x, b.max.x]) for (const ly of [b.min.y, b.max.y]) for (const lz of [b.min.z, b.max.z]) {
    const p = toWorld(probe, vec3(lx, ly, lz));
    take(bounds, p.x, p.y, p.z);
    const f = worldToFrame(frame, p.x, p.z);
    take(box, f.fx, p.y, f.fz);
  }
  return { bounds, box };
}

/** Puts `part` so its socket `entry` meets the open socket `to`, facing it. */
function placeAt(part: DungeonPartDef, entry: number, to: WorldSocket, frame: DungeonFrame): Omit<PlacedPart, "parent" | "role"> {
  const s = part.sockets[entry];
  const yaw = normalDegrees(to.facing + 180 - s.facing) * DEG;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const x = to.at.x - (s.at.x * c + s.at.z * sn);
  const y = to.at.y - s.at.y;
  const z = to.at.z - (-s.at.x * sn + s.at.z * c);
  return { part, x, y, z, yaw, ...boundsOf(part, x, y, z, yaw, frame), entry };
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
  // The first that passes and has the style's least loops; failing that, the first that passes.
  let fallback: DungeonLayout | null = null;
  for (let attempt = 0; attempt < content.rules.attempts; attempt++) {
    const result = attemptLayout(content, style, size, deriveSeed(root, attempt + 1), site, ground, heights, false);
    if (typeof result === "string") { failures.push(result); continue; }
    const layout = { ...result, seed, attempt, failures: [...failures] };
    if (result.joins.filter((j) => j.loop).length >= style.loops[0]) return layout;
    failures.push(`only ${result.joins.filter((j) => j.loop).length} loops of the ${style.loops[0]} wanted`);
    fallback ??= layout;
  }
  if (fallback) return fallback;
  const minimal = attemptLayout(content, style, size, deriveSeed(root, 0), site, ground, heights, true);
  if (typeof minimal === "string") throw new Error(`not even the minimal ${styleId} layout fits here: ${minimal}`);
  return { ...minimal, seed, attempt: content.rules.attempts, minimal: true, failures };
}

type Attempt = Omit<DungeonLayout, "seed" | "attempt" | "failures">;

function attemptLayout(content: DungeonContent, style: DungeonStyleDef, size: string, seed: number, site: DungeonSite, ground: DungeonGround, heights: Map<string, { h: number; built: boolean }>, minimal: boolean): Attempt | string {
  const rules = content.rules;
  const frame: DungeonFrame = { x: site.x, z: site.z, yaw: site.facing * DEG };
  const random = mulberry32(seed);
  const roll = ([lo, hi]: [number, number]): number => lo + Math.floor(random() * (hi - lo + 1));
  const targetRooms = minimal ? 1 : roll(style.sizes[size].rooms);
  const placed: PlacedPart[] = [];
  const joins: Join[] = [];

  /** The ground at a point of the fine grid (half the sampling's spacing), cached across attempts. */
  const fine = rules.sample / 2;
  const groundAt = (fx: number, fz: number): { h: number; built: boolean } => {
    const key = `${fx},${fz}`;
    let g = heights.get(key);
    if (!g) {
      const x = fx * fine, z = fz * fine;
      g = { h: ground.heightAt(x, z), built: ground.builtAt(x, z) };
      heights.set(key, g);
    }
    return g;
  };
  /**
   * The least rock over a box (negative: it shows), under buildings counting half: sampled at the
   * rules' spacing while choosing parts, and twice as finely over a finished layout, so a dip
   * narrower than the spacing (a stream's bed) is never missed.
   */
  const coverOver = (box: Aabb, finely = false): number => {
    let least = Infinity;
    // Over the part's box in the layout's frame (exact, however the layout is turned), each point
    // read from the nearest point of the world's fine grid.
    const step = finely ? fine : rules.sample;
    const x0 = box.min.x - rules.around, x1 = box.max.x + rules.around, z0 = box.min.z - rules.around, z1 = box.max.z + rules.around;
    const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step);
    for (let i = 0; i <= nx; i++) {
      for (let k = 0; k <= nz; k++) {
        const w = frameToWorld(frame, Math.min(x1, x0 + i * step), Math.min(z1, z0 + k * step));
        const g = groundAt(Math.round(w.x / fine), Math.round(w.z / fine));
        const b = box;
        const rock = g.h - b.max.y;
        least = Math.min(least, g.built ? rock / 2 : rock);
      }
    }
    return least;
  };
  const coverAt = (x: number, z: number): number => groundAt(Math.round(x / fine) & ~1, Math.round(z / fine) & ~1).h;

  /** Whether a part may stand where it was put: clear of every other part, deep enough. */
  const fits = (b: Aabb, except: readonly number[]): string | null => {
    for (let i = 0; i < placed.length; i++) if (!except.includes(i) && overlaps(b, placed[i].box)) return "overlap";
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
  placed.push({ ...placeAt(entrancePart, mouth, surface, frame), entry: mouth, parent: -1, role: "entrance" });

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
  /**
   * Which way the way an open end is on has been going (DUNGEONS.md, *The generator*): back through
   * the parts with one way in and one out (corridors, stairs, corners, the entrance's stair), the
   * first that changes height - 1 up, -1 down - or 0 from a room, or a part where ways branch.
   * Along one way, a stair never turns back on the last: up, down, up again makes no sense.
   */
  const trendAt = (at: WorldSocket): number => {
    let index = at.part, exit = at.socket;
    while (index >= 0) {
      const p = placed[index];
      if (p.role === "room" || p.role === "boss" || p.part.sockets.length > 2) return 0;
      const dy = p.part.sockets[exit].at.y - p.part.sockets[p.entry].at.y;
      if (Math.abs(dy) > 0.1) return Math.sign(dy);
      const from = joins.find((j) => j.b === index && !j.loop);
      if (!from) return 0;
      index = from.a;
      exit = from.socketA;
    }
    return 0;
  };
  /** Picks and places a part at an open socket, or returns why none fit. */
  const grow = (at: WorldSocket, pool: readonly DungeonPartDef[], role: (p: DungeonPartDef) => PlacedPart["role"], except: number[]): number | string => {
    const headroom = coverAt(at.at.x, at.at.z) - (at.at.y + at.def.size[1]);
    const diving = headroom < style.cover + rules.thinCover;
    const stage = rooms / Math.max(1, targetRooms);
    const trend = trendAt(at);
    const options: { part: DungeonPartDef; entry: number; weight: number }[] = [];
    for (const part of pool) {
      if (stage < part.stage[0] - 1e-9 || stage > part.stage[1] + 1e-9) continue;
      part.sockets.forEach((s, entry) => {
        if (s.type === "surface" || !socketsJoin(rules, s.type, at.def.type)) return;
        const rise = Math.max(0, ...part.sockets.filter((_, i) => i !== entry).map((o) => o.at.y - s.at.y));
        const drop = Math.min(0, ...part.sockets.filter((_, i) => i !== entry).map((o) => o.at.y - s.at.y));
        let weight = part.weight / part.sockets.length;
        if (refused.get(`${at.part}:${at.socket}`)?.has(`${part.id}:${entry}`)) return;
        // A way on keeps going the way the way before it went.
        if (!part.room && part.sockets.length === 2 && ((trend > 0 && drop < -0.1) || (trend < 0 && rise > 0.1))) return;
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
      const put = placeAt(option.part, option.entry, at, frame);
      const problem = fits(put.box, [at.part, ...except]);
      if (problem) { why = problem; continue; }
      placed.push({ ...put, parent: at.part, role: role(option.part) });
      const index = placed.length - 1;
      joins.push({ a: at.part, socketA: at.socket, b: index, socketB: option.entry, loop: false, doorway: -1 });
      return index;
    }
    return why;
  };

  /** Joins two open ends with a routed way of connector pieces, trying the shortest routes in turn. */
  const bridge = (c: ConnectorDef, a: WorldSocket, b: WorldSocket): boolean => {
    // Out of a's way and into b's the way each was going (b's walked backwards).
    // Walked from a to b, b's way is walked backwards: it goes -trendAt(b).
    const dy = b.at.y - a.at.y, ta = trendAt(a), tb = -trendAt(b);
    if (ta !== 0 && tb !== 0 && ta !== tb) return false;
    if (Math.abs(dy) > 0.1 && (Math.sign(dy) === -ta || Math.sign(dy) === -tb)) return false;
    for (const plan of routesBetween(c, a, b, random)) if (lay(c, plan, a, b)) return true;
    return false;
  };
  /** Lays a route's pieces from `a`; takes them all back if any will not fit. */
  const lay = (c: ConnectorDef, plan: RouteStep[], a: WorldSocket, b: WorldSocket): boolean => {
    const placedBefore = placed.length, joinsBefore = joins.length;
    const undo = (): false => { placed.length = placedBefore; joins.length = joinsBefore; return false; };
    let at = a;
    const pieces = plan.filter((step) => step.kind === "corner" || step.length > 1e-3 || step.dy !== 0);
    for (let k = 0; k < pieces.length; k++) {
      const step = pieces[k];
      const part = step.kind === "corner" ? step.corner.part : connectorPart(c, step.length, step.dy);
      const entry = step.kind === "corner" ? step.corner.entry : 0;
      const exit = step.kind === "corner" ? step.corner.exit : 1;
      const put = placeAt(part, entry, at, frame);
      if (fits(put.box, k === pieces.length - 1 ? [at.part, b.part] : [at.part])) return undo();
      placed.push({ ...put, parent: at.part, role: "way" });
      const index = placed.length - 1;
      joins.push({ a: at.part, socketA: at.socket, b: index, socketB: entry, loop: false, doorway: -1 });
      at = socketOf(placed, index, exit);
    }
    // Where it came out: at the other end, face to face.
    const gap = Math.hypot(at.at.x - b.at.x, at.at.y - b.at.y, at.at.z - b.at.z);
    if (gap > 0.01 || Math.abs(normalDegrees(at.facing - b.facing) - 180) > 0.01) return undo();
    joins.push({ a: at.part, socketA: at.socket, b: b.part, socketB: b.socket, loop: true, doorway: -1 });
    return true;
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

  // 3. Loops, made on purpose: two open ends far apart along the layout but near in the ground,
  // joined by a route of corridors, corners and a flight sized to fit - so a way circles back, and
  // the dungeon is easy to get lost in.
  const connector = style.connector;
  const loopsWanted = minimal || !connector ? 0 : roll(style.loops);
  let loops = 0;
  if (connector && loopsWanted > 0) {
    const ends = [...open, ...spare, ...toCap].filter((s) => socketsJoin(rules, s.def.type, connector.socket));
    const spans = new Map<number, number[]>();
    const spanOf = (a: number, b: number): number => {
      if (!spans.has(a)) spans.set(a, graphDistances(placed.length, joins, a));
      return spans.get(a)![b];
    };
    const pairs: { a: WorldSocket; b: WorldSocket; span: number; apart: number }[] = [];
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i], b = ends[j];
        if (a.part === b.part) continue;
        const apart = Math.hypot(a.at.x - b.at.x, a.at.z - b.at.z);
        const span = spanOf(a.part, b.part);
        if (apart <= rules.loopReach && span >= rules.loopSpan) pairs.push({ a, b, span, apart });
      }
    }
    // The longest way round first; of those, the nearest.
    pairs.sort((x, y) => y.span - x.span || x.apart - y.apart);
    const used = new Set<WorldSocket>();
    for (const { a, b } of pairs) {
      if (loops >= loopsWanted) break;
      if (used.has(a) || used.has(b)) continue;
      if (!bridge(connector, a, b)) continue;
      loops++;
      for (const s of [a, b]) {
        used.add(s);
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
    placed.push({ ...placeAt(option.part, option.entry, s, frame), parent: s.part, role: "cap" });
    joins.push({ a: s.part, socketA: s.socket, b: placed.length - 1, socketB: option.entry, loop: false, doorway: -1 });
  }

  // 7. Check: everything reachable, every part deep enough.
  const reach = graphDistances(placed.length, joins, 0);
  if (reach.some((d) => d === Infinity)) return "a part cannot be reached";
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].role !== "cap" && coverOver(placed[i].box, true) < style.cover - 1e-6) return `${placed[i].part.id} too near the surface, between the samples`;
  }
  // 8. A doorway across every join, and at the mouth (DUNGEONS.md, *Doorways*) - rolled on their
  // own, so a style's doorways never change the layout itself.
  const doorRandom = mulberry32(deriveSeed(seed, 0xd00a));
  /** A doorway across socket `s`, reaching its `reach` into its part and `front` into the one beyond. */
  const setDoorway = (s: WorldSocket, front: SocketDef | null): number => {
    const options = style.doorways.filter((d) => socketsJoin(rules, d.sockets[0].type, s.def.type));
    const option = pickWeighted(options, (d) => d.weight, doorRandom);
    if (!option) return -1;
    placed.push({ ...placeAt(doorwayPart(option, s.def, front ?? { reach: 1, reachOver: 1 }), 0, s, frame), parent: s.part, role: "doorway" });
    return placed.length - 1;
  };
  // (Not at a cap: the wall closes the way, and a frame round it could reach into a neighbour's.)
  for (const j of joins) if (placed[j.b].role !== "cap") j.doorway = setDoorway(socketOf(placed, j.a, j.socketA), placed[j.b].part.sockets[j.socketB]);
  placed[0].part.sockets.forEach((socket, i) => {
    if (socket.type === "surface") setDoorway(socketOf(placed, 0, i), null);
  });
  return { style: style.id, size, minimal, parts: placed, joins, boss, lock, key, frame };
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

// --- Loops: routes between two open ends, and the pieces sized to fit them -------------------

type RouteStep = { kind: "way"; length: number; dy: number } | { kind: "corner"; corner: CornerTurn };
type Dir = [number, number];

/** How long a straight run out of an end may be before it turns, to find a way round. */
const STUBS = [0, 12, 24];
/** Routes tried between two ends, shortest first, before giving them up. */
const ROUTES_TRIED = 16;

/**
 * The ways from open end `a` to open end `b` in straights and quarter turns, on the layout's own
 * square grid, shortest first. At the heart of each, one of: straight on (facing each other in
 * line), one turn (facing across), a dog-leg (facing each other off line) or a U (facing the same
 * way); before it, a run out of `a` and a turn, and after it a turn and a run into `b`, either or
 * both - so ends facing away from each other still meet. Any change of height becomes flights of
 * stairs in the straights.
 */
export function routesBetween(c: ConnectorDef, a: WorldSocket, b: WorldSocket, random: () => number): RouteStep[][] {
  const dir = (facing: number): Dir => [Math.sin(facing * DEG), Math.cos(facing * DEG)];
  const right = (h: Dir): Dir => [h[1], -h[0]];
  const turned = (h: Dir, turn: 1 | -1): Dir => (turn === 1 ? right(h) : [-h[1], h[0]]);
  const pick = (turn: 1 | -1): CornerTurn | null => {
    const options = c.corners.filter((k) => k.turn === turn);
    return options.length ? options[Math.floor(random() * options.length)] : null;
  };
  type End = { x: number; z: number; out: Dir; steps: RouteStep[] };
  // a's ends: as it is, or run out and turned. Travel leaves along `out`.
  const fromA: End[] = [{ x: a.at.x, z: a.at.z, out: dir(a.facing), steps: [] }];
  // b's ends: as it is, or reached by a turn and a run in. Travel arrives along -`out`.
  const intoB: End[] = [{ x: b.at.x, z: b.at.z, out: dir(b.facing), steps: [] }];
  for (const stub of STUBS) {
    for (const turn of [1, -1] as const) {
      const ca = pick(turn);
      if (ca) {
        const u = dir(a.facing), u1 = turned(u, turn), along = stub + ca.reachIn;
        fromA.push({ x: a.at.x + u[0] * along + u1[0] * ca.reachOut, z: a.at.z + u[1] * along + u1[1] * ca.reachOut, out: u1, steps: [{ kind: "way", length: stub, dy: 0 }, { kind: "corner", corner: ca }] });
      }
      const cb = pick(turn);
      if (cb) {
        // Arriving at b along h2 = -v, after turning `turn` from h1.
        const v = dir(b.facing), h2: Dir = [-v[0], -v[1]], h1 = turned(h2, (-turn) as 1 | -1);
        const back = stub + cb.reachOut;
        intoB.push({ x: b.at.x - h2[0] * back - h1[0] * cb.reachIn, z: b.at.z - h2[1] * back - h1[1] * cb.reachIn, out: [-h1[0], -h1[1]], steps: [{ kind: "corner", corner: cb }, { kind: "way", length: stub, dy: 0 }] });
      }
    }
  }
  const routes: { steps: RouteStep[]; length: number }[] = [];
  for (const s of fromA) {
    for (const e of intoB) {
      for (const core of coreRoutes(s, e, pick)) {
        // Fresh copies: the ends' steps are shared between routes, and heights are set per route.
        const steps = [...s.steps, ...core, ...e.steps].map((step) => ({ ...step }));
        if (!placeHeight(c, steps, b.at.y - a.at.y)) continue;
        const length = steps.reduce((sum, step) => sum + (step.kind === "way" ? step.length : step.corner.reachIn + step.corner.reachOut), 0);
        routes.push({ steps, length });
      }
    }
  }
  return routes.sort((x, y) => x.length - y.length).slice(0, ROUTES_TRIED).map((r) => r.steps);
}

/** A U's legs may run this much further than they must, to hold flights of stairs. */
const U_LONGER = [0, 12, 24, 40];

/** Zero, one or two turns between two ends - a U in a few lengths; none if there is no room. */
function coreRoutes(a: { x: number; z: number; out: Dir }, b: { x: number; z: number; out: Dir }, pick: (turn: 1 | -1) => CornerTurn | null): RouteStep[][] {
  const u = a.out, v = b.out;
  const rel: Dir = [b.x - a.x, b.z - a.z];
  const dot = u[0] * v[0] + u[1] * v[1];
  const f = rel[0] * u[0] + rel[1] * u[1];
  const o: Dir = [rel[0] - u[0] * f, rel[1] - u[1] * f];
  const ol = Math.hypot(o[0], o[1]);
  const l: Dir = ol > 1e-6 ? [o[0] / ol, o[1] / ol] : [0, 0];
  const turnOf = (h: Dir, h2: Dir): 1 | -1 => (Math.abs(h2[0] - h[1]) < 1e-6 && Math.abs(h2[1] + h[0]) < 1e-6 ? 1 : -1);
  const way = (length: number): RouteStep => ({ kind: "way", length, dy: 0 });
  let options: RouteStep[][];
  if (dot < -0.999) {
    if (ol < 0.01) {
      options = [[way(f)]];
    } else {
      const c1 = pick(turnOf(u, l)), c2 = pick(turnOf(l, u));
      if (!c1 || !c2) return [];
      const t = (f + c1.reachIn - c2.reachOut) / 2;
      options = [[way(t - c1.reachIn), { kind: "corner", corner: c1 }, way(ol - c1.reachOut - c2.reachIn), { kind: "corner", corner: c2 }, way(f - t - c2.reachOut)]];
    }
  } else if (Math.abs(dot) < 0.001) {
    const c1 = pick(turnOf(u, [-v[0], -v[1]]));
    if (!c1) return [];
    options = [[way(f - c1.reachIn), { kind: "corner", corner: c1 }, way(-(o[0] * v[0] + o[1] * v[1]) - c1.reachOut)]];
  } else if (dot > 0.999) {
    if (ol < 0.01) return [];
    const c1 = pick(turnOf(u, l)), c2 = pick(turnOf(l, [-u[0], -u[1]]));
    if (!c1 || !c2) return [];
    options = U_LONGER.map((longer) => {
      const t = Math.max(c1.reachIn, f + c2.reachOut) + 2 + longer;
      return [way(t - c1.reachIn), { kind: "corner", corner: c1 }, way(ol - c1.reachOut - c2.reachIn), { kind: "corner", corner: c2 }, way(t - f - c2.reachOut)];
    });
  } else {
    return [];
  }
  return options.filter((steps) => steps.every((s) => s.kind !== "way" || s.length >= -1e-6)).map((steps) => steps.map((s) => (s.kind === "way" ? { ...s, length: Math.max(0, s.length) } : s)));
}

/**
 * Spreads a change of height over a route's straights as flights (a 3 m landing either end of
 * each), the longest taking most. False if they cannot hold it.
 */
function placeHeight(c: ConnectorDef, steps: RouteStep[], dy: number): boolean {
  if (Math.abs(dy) < 1e-6) return true;
  const total = Math.round(Math.abs(dy) / c.rise);
  if (Math.abs(total * c.rise - Math.abs(dy)) > 1e-6) return false;
  const ways = steps.filter((s): s is Extract<RouteStep, { kind: "way" }> => s.kind === "way");
  const holds = (length: number): number => (length >= 6 + c.tread ? Math.floor((length - 6) / c.tread + 1e-9) : 0);
  if (ways.reduce((sum, s) => sum + holds(s.length), 0) < total) return false;
  let left = total;
  for (const s of [...ways].sort((x, y) => y.length - x.length)) {
    const k = Math.min(holds(s.length), left);
    s.dy = Math.sign(dy) * k * c.rise;
    left -= k;
  }
  return true;
}

const doorwayParts = new WeakMap<DungeonPartDef, Map<string, DungeonPartDef>>();

/**
 * A doorway built for where it stands: reaching into the part behind its socket and the one beyond
 * as far as each socket says (`reach`, its lintel `reachOver`), so its frame is as thick as both
 * walls - and stands proud of a hall's, and covers a spiral's round wall where it curves away.
 */
export function doorwayPart(def: DungeonPartDef, behind: Pick<SocketDef, "reach" | "reachOver">, beyond: Pick<SocketDef, "reach" | "reachOver">): DungeonPartDef {
  if (!def.doorway) return def;
  let cache = doorwayParts.get(def);
  if (!cache) doorwayParts.set(def, (cache = new Map()));
  const key = [behind.reach, behind.reachOver, beyond.reach, beyond.reachOver].map((v) => v.toFixed(3)).join(":");
  const known = cache.get(key);
  if (known) return known;
  const doorway = { ...def.doorway, back: behind.reach, front: beyond.reach, backOver: behind.reachOver, frontOver: beyond.reachOver };
  const geometry = doorwayGeometry(doorway);
  const part: DungeonPartDef = { ...def, doorway, shapes: geometry.shapes, visuals: geometry.visuals, paths: geometry.paths, voussoirs: geometry.voussoirs, bounds: shapesBounds(geometry.shapes) };
  cache.set(key, part);
  return part;
}

const connectorParts = new WeakMap<ConnectorDef, Map<string, DungeonPartDef>>();

/**
 * A straight piece of way `length` long, going `dy` up (or down) - a corridor, or a flight between
 * two 3 m landings - built as the kit's corridors and stairs are: floor, walls, vault, 6 m clear.
 */
export function connectorPart(c: ConnectorDef, length: number, dy: number): DungeonPartDef {
  let cache = connectorParts.get(c);
  if (!cache) connectorParts.set(c, (cache = new Map()));
  const key = `${length.toFixed(3)}:${dy.toFixed(3)}`;
  const known = cache.get(key);
  if (known) return known;
  const w = c.width / 2, o = w + c.wall, h = c.height;
  const shapes: ShapeDesc[] = [];
  const paths: Polyline[] = [];
  if (dy === 0) {
    shapes.push(boxShape(-o, -1, 0, o, 0, length), boxShape(-o, -1, 0, -w, h + 1, length), boxShape(w, -1, 0, o, h + 1, length), boxShape(-o, h, 0, o, h + 1, length));
    paths.push([vec3(0, 0, 0), vec3(0, 0, length)]);
  } else {
    const low = Math.min(0, dy), high = Math.max(0, dy);
    const flight = stairGeometry({ from: vec3(0, 0, 3), to: vec3(0, dy, length - 3), width: c.width, rise: c.rise, ceiling: h, walls: false });
    shapes.push(boxShape(-w, -1, 0, w, 0, 3), boxShape(-w, dy - 1, length - 3, w, dy, length), ...flight.shapes);
    shapes.push(boxShape(-o, h, 0, o, h + 1, 3), boxShape(-o, dy + h, length - 3, o, dy + h + 1, length));
    shapes.push(boxShape(-o, low - 2, 0, -w, high + h + c.rise + 1, length), boxShape(w, low - 2, 0, o, high + h + c.rise + 1, length));
    paths.push([vec3(0, 0, 0), vec3(0, 0, 3)], ...flight.paths, [vec3(0, dy, length - 3), vec3(0, dy, length)]);
  }
  // Torches along it, a wall at a time, about every 14 m (none in a short piece).
  const light: Vec3[] = [];
  const torches = Math.floor(length / 14);
  for (let i = 0; i < torches; i++) {
    const t = (i + 0.5) / torches;
    const along = length * t;
    const floor = dy === 0 || along <= 3 ? 0 : along >= length - 3 ? dy : (dy * (along - 3)) / (length - 6);
    light.push(vec3(i % 2 ? w - 0.4 : 0.4 - w, floor + 4, along));
  }
  const socket = (at: Vec3, facing: number): SocketDef => ({ at, facing, type: c.socket, size: [c.width, c.height], reach: c.wall, reachOver: c.wall });
  const part: DungeonPartDef = {
    id: `connector:${key}`,
    tags: ["connector"],
    weight: 0,
    stage: [0, 1],
    bounds: shapesBounds(shapes),
    sockets: [socket(vec3(0, 0, 0), 180), socket(vec3(0, dy, length), 0)],
    shapes,
    paths,
    spots: light.length ? { light } : {},
    room: false,
    rounds: [],
    doorway: null,
    visuals: [],
    whole: [],
    plain: [],
    voussoirs: [],
  };
  cache.set(key, part);
  return part;
}
