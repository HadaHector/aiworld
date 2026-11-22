// A cave's fixtures (DUNGEONS.md, *Light*): at its parts' `light` spots, the style's share of them
// lit, each one of the style's fixtures by weight - crystals grown at the foot of a wall, a campfire
// on the floor, a torch on the wall - set against the cave's own rock (its field). Pure: their
// model, their lights and their flames, in the world.
import type { BuildingModel, ModelEffect, ModelLight } from "../buildings/buildingTypes";
import { ModelBuilder } from "../buildings/buildingGeometry";
import { generateLine, generateProp } from "../props/propGenerator";
import type { PropDef } from "../props/propTypes";
import { deriveSeed, mulberry32 } from "../rng";
import type { DungeonStyleDef } from "./dungeonDefs";
import { placedSpots, toWorld, type DungeonLayout } from "./layout";
import type { CaveField } from "./caveField";

export interface CaveFixtures {
  model: BuildingModel | null;
  lights: ModelLight[];
  effects: ModelEffect[];
}

/** How far a fixture looks for a wall round its spot. */
const WALL_REACH = 24;
/** A torch's flame over the floor. */
const TORCH_HEIGHT = 3.2;

/** The open space's floor under a point: down from it to the rock (null: none within 12 m). */
function floorUnder(field: CaveField, x: number, y: number, z: number): number | null {
  if (field.rock(x, y, z) > 0) return null;
  for (let d = 0; d < 12; d += 0.25) {
    if (field.rock(x, y - d, z) > 0) {
      // Halve the last step for where it crosses.
      let lo = y - d, hi = y - d + 0.25;
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) / 2;
        if (field.rock(x, mid, z) > 0) lo = mid;
        else hi = mid;
      }
      return hi;
    }
  }
  return null;
}

/** The nearest rock round a point, level with it, looked for in 16 ways: where, and which way out of it. */
function nearestWall(field: CaveField, x: number, y: number, z: number, start: number): { x: number; z: number; out: [number, number]; distance: number } | null {
  let best: { x: number; z: number; out: [number, number]; distance: number } | null = null;
  for (let k = 0; k < 16; k++) {
    const a = start + (k * Math.PI) / 8;
    const dx = Math.sin(a), dz = Math.cos(a);
    for (let t = 0.5; t < WALL_REACH; t += 0.25) {
      if (field.rock(x + dx * t, y, z + dz * t) <= 0) continue;
      if (!best || t < best.distance) best = { x: x + dx * t, z: z + dz * t, out: [-dx, -dz], distance: t };
      break;
    }
  }
  if (!best) return null;
  // Out of the rock along its gradient, level.
  const e = 0.3;
  const gx = field.rock(best.x + e, y, best.z) - field.rock(best.x - e, y, best.z);
  const gz = field.rock(best.x, y, best.z + e) - field.rock(best.x, y, best.z - e);
  const l = Math.hypot(gx, gz);
  if (l > 1e-6) best.out = [-gx / l, -gz / l];
  return best;
}

// --- A mine's dressing (DUNGEONS.md, *The mine*) ------------------------------------------------

interface Pt {
  x: number;
  y: number;
  z: number;
}

/** How far a way's wall or roof is looked for. */
const SPAN_REACH = 12;
/** A timber set's posts' thickness, and the rest of its height over them: its cap, and the boards on that. */
const SET_T = 0.5;
const SET_OVER = SET_T * 1.1 + 0.14;
/** A tunnel's sets start this far in from its ends. */
const SET_IN = 1.2;
/** A track's free end stops this far short of its work face; a cart parked this much further out. */
const TRACK_SHORT = 4.2;
const CART_OUT = 1.9;
/** A track is laid along its way at points this far apart; it is broken where the floor is steeper than this. */
const TRACK_STEP = 1.5;
const TRACK_STEEP = 0.45;

/** How far along (dx, dz) from a point, level, the rock starts (null: not within `max`). */
function reachTo(field: CaveField, x: number, y: number, z: number, dx: number, dz: number, max = SPAN_REACH): number | null {
  for (let t = 0.25; t < max; t += 0.25) {
    if (field.rock(x + dx * t, y, z + dz * t) <= 0) continue;
    let lo = t - 0.25, hi = t;
    for (let k = 0; k < 5; k++) {
      const mid = (lo + hi) / 2;
      if (field.rock(x + dx * mid, y, z + dz * mid) > 0) hi = mid;
      else lo = mid;
    }
    return lo;
  }
  return null;
}

/** The roof over a point: up from `from` to the rock (null: none within 24 m). */
function roofOver(field: CaveField, x: number, from: number, z: number): number | null {
  for (let y = from; y < from + 24; y += 0.25) {
    if (field.rock(x, y, z) <= 0) continue;
    let lo = y - 0.25, hi = y;
    for (let k = 0; k < 5; k++) {
      const mid = (lo + hi) / 2;
      if (field.rock(x, mid, z) > 0) hi = mid;
      else lo = mid;
    }
    return lo;
  }
  return null;
}

/** Points along a line every `step` (and its last), each with the way's direction there. */
function stepsAlong(line: readonly Pt[], step: number, from = 0, to = Infinity): (Pt & { ux: number; uz: number; s: number })[] {
  const out: (Pt & { ux: number; uz: number; s: number })[] = [];
  let s0 = 0;
  const total = line.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - line[i].x, q.z - line[i].z), 0);
  const end = Math.min(to, total);
  let next = from;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    if (l < 1e-6) continue;
    while (next <= s0 + l + 1e-6 && next <= end + 1e-6) {
      const t = (next - s0) / l;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, ux: (b.x - a.x) / l, uz: (b.z - a.z) / l, s: next });
      next += step;
    }
    s0 += l;
  }
  return out;
}

const lineLength = (line: readonly Pt[]): number => line.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - line[i].x, q.z - line[i].z), 0);

/** A timber set fitted where it stands: across the way (ax, az) its posts against the walls either
 *  side, its cap under the roof - or null, where the way is too open (a chamber) or too low. */
interface Fitted {
  x: number;
  z: number;
  foot: number;
  half: number;
  roof: number;
  ax: number;
  az: number;
}

function fitSet(field: CaveField, x: number, y: number, z: number, ux: number, uz: number): Fitted | null {
  const f = floorUnder(field, x, y + 2.5, z);
  if (f === null) return null;
  const ax = uz, az = -ux;
  // The walls at its knees and its head: the nearer of each side.
  const side = (s: number): number | null => {
    const a = reachTo(field, x, f + 1, z, s * ax, s * az), b = reachTo(field, x, f + 4, z, s * ax, s * az);
    return a === null || b === null ? null : Math.min(a, b);
  };
  const left = side(1), right = side(-1);
  if (left === null || right === null || left + right > 14 || left + right < 3) return null;
  const half = (left + right) / 2, shift = (left - right) / 2;
  const cx = x + ax * shift, cz = z + az * shift;
  // The roof: its lowest over the middle and over the cap's two thirds.
  let roof = Infinity;
  for (const k of [0, -0.7, 0.7]) {
    const r = roofOver(field, cx + ax * half * k, f + 1.5, cz + az * half * k);
    if (r === null) return null;
    roof = Math.min(roof, r);
  }
  if (roof - f < 4) return null;
  // Its feet on the lower of the floor under either post.
  let foot = f;
  for (const s of [-1, 1]) {
    const g = floorUnder(field, cx + s * ax * (half - 0.3), f + 2, cz + s * az * (half - 0.3));
    if (g !== null) foot = Math.min(foot, g);
  }
  return { x: cx, z: cz, foot, half, roof, ax, az };
}

/** A prop with some of its settings fixed (each a range of one value). */
function fixed(def: PropDef, values: Record<string, number>): PropDef {
  const settings = { ...def.settings };
  for (const [k, v] of Object.entries(values)) settings[k] = [v, v];
  return { ...def, settings };
}

/** Whether a prop's footprint (a square of `r` half-side) round (x, z) stands in open air at the floor. */
function clearOf(field: CaveField, x: number, floor: number, z: number, r: number): boolean {
  for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
    if (field.rock(x + ox, floor + 0.7, z + oz) > 0 || field.rock(x + ox, floor + 1.8, z + oz) > 0) return false;
  }
  return true;
}

/**
 * A mine's dressing (`light.dressing`, MineDressing), laid by its ways rather than at its light spots:
 * along every tunnel a timber set every so far, cut to its width and roof, lagging behind their posts
 * between them; a track along every tunnel, on through each chamber to its middle - a turnplate there
 * - and on to its work face; at every dead end and one wall of each chamber that face, its vein, its
 * tools and ore, a cart at the end of its track; shoring against a chamber's walls, and its extras
 * free on its floor. Their models appended to `b`; they light nothing.
 */
function dress(b: ModelBuilder, layout: DungeonLayout, style: DungeonStyleDef, field: CaveField, props: (id: string) => PropDef | undefined): number {
  const d = style.light.dressing;
  if (!d) return 0;
  const get = (id: string | undefined): PropDef | undefined => {
    if (!id) return undefined;
    const def = props(id);
    if (!def) console.warn(`The dungeon style "${style.id}" dresses with a prop "${id}" that no pack has.`);
    return def;
  };
  const setDef = get(d.sets?.prop), laggingDef = get(d.lagging?.prop), shoringDef = get(d.shoring?.prop);
  const trackDef = get(d.track?.prop), plateDef = get(d.track?.turnplate);
  const carts = (d.track?.carts ?? []).map(get).filter((c): c is PropDef => !!c);
  const face = d.face.map((f) => ({ ...f, def: get(f.prop) })).filter((f): f is typeof f & { def: PropDef } => !!f.def);
  const extras = d.extras.map((f) => ({ ...f, def: get(f.prop) })).filter((f): f is typeof f & { def: PropDef } => !!f.def);
  const models = new Map<string, BuildingModel>();
  /** A model, made once for each of its keys. */
  const model = (key: string, make: () => BuildingModel): BuildingModel => {
    let m = models.get(key);
    if (!m) models.set(key, (m = make()));
    return m;
  };
  let placed = 0;
  const put = (m: BuildingModel, x: number, y: number, z: number, fx: number, fz: number): void => {
    b.appendFurniture(m, x, y, z, fx, fz);
    placed++;
  };
  /** Where track lies (kept clear of what stands free). */
  const railed: Pt[] = [];
  const nearRail = (x: number, z: number, r: number): boolean => railed.some((q) => Math.hypot(q.x - x, q.z - z) < r);

  /** Track along a line on the floor, its ends free (a buffer stop) or running on. */
  const lay = (line: Pt[], ends: ["free" | "join", "free" | "join"], seed: number): void => {
    if (!trackDef || lineLength(line) < 1) return;
    const steps: Pt[] = stepsAlong(line, TRACK_STEP);
    const tail = line[line.length - 1];
    const lastStep = steps[steps.length - 1];
    if (lastStep && Math.hypot(lastStep.x - tail.x, lastStep.z - tail.z) > 0.2) steps.push(tail);
    // On the floor at each point; broken in two where it is too steep (or the floor is lost).
    const pieces: Pt[][] = [[]];
    for (const q of steps) {
      const f = floorUnder(field, q.x, q.y + 2.5, q.z);
      const piece = pieces[pieces.length - 1];
      const prev = piece[piece.length - 1];
      if (f === null) {
        if (piece.length) pieces.push([]);
        continue;
      }
      const here = { x: q.x, y: f - 0.02, z: q.z };
      if (prev && Math.abs(here.y - prev.y) > TRACK_STEEP * Math.max(0.5, Math.hypot(here.x - prev.x, here.z - prev.z))) pieces.push([here]);
      else piece.push(here);
    }
    pieces.forEach((pts, i) => {
      if (pts.length < 2) return;
      const o = pts[0];
      const run = {
        points: pts.map((q): [number, number, number] => [q.x - o.x, q.y - o.y, q.z - o.z]),
        ends: [i === 0 ? ends[0] : "join", i === pieces.length - 1 ? ends[1] : "join"] as ["free" | "join", "free" | "join"],
        breach: false,
      };
      put(generateLine(trackDef, seed, 0, run), o.x, o.y, o.z, 0, 1);
      railed.push(...pts);
    });
  };

  /** A cart parked on a track, at (x, z) along (ux, uz). */
  const park = (x: number, y: number, z: number, ux: number, uz: number, random: () => number, seed: number): void => {
    if (carts.length === 0 || random() >= (d.track?.cart ?? 0)) return;
    const def = carts[Math.floor(random() * carts.length)];
    const f = floorUnder(field, x, y + 2.5, z);
    if (f === null) return;
    const v = Math.floor(random() * 4);
    put(model(`cart:${def.id}:${v}`, () => generateProp(fixed(def, { track: 0 }), seed, v)), x, f - 0.02, z, ux, uz);
    railed.push({ x, y: f, z });
  };

  /** A work face on the wall reached going (dx, dz) from a point: its vein, tools and ore round it. */
  const workFace = (x: number, y: number, z: number, dx: number, dz: number, random: () => number, seed: number): { x: number; z: number; distance: number } | null => {
    const f0 = floorUnder(field, x, y + 2.5, z);
    if (f0 === null) return null;
    const r = reachTo(field, x, f0 + 2, z, dx, dz, 40);
    if (r === null || r < TRACK_SHORT + 3) return null;
    const wx = x + dx * r, wz = z + dz * r;
    const nx = -dx, nz = -dz;
    const tx = dz, tz = -dx;
    const side = random() < 0.5 ? 1 : -1;
    const floorAt = (px: number, pz: number): number | null => floorUnder(field, px, f0 + 2.5, pz);
    const taken: [number, number][] = [];
    face.forEach((e, k) => {
      if (random() >= e.chance) return;
      const v = Math.floor(random() * 6);
      const m = generateProp(e.def, deriveSeed(seed, k), v);
      if (e.at === "face" || e.at === "beside") {
        // On the rock: the face itself, or a few metres along it.
        const along = e.at === "face" ? 0 : side * (3.4 + random() * 0.8);
        const qx = wx + nx * 2 + tx * along, qz = wz + nz * 2 + tz * along;
        const back = reachTo(field, qx, f0 + 1.2, qz, dx, dz, 6);
        if (back === null) return;
        const px = qx + dx * (back + 0.05), pz = qz + dz * (back + 0.05);
        const f = floorAt(px + nx * 0.8, pz + nz * 0.8);
        if (f === null) return;
        put(m, px, f - 0.05, pz, nx, nz);
        return;
      }
      // On the floor: at the face's foot (the other side from what leans by it), or out near it, clear of the track.
      for (let attempt = 0; attempt < 5; attempt++) {
        const out = e.at === "foot" ? 1.6 + random() * 0.4 : 2.6 + random() * 2;
        const along = e.at === "foot" ? -side * (1.9 + random() * 0.6) : (random() < 0.5 ? 1 : -1) * (2.9 + random() * 1.6);
        const px = wx + nx * out + tx * along, pz = wz + nz * out + tz * along;
        const f = floorAt(px, pz);
        if (f === null || !clearOf(field, px, f, pz, 0.9) || taken.some(([a, c]) => Math.hypot(a - px, c - pz) < 2.2) || nearRail(px, pz, 1.6)) continue;
        taken.push([px, pz]);
        const turn = random() * Math.PI * 2;
        put(m, px, f - 0.03, pz, Math.sin(turn), Math.cos(turn));
        break;
      }
    });
    return { x: wx, z: wz, distance: r };
  };

  layout.parts.forEach((p, index) => {
    const random = mulberry32(deriveSeed(layout.seed, index * 6271 + 41));
    const seed = deriveSeed(layout.seed, index * 131 + 7);
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    const turn = (x: number, z: number): [number, number] => [x * c + z * s, -x * s + z * c];
    const sockets = p.part.sockets.filter((so) => so.type !== "surface").map((so) => {
      const f = (so.facing * Math.PI) / 180;
      const [ox, oz] = turn(Math.sin(f), Math.cos(f));
      return { at: toWorld(p, so.at), out: [ox, oz] as [number, number] };
    });
    const field0 = p.part.field ?? [];
    const tunnels = field0.flatMap((t) => (t.kind === "tunnel" ? [t.points.map((q) => toWorld(p, q))] : []));
    const chamber = field0.find((t) => t.kind === "chamber");

    // Tunnels: sets along them, lagging between, track down the middle.
    for (const line of tunnels) {
      const length = lineLength(line);
      if (setDef && length > SET_IN * 2 + 1) {
        const every = d.sets!.every;
        const count = Math.max(1, Math.round((length - SET_IN * 2) / every)) + 1;
        const spacing = (length - SET_IN * 2) / (count - 1);
        const sets = stepsAlong(line, spacing, SET_IN, length - SET_IN + 0.01).map((q) => ({ q, fit: fitSet(field, q.x, q.y, q.z, q.ux, q.uz) }));
        sets.forEach(({ q, fit }, n) => {
          if (!fit) return;
          const w = Math.round((fit.half - SET_T / 2 - 0.03) * 2 * 10) / 10;
          const h = Math.round((fit.roof - fit.foot - SET_OVER - 0.04) * 10) / 10;
          if (h < 2.5) return;
          const reach = Math.round(spacing * 0.42 * 10) / 10;
          const v = n % 3;
          put(model(`set:${w}:${h}:${reach}:${v}`, () => generateProp(fixed(setDef, { width: w, height: h, thickness: SET_T, reach }), seed, v)), fit.x, fit.foot - 0.05, fit.z, q.ux, q.uz);
        });
        // Lagging behind the posts, between two sets, up the walls.
        if (laggingDef) {
          for (let n = 0; n + 1 < sets.length; n++) {
            const a = sets[n].fit, e = sets[n + 1].fit;
            if (!a || !e) continue;
            for (const sd of [-1, 1]) {
              if (random() >= d.lagging!.chance) continue;
              const mx = (a.x + sd * a.ax * a.half + e.x + sd * e.ax * e.half) / 2, mz = (a.z + sd * a.az * a.half + e.z + sd * e.az * e.half) / 2;
              const ux = e.x - a.x, uz = e.z - a.z, ul = Math.hypot(ux, uz);
              if (ul < 1) continue;
              const height = Math.round(Math.min(a.roof - a.foot, e.roof - e.foot) * (0.55 + random() * 0.2) * 10) / 10;
              const width = Math.round((ul - SET_T * 1.2) * 10) / 10;
              const f = floorUnder(field, mx - sd * a.ax * 0.8, Math.max(a.foot, e.foot) + 2, mz - sd * a.az * 0.8);
              if (f === null || width < 1) continue;
              put(model(`lag:${width}:${height}`, () => generateProp(fixed(laggingDef, { width, height, props: 0 }), seed, 0)), mx, f - 0.05, mz, -sd * a.ax, -sd * a.az);
            }
          }
        }
      }
      lay(line, ["join", "join"], deriveSeed(seed, tunnels.indexOf(line)));
    }

    // A dead end (a socket's stub and nothing more): sets in it, its track up to a face at its end.
    if (field0.length === 0 && sockets.length === 1) {
      const { at, out } = sockets[0];
      const ix = -out[0], iz = -out[1];
      const f = floorUnder(field, at.x, at.y + 2.5, at.z);
      const depth = f === null ? null : reachTo(field, at.x + ix, f + 2, at.z + iz, ix, iz, 30);
      if (f !== null && depth !== null) {
        if (setDef) {
          for (const k of depth > 9 ? [SET_IN, SET_IN + 4.5] : [SET_IN]) {
            const fit = fitSet(field, at.x + ix * k, at.y, at.z + iz * k, ix, iz);
            if (!fit) continue;
            const w = Math.round((fit.half - SET_T / 2 - 0.03) * 2 * 10) / 10;
            const h = Math.round((fit.roof - fit.foot - SET_OVER - 0.04) * 10) / 10;
            if (h < 2.5) continue;
            put(model(`set:${w}:${h}:2.3:0`, () => generateProp(fixed(setDef, { width: w, height: h, thickness: SET_T, reach: 2.3 }), seed, 0)), fit.x, fit.foot - 0.05, fit.z, ix, iz);
          }
        }
        const wall = 1 + depth;
        const stop = wall - TRACK_SHORT;
        if (stop > 1.5) {
          lay([at, { x: at.x + ix * stop, y: at.y, z: at.z + iz * stop }], ["join", "free"], seed);
          const cart = stop - CART_OUT;
          if (cart > 1.5) park(at.x + ix * cart, at.y, at.z + iz * cart, ix, iz, random, seed);
        }
        workFace(at.x, at.y, at.z, ix, iz, random, seed);
      }
      return;
    }

    if (!chamber || chamber.kind !== "chamber") return;
    // A chamber: track in from every way to a turnplate in its middle, and on to its work face.
    const hub = toWorld(p, chamber.at);
    const hubFloor = floorUnder(field, hub.x, hub.y + 2.5, hub.z);
    if (hubFloor === null) return;
    sockets.forEach(({ at }, k) => lay([at, hub], ["join", "join"], deriveSeed(seed, 100 + k)));
    if (plateDef) put(model(`plate:${plateDef.id}`, () => generateProp(plateDef, seed, 0)), hub.x, hubFloor - 0.02, hub.z, 1, 0);
    // Stretches of its walls: on each of its four sides, either side of the middle - square to the
    // wall, so what stands there stands flat on it. Furthest from its ways in first.
    const [rx, rz] = chamber.radius;
    const local = p.part.sockets.filter((so) => so.type !== "surface").map((so) => so.at);
    const stretches = [[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([nx, nz]) =>
      [-0.5, 0.5].map((off) => {
        const r = nx !== 0 ? rx : rz, across = nx !== 0 ? rz : rx;
        const lx = chamber.at.x + nx * r + nz * off * across, lz = chamber.at.z + nz * r + nx * off * across;
        const score = Math.min(...local.map((q) => Math.hypot(q.x - lx, q.z - lz)), Infinity);
        const inside = toWorld(p, { x: lx - nx * r * 0.5, y: chamber.at.y, z: lz - nz * r * 0.5 });
        const [dx, dz] = turn(nx, nz);
        return { inside, dx, dz, score: score + random() * 2 };
      }),
    ).sort((a, b) => b.score - a.score);
    // The face: on the first, its track from the middle bending in square to it.
    const first = stretches.shift();
    if (first) {
      const { inside, dx, dz } = first;
      const f = floorUnder(field, inside.x, hubFloor + 3, inside.z);
      const wall = f === null ? null : reachTo(field, inside.x, f + 2, inside.z, dx, dz, 30);
      if (wall !== null && f !== null) {
        const wx = inside.x + dx * wall, wz = inside.z + dz * wall;
        const stop = { x: wx - dx * TRACK_SHORT, y: hub.y, z: wz - dz * TRACK_SHORT };
        const bend = { x: wx - dx * (TRACK_SHORT + 6), y: hub.y, z: wz - dz * (TRACK_SHORT + 6) };
        const line = Math.hypot(bend.x - hub.x, bend.z - hub.z) > 3 ? [hub, bend, stop] : [hub, stop];
        lay(line, ["join", "free"], deriveSeed(seed, 99));
        park(stop.x - dx * CART_OUT, hub.y, stop.z - dz * CART_OUT, dx, dz, random, seed);
        workFace(bend.x, hub.y, bend.z, dx, dz, random, seed);
      }
    }
    // Shoring against its walls: on the next stretches, as high as the wall stands upright.
    if (shoringDef) {
      const [lo, hi] = d.shoring!.count;
      const count = lo + Math.floor(random() * (hi - lo + 1));
      for (let n = 0; n < count && stretches.length > 0; ) {
        const { inside, dx, dz } = stretches.shift()!;
        const r = reachTo(field, inside.x, hubFloor + 1.2, inside.z, dx, dz, 30);
        if (r === null || r < 3.5) continue;
        const px = inside.x + dx * (r - 3), pz = inside.z + dz * (r - 3);
        const f = floorUnder(field, px + dx * 2, hubFloor + 3, pz + dz * 2);
        if (f === null) continue;
        const at1 = reachTo(field, px, f + 1, pz, dx, dz, 8);
        if (at1 === null) continue;
        let near = at1, height = 1;
        for (let y = 1.5; y <= 7; y += 0.5) {
          const q = reachTo(field, px, f + y, pz, dx, dz, 8);
          if (q === null || q < at1 - 0.8) break;
          near = Math.min(near, q);
          height = y;
        }
        if (height < 3) continue;
        n++;
        const width = Math.round((5 + random() * 2.5) * 10) / 10, h = Math.round(height * 10) / 10;
        put(model(`shore:${width}:${h}`, () => generateProp(fixed(shoringDef, { width, height: h, props: 1 }), seed, n)), px + dx * (near + 0.05), f - 0.05, pz + dz * (near + 0.05), -dx, -dz);
      }
    }
    // What stands free on its floor, clear of its track.
    for (const e of extras) {
      if (random() >= e.chance) continue;
      const reach = Math.min(chamber.radius[0], chamber.radius[1]) * 0.6;
      for (let attempt = 0; attempt < 12; attempt++) {
        const a = random() * Math.PI * 2, r = 4 + random() * Math.max(0, reach - 4);
        const x = hub.x + Math.sin(a) * r, z = hub.z + Math.cos(a) * r;
        const f = floorUnder(field, x, hubFloor + 3, z);
        if (f === null || !clearOf(field, x, f, z, 1.6) || nearRail(x, z, 3.4)) continue;
        const t = random() * Math.PI * 2;
        put(generateProp(e.def, seed, Math.floor(random() * 6)), x, f - 0.03, z, Math.sin(t), Math.cos(t));
        break;
      }
    }
  });
  return placed;
}

/** The fixtures at a cave's light spots: their models together, their lights and flames. */
export function caveFixtures(layout: DungeonLayout, style: DungeonStyleDef, field: CaveField, props: (id: string) => PropDef | undefined): CaveFixtures {
  const options = (style.light.fixtures ?? [{ prop: style.light.fixture, weight: 1, place: "wall" as const }])
    .map((f) => ({ ...f, def: props(f.prop) }))
    .filter((f): f is typeof f & { def: PropDef } => {
      if (!f.def) console.warn(`The dungeon style "${style.id}" names a fixture "${f.prop}" that no pack has.`);
      return !!f.def;
    });
  const b = new ModelBuilder();
  let placed = 0;
  if (options.length > 0) {
    const total = options.reduce((s, o) => s + o.weight, 0);
    layout.parts.forEach((p, index) => {
      const random = mulberry32(deriveSeed(layout.seed, index * 7919 + 13));
      placedSpots(p, "light").forEach((spot, i) => {
        if (random() >= style.light.lit) return;
        let r = random() * total;
        const option = options.find((o) => (r -= o.weight) < 0) ?? options[options.length - 1];
        const model = generateProp(option.def, deriveSeed(layout.seed, index * 131 + i), i);
        const start = random() * Math.PI * 2;
        const floor = floorUnder(field, spot.x, spot.y + 2, spot.z);
        if (floor === null) return;
        if (option.place === "floor") {
          // On the floor where the spot is, turned any way.
          b.appendFurniture(model, spot.x, floor, spot.z, Math.sin(start), Math.cos(start));
          placed++;
          return;
        }
        const level = option.place === "wall" ? floor + TORCH_HEIGHT : floor + 1;
        const wall = nearestWall(field, spot.x, level, spot.z, start);
        if (!wall) return;
        if (option.place === "wall") {
          // Its back on the rock (the prop's back 0.35 m behind its origin), facing out; its flame at the height.
          const flame = model.lights?.[0]?.position[1] ?? 0;
          b.appendFurniture(model, wall.x + wall.out[0] * 0.3, level - flame, wall.z + wall.out[1] * 0.3, wall.out[0], wall.out[1]);
        } else {
          // At the wall's foot: a little out from where the rock rises, on the floor there.
          const x = wall.x + wall.out[0] * 1.2, z = wall.z + wall.out[1] * 1.2;
          const foot = floorUnder(field, x, floor + 2, z);
          if (foot === null) return;
          b.appendFurniture(model, x, foot - 0.05, z, wall.out[0], wall.out[1]);
        }
        placed++;
      });
    });
  }
  placed += dress(b, layout, style, field, props);
  const model = placed > 0 ? b.finish({ x: 0, z: 0 }) : null;
  return { model, lights: model?.lights ?? [], effects: model?.effects ?? [] };
}
