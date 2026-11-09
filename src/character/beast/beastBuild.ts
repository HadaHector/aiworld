import { curveSampler } from "../curve";
import { add, cross, dot, length, lerp, normalize, scale, sub, type Vec } from "../skeleton";
import { mulberry32, deriveSeed } from "../../world/rng";
import { bonesMatching, limbBoneName, type BeastDef, type CardDef, type LimbSet, type PartDef, type TrunkSegment } from "./beastDef";

/**
 * A beast's body built from its plan (BEASTS.md): the trunk as one tube of rings sampled from its
 * segments' curves, from the snout's tip to the tail's; every limb a tube of its own, rooted inside
 * the trunk; rigid parts (ears, horns, tusks, fangs, claws) as small cones on bones; and every
 * surface's place in one atlas, laid out by construction. Plain numbers only, so a worker can make it.
 *
 * The body's frame is the humanoids': +z forward, +y up, +x its right; feet on y = 0.
 */
export interface BeastBone {
  name: string;
  parent: number;
  head: Vec;
  tail: Vec;
  kind: "root" | "trunk" | "limb";
  role: TrunkSegment["role"] | "limb";
}

/** One limb as the animation needs it: its bones, its plane, its rest angles and where it starts. */
export interface BeastLimb {
  set: string;
  pair: number;
  /** -1 left, +1 right, 0 a single limb on the middle. */
  side: number;
  /** Where it stands among the walking limbs, front to back (for the gait's pattern), and how many. */
  rank: number;
  bones: number[];
  lengths: number[];
  /** Its plane: `e2` straight down tilted by its splay, `e1` its heading, `n` the axis it bends about. */
  e1: Vec;
  e2: Vec;
  n: Vec;
  rest: number[];
  attach: Vec;
  /** The foot's tip at rest, and how far its sole sits under its last joint. */
  tip: Vec;
  sole: number;
  walks: boolean;
  /** The trunk bone it hangs off. */
  on: number;
}

/** A tube's rings as the painter needs them: where every vertex is and which way it faces. */
export interface BeastTube {
  kind: "trunk" | "limb";
  /** For a limb: which set, and 0 at its root to 1 at its tip per ring; for the trunk: the segment
   *  index per ring and how far along that segment. */
  limb: string;
  rings: number;
  columns: number;
  positions: Float32Array;
  normals: Float32Array;
  /** Per ring: its segment (trunk) or limb segment (limb), its share along that, and along the whole tube 0-1. */
  segment: number[];
  along: number[];
  whole: number[];
  /** Per ring, where it is down the tube's rect, 0-1 (by distance along its axis). */
  v: number[];
  rect: AtlasRect;
}

export interface AtlasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A card group's strips, drawn alpha-tested in a mesh of their own (BEASTS.md, *Alpha cards*). */
export interface BeastCards {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  joints: Float32Array;
  weights: Float32Array;
  indices: Uint32Array;
  /** Per vertex, 0 at a card's root to 1 at its tip: how much it sways. */
  sway: Float32Array;
  /** Which masks and colours the card texture holds, in its rows. */
  rows: { mask: CardDef["mask"]; colour: string; variant: number }[];
  count: number;
}

export interface BeastGeometry {
  id: string;
  /** The individual's overall scale (the mesh is drawn at it) and girth (built in). */
  size: number;
  build: number;
  bones: BeastBone[];
  limbs: BeastLimb[];
  tubes: BeastTube[];
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  joints: Float32Array;
  weights: Float32Array;
  indices: Uint32Array;
  cards: BeastCards;
  /** Atlas swatches for the parts' colours: a rect per palette colour, painted root to tip. */
  swatches: Record<string, AtlasRect>;
  atlasSize: number;
  /** Parts that made it onto this individual, and card groups. */
  parts: string[];
  cardGroups: string[];
  triangles: number;
  /** Top of the body at scale 1, its length nose to tail, its widest and the trunk's lowest point. */
  height: number;
  length: number;
  width: number;
  /** Bone indices by use (FEEDBACK.md places): mouth, head, chest, tail; feet are the limbs' last bones. */
  places: Record<string, number>;
  /** Eye centres on the bind-pose body, for the painter. */
  eyes: Vec[];
  /** Limb roots on the trunk, for the painter's shade under them. */
  roots: { at: Vec; radius: number }[];
}

export interface BeastOptions {
  /** The individual: picks its size, build, parts and cards. */
  seed: number;
  /** Traits of its kind (CREATURES.md): parts and cards they name are certain, and grow. */
  traits?: string[];
  atlas?: number;
  /** Rings and vertices times this. */
  detail?: number;
}

const RIGHT: Vec = [1, 0, 0];
const UP: Vec = [0, 1, 0];

/** Rolls an individual's size and build from its seed, as the plan's ranges allow. */
export function beastLooks(def: BeastDef, seed: number): { size: number; build: number; rng: () => number } {
  const rng = mulberry32(deriveSeed(seed >>> 0, hashId(def.id)));
  const size = def.size[0] + (def.size[1] - def.size[0]) * rng();
  const build = def.build[0] + (def.build[1] - def.build[0]) * rng();
  return { size, build, rng };
}

export function hashId(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A segment's cross-section at `t`: above, below and to each side of its axis, and how round. */
interface Section {
  up: number;
  down: number;
  side: number;
  round: number;
}

/** The superellipse point at angle `theta` (0 up, toward +x), its extents those of `s`. */
function sectionPoint(s: Section, theta: number): [number, number] {
  const n = 2 + (1 - s.round) * 6;
  const c = Math.cos(theta);
  const si = Math.sin(theta);
  const y = (c >= 0 ? s.up : s.down) * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
  const x = s.side * Math.sign(si) * Math.pow(Math.abs(si), 2 / n);
  return [x, y];
}

export function buildBeast(def: BeastDef, options: BeastOptions): BeastGeometry {
  const { size, build, rng } = beastLooks(def, options.seed);
  const traits = new Set(options.traits ?? []);
  const detail = options.detail ?? 1;
  const trunkVerts = Math.max(4, Math.round(def.verts.trunk * detail));
  const limbVerts = Math.max(3, Math.round(def.verts.limb * detail));

  // ---- The trunk's line: every segment's front and back end, from the root out.
  const segs = def.trunk;
  const r = Math.max(0, segs.findIndex((s) => s.id === def.root));
  const dirOf = (s: TrunkSegment): Vec => {
    const a = (s.slope * Math.PI) / 180;
    return [0, Math.sin(a), Math.cos(a)];
  };
  const front: Vec[] = new Array(segs.length);
  const back: Vec[] = new Array(segs.length);
  back[r] = [0, 0, -segs[r].length / 2];
  front[r] = add(back[r], scale(dirOf(segs[r]), segs[r].length));
  for (let i = r - 1; i >= 0; i--) {
    back[i] = front[i + 1];
    front[i] = add(back[i], scale(dirOf(segs[i]), segs[i].length));
  }
  for (let i = r + 1; i < segs.length; i++) {
    front[i] = back[i - 1];
    back[i] = sub(front[i], scale(dirOf(segs[i]), segs[i].length));
  }
  const sampled = segs.map((s) => ({ up: curveSampler(s.up), down: curveSampler(s.down), side: curveSampler(s.side) }));
  const sectionAt = (i: number, t: number): Section => ({ up: sampled[i].up(t) * build, down: sampled[i].down(t) * build, side: sampled[i].side(t) * build, round: segs[i].round });
  const axisAt = (i: number, t: number): Vec => lerp(front[i], back[i], t);

  // ---- Bones: a root at the root segment's middle, the trunk out from it, then the limbs.
  const bones: BeastBone[] = [];
  const trunkBone: number[] = new Array(segs.length);
  const mid = lerp(front[r], back[r], 0.5);
  bones.push({ name: segs[r].id, parent: -1, head: mid, tail: front[r], kind: "root", role: segs[r].role });
  trunkBone[r] = 0;
  for (let i = r - 1; i >= 0; i--) {
    trunkBone[i] = bones.length;
    bones.push({ name: segs[i].id, parent: trunkBone[i + 1], head: back[i], tail: front[i], kind: "trunk", role: segs[i].role });
  }
  for (let i = r + 1; i < segs.length; i++) {
    trunkBone[i] = bones.length;
    bones.push({ name: segs[i].id, parent: trunkBone[i - 1], head: front[i], tail: back[i], kind: "trunk", role: segs[i].role });
  }
  const segIndex = new Map(segs.map((s, i) => [s.id, i]));

  // ---- Geometry, as it grows.
  const P: number[] = [];
  const N: number[] = [];
  const UV: number[] = [];
  const J: number[] = [];
  const W: number[] = [];
  const I: number[] = [];
  const vertex = (p: Vec, n: Vec, uv: [number, number], influences: [number, number][]): number => {
    const index = P.length / 3;
    P.push(p[0], p[1], p[2]);
    N.push(n[0], n[1], n[2]);
    UV.push(uv[0], uv[1]);
    const top = influences.filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((s, [, w]) => s + w, 0) || 1;
    for (let k = 0; k < 4; k++) {
      J.push(top[k]?.[0] ?? 0);
      W.push(top[k] ? top[k][1] / total : 0);
    }
    return index;
  };
  /** A triangle facing away from `inside`. */
  const tri = (a: number, b: number, c: number, inside: Vec): void => {
    const pa: Vec = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
    const pb: Vec = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]];
    const pc: Vec = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
    const face = cross(sub(pb, pa), sub(pc, pa));
    const middle = scale(add(add(pa, pb), pc), 1 / 3);
    if (dot(face, sub(middle, inside)) >= 0) I.push(a, b, c);
    else I.push(a, c, b);
  };

  // ---- Rings: the trunk's, then each limb's - as grids of points, for the mesh and the painter.
  interface RingGrid {
    points: Vec[][];
    centres: Vec[];
    weights: [number, number][][];
    segment: number[];
    along: number[];
    tip: [Vec, Vec] | null;
    start: [Vec, Vec] | null;
  }
  const trunk: RingGrid = { points: [], centres: [], weights: [], segment: [], along: [], tip: null, start: null };
  const blendWeights = (own: number, before: number, after: number, t: number): [number, number][] => {
    const reach = 0.3;
    if (t < reach && before >= 0) return [[own, 0.5 + (0.5 * t) / reach], [before, 0.5 - (0.5 * t) / reach]];
    if (t > 1 - reach && after >= 0) return [[own, 0.5 + (0.5 * (1 - t)) / reach], [after, 0.5 - (0.5 * (1 - t)) / reach]];
    return [[own, 1]];
  };
  for (let i = 0; i < segs.length; i++) {
    const count = Math.max(1, Math.round(segs[i].rings * detail));
    const last = i === segs.length - 1;
    for (let k = 0; k <= (last ? count : count - 1); k++) {
      const t = k / count;
      const shared = k === 0 && i > 0;
      // The ring where two segments meet takes both's curves, half and half.
      let section = sectionAt(i, t);
      if (shared) {
        const before = sectionAt(i - 1, 1);
        section = { up: (section.up + before.up) / 2, down: (section.down + before.down) / 2, side: (section.side + before.side) / 2, round: (section.round + before.round) / 2 };
      }
      const forward = shared ? normalize(add(dirOf(segs[i]), dirOf(segs[i - 1]))) : dirOf(segs[i]);
      const up = cross(forward, RIGHT);
      const centre = axisAt(i, t);
      const ring: Vec[] = [];
      for (let j = 0; j < trunkVerts; j++) {
        const theta = Math.PI + (2 * Math.PI * j) / trunkVerts;
        const [x, y] = sectionPoint(section, theta);
        ring.push(add(centre, add(scale(RIGHT, x), scale(up, y))));
      }
      trunk.points.push(ring);
      trunk.centres.push(centre);
      // Which bones: the segment's own, blended over the joints with its neighbours'.
      const own = trunkBone[i];
      const toward = (j: number): number => (j >= 0 && j < segs.length ? trunkBone[j] : -1);
      // Where segments meet the joint is the one further from the root's.
      trunk.weights.push(shared ? [[own, 0.5], [trunkBone[i - 1], 0.5]] : blendWeights(own, toward(i - 1), toward(i + 1), t));
      trunk.segment.push(i);
      trunk.along.push(t);
    }
  }
  // The ends close on a point a little past the last ring.
  {
    const first = sectionAt(0, 0);
    const lastSection = sectionAt(segs.length - 1, 1);
    const tipF = add(front[0], scale(dirOf(segs[0]), Math.min(first.up + first.down, first.side * 2) * 0.25));
    const tipB = sub(back[segs.length - 1], scale(dirOf(segs[segs.length - 1]), Math.min(lastSection.up + lastSection.down, lastSection.side * 2) * 0.25));
    trunk.start = [tipF, front[0]];
    trunk.tip = [tipB, back[segs.length - 1]];
  }

  // ---- Limbs.
  const limbs: BeastLimb[] = [];
  const limbGrids: { grid: RingGrid; set: LimbSet; limb: BeastLimb; fraction: number[] }[] = [];
  const roots: { at: Vec; radius: number }[] = [];
  for (const set of def.limbs) {
    const on = segIndex.get(set.on) ?? r;
    const sides = set.single ? [0] : [-1, 1];
    for (let pair = 0; pair < set.count; pair++) {
      const u = set.count > 1 ? pair / (set.count - 1) : 0;
      const at = set.at[0] + (set.at[1] - set.at[0]) * u;
      const yaw = ((set.yaw[0] + (set.yaw[1] - set.yaw[0]) * u) * Math.PI) / 180;
      const lengthScale = set.scale[0] + (set.scale[1] - set.scale[0]) * u;
      for (const side of sides) {
        const attach = add(axisAt(on, at), [side * set.out * build, -set.drop, 0]);
        const heading: Vec = normalize([Math.sin(yaw) * (side || 1), 0, Math.cos(yaw)]);
        const splay = (set.splay * Math.PI) / 180;
        let e2 = normalize(add([0, -1, 0], scale(RIGHT, side * Math.tan(splay) * Math.abs(Math.cos(yaw)))));
        const e1 = normalize(sub(heading, scale(e2, dot(heading, e2))));
        e2 = normalize(sub(e2, scale(e1, dot(e2, e1))));
        const n = normalize(cross(e2, e1));
        const sideName = side < 0 ? "L" : side > 0 ? "R" : "";
        const joints: Vec[] = [attach];
        const directions: Vec[] = [];
        const lengths: number[] = [];
        const rest: number[] = [];
        set.segments.forEach((seg, k) => {
          const a = (seg.angle * Math.PI) / 180;
          const d = add(scale(e2, Math.cos(a)), scale(e1, Math.sin(a)));
          directions.push(d);
          lengths.push(seg.length * lengthScale);
          rest.push(a);
          joints.push(add(joints[k], scale(d, seg.length * lengthScale)));
        });
        const boneIds: number[] = [];
        set.segments.forEach((_, k) => {
          boneIds.push(bones.length);
          bones.push({ name: limbBoneName(set, pair, sideName, k), parent: k === 0 ? trunkBone[on] : boneIds[k - 1], head: joints[k], tail: joints[k + 1], kind: "limb", role: "limb" });
        });
        const widthOf = set.segments.map((seg) => curveSampler(seg.width));
        const lastSeg = set.segments.length - 1;
        const sole = widthOf[lastSeg](1) * build * set.segments[lastSeg].depth;
        const limb: BeastLimb = { set: set.id, pair, side, rank: 0, bones: boneIds, lengths, e1, e2, n, rest, attach, tip: joints[joints.length - 1], sole, walks: set.walks, on: trunkBone[on] };
        limbs.push(limb);
        roots.push({ at: attach, radius: widthOf[0](0) * build * 1.4 });
        // Its rings, segment by segment, the joints shared.
        const grid: RingGrid = { points: [], centres: [], weights: [], segment: [], along: [], tip: null, start: null };
        const fraction: number[] = [];
        const total = lengths.reduce((s, l) => s + l, 0);
        let gone = 0;
        let prevFront: Vec | null = null;
        let prevAlong: Vec | null = null;
        set.segments.forEach((seg, k) => {
          const count = Math.max(1, Math.round(seg.rings * detail));
          const last = k === lastSeg;
          for (let q = 0; q <= (last ? count : count - 1); q++) {
            const t = q / count;
            const shared = q === 0 && k > 0;
            const along = shared ? normalize(add(directions[k], directions[k - 1])) : directions[k];
            // Its front: toward the heading at the root, then carried down the limb turning as the limb
            // turns (parallel transport), so a paw bent forward keeps its rings untwisted.
            const f = prevFront ? transport(prevFront, prevAlong!, along) : normalize(sub(e1, scale(along, dot(e1, along))));
            prevFront = f;
            prevAlong = along;
            const s = cross(along, f);
            const radius = (shared ? (widthOf[k](0) + widthOf[k - 1](1)) / 2 : widthOf[k](t)) * build;
            const depth = shared ? (seg.depth + set.segments[k - 1].depth) / 2 : seg.depth;
            const centre = add(joints[k], scale(directions[k], lengths[k] * t));
            const ring: Vec[] = [];
            for (let j = 0; j < limbVerts; j++) {
              const theta = Math.PI + (2 * Math.PI * j) / limbVerts;
              ring.push(add(centre, add(scale(f, Math.cos(theta) * radius * depth), scale(s, Math.sin(theta) * radius))));
            }
            grid.points.push(ring);
            grid.centres.push(centre);
            const own = boneIds[k];
            const weights = shared ? ([[own, 0.5], [boneIds[k - 1], 0.5]] as [number, number][]) : blendWeights(own, k > 0 ? boneIds[k - 1] : trunkBone[on], k < lastSeg ? boneIds[k + 1] : -1, t);
            grid.weights.push(weights);
            grid.segment.push(k);
            grid.along.push(t);
            fraction.push((gone + lengths[k] * t) / total);
          }
          gone += lengths[k];
        });
        const endR = widthOf[lastSeg](1) * build;
        grid.tip = [add(joints[joints.length - 1], scale(directions[lastSeg], endR * 0.6)), joints[joints.length - 1]];
        grid.start = [sub(attach, scale(directions[0], widthOf[0](0) * build * 0.5)), attach];
        limbGrids.push({ grid, set, limb, fraction });
      }
    }
  }
  // Walking limbs ranked front to back.
  const walking = limbs.filter((l) => l.walks);
  const fronts = [...new Set(walking.map((l) => l.attach[2]))].sort((a, b) => b - a);
  for (const limb of walking) limb.rank = fronts.indexOf(limb.attach[2]);

  // ---- Stand it on the ground: the lowest walking sole on y = 0 (or the trunk's belly, legless).
  let lowest = Infinity;
  for (const limb of walking) lowest = Math.min(lowest, limb.tip[1] - limb.sole);
  if (!Number.isFinite(lowest)) for (const ring of trunk.points) for (const p of ring) lowest = Math.min(lowest, p[1]);
  const lift: Vec = [0, -lowest, 0];
  const raise = (p: Vec): Vec => add(p, lift);
  for (const b of bones) {
    b.head = raise(b.head);
    b.tail = raise(b.tail);
  }
  for (const limb of limbs) {
    limb.attach = raise(limb.attach);
    limb.tip = raise(limb.tip);
  }
  for (const root of roots) root.at = raise(root.at);
  const lifted = (grid: RingGrid): void => {
    grid.points = grid.points.map((ring) => ring.map(raise));
    grid.centres = grid.centres.map(raise);
    if (grid.tip) grid.tip = [raise(grid.tip[0]), raise(grid.tip[1])];
    if (grid.start) grid.start = [raise(grid.start[0]), raise(grid.start[1])];
  };
  lifted(trunk);
  for (const g of limbGrids) lifted(g.grid);

  // ---- The atlas: a rect per tube, a swatch per colour parts use, packed in rows.
  const atlasSize = options.atlas ?? 256;
  const circumference = (ring: Vec[]): number => ring.reduce((s, p, j) => s + length(sub(p, ring[(j + 1) % ring.length])), 0);
  const tubeLength = (grid: RingGrid): number => grid.centres.reduce((s, c, k) => (k === 0 ? 0 : s + length(sub(c, grid.centres[k - 1]))), 0);
  const tubeSpecs = [{ grid: trunk, round: Math.max(...trunk.points.map(circumference)), long: tubeLength(trunk) }, ...limbGrids.map((g) => ({ grid: g.grid, round: Math.max(...g.grid.points.map(circumference)), long: tubeLength(g.grid) }))];
  const partColours = new Set<string>();
  const chosenParts: { part: PartDef; side: number; scale: number }[] = [];
  for (const part of def.parts) {
    const forced = Object.keys(part.traits).some((t) => traits.has(t));
    for (const side of part.mirror ? [-1, 1] : [1]) {
      // Both sides of a pair come together: rolled once.
      if (side === 1 || !part.mirror) {
        const roll = rng();
        const s = part.scale[0] + (part.scale[1] - part.scale[0]) * rng();
        if (!forced && roll >= part.chance) continue;
        let k = s;
        for (const [t, m] of Object.entries(part.traits)) if (traits.has(t)) k *= m;
        if (part.mirror) chosenParts.push({ part, side: -1, scale: k }, { part, side: 1, scale: k });
        else chosenParts.push({ part, side: 0, scale: k });
        partColours.add(part.colour);
      }
    }
  }
  const swatchList = [...partColours];
  const areas = tubeSpecs.map((t) => t.round * t.long).reduce((s, a) => s + a, 0);
  // Texels a metre, so the tubes fill about two thirds of the atlas.
  let density = Math.sqrt((atlasSize * atlasSize * 0.8) / Math.max(1e-6, areas));
  const swatch = 8;
  let placed: AtlasRect[] = [];
  let swatches: Record<string, AtlasRect> = {};
  for (let attempt = 0; attempt < 12; attempt++) {
    const items = tubeSpecs.map((t, i) => ({ i, w: Math.max(6, Math.ceil(t.round * density) + 1), h: Math.max(6, Math.ceil(t.long * density) + 1) }));
    for (let s = 0; s < swatchList.length; s++) items.push({ i: tubeSpecs.length + s, w: swatch, h: swatch * 2 });
    const packed = packRects(items, atlasSize, 2);
    if (packed) {
      placed = packed.slice(0, tubeSpecs.length);
      swatches = Object.fromEntries(swatchList.map((c, s) => [c, packed[tubeSpecs.length + s]]));
      break;
    }
    density *= 0.88;
  }
  const uvOf = (rect: AtlasRect, u: number, v: number): [number, number] => [(rect.x + 0.5 + u * (rect.w - 1)) / atlasSize, (rect.y + 0.5 + v * (rect.h - 1)) / atlasSize];

  // ---- Tubes into the mesh: per ring, columns + 1 (the seam's twin), normals from the grid.
  const tubes: BeastTube[] = [];
  const emitTube = (grid: RingGrid, rect: AtlasRect, kind: "trunk" | "limb", limbName: string, whole: number[]): void => {
    const rings = grid.points.length;
    const columns = grid.points[0].length;
    const normals: Vec[][] = grid.points.map((ring, k) =>
      ring.map((p, j) => {
        const around = sub(ring[(j + 1) % columns], ring[(j - 1 + columns) % columns]);
        const along = sub(grid.centres[Math.min(rings - 1, k + 1)], grid.centres[Math.max(0, k - 1)]);
        const ringAlong = sub(grid.points[Math.min(rings - 1, k + 1)][j], grid.points[Math.max(0, k - 1)][j]);
        let normal = normalize(cross(around, length(ringAlong) > 1e-6 ? ringAlong : along));
        if (dot(normal, sub(p, grid.centres[k])) < 0) normal = scale(normal, -1);
        return normal;
      }),
    );
    const along: number[] = [0];
    for (let k = 1; k < rings; k++) along.push(along[k - 1] + length(sub(grid.centres[k], grid.centres[k - 1])));
    const total = along[rings - 1] || 1;
    const ids: number[][] = [];
    for (let k = 0; k < rings; k++) {
      const row: number[] = [];
      for (let j = 0; j <= columns; j++) row.push(vertex(grid.points[k][j % columns], normals[k][j % columns], uvOf(rect, j / columns, along[k] / total), grid.weights[k]));
      ids.push(row);
    }
    for (let k = 0; k < rings - 1; k++) {
      const inside = lerp(grid.centres[k], grid.centres[k + 1], 0.5);
      for (let j = 0; j < columns; j++) {
        tri(ids[k][j], ids[k + 1][j], ids[k + 1][j + 1], inside);
        tri(ids[k][j], ids[k + 1][j + 1], ids[k][j + 1], inside);
      }
    }
    // Caps: a fan to a point at each end.
    const capAt = (end: [Vec, Vec] | null, k: number, v: number): void => {
      if (!end) return;
      const [point, inner] = end;
      const outward = normalize(sub(point, inner));
      const tip = vertex(point, length(outward) > 0 ? outward : UP, uvOf(rect, 0.5, v), grid.weights[k]);
      for (let j = 0; j < columns; j++) tri(ids[k][j], ids[k][j + 1], tip, inner);
    };
    capAt(grid.start, 0, 0);
    capAt(grid.tip, rings - 1, 1);
    const flat = (rows: Vec[][]): Float32Array => Float32Array.from(rows.flatMap((ring) => ring.flatMap((p) => p)));
    tubes.push({ kind, limb: limbName, rings, columns, positions: flat(grid.points), normals: flat(normals), segment: grid.segment, along: grid.along, whole, v: along.map((a) => a / total), rect });
  };
  emitTube(trunk, placed[0], "trunk", "", trunk.points.map((_, k) => k / Math.max(1, trunk.points.length - 1)));
  limbGrids.forEach((g, i) => emitTube(g.grid, placed[i + 1], "limb", g.set.id, g.fraction));

  // ---- Parts: cones on bones' surfaces.
  const surfaceOf = (boneName: string, t: number, theta: number): { point: Vec; normal: Vec; depth: number } | null => {
    const s = segIndex.get(boneName);
    if (s !== undefined) {
      const section = sectionAt(s, t);
      const forward = dirOf(segs[s]);
      const up = cross(forward, RIGHT);
      const [x, y] = sectionPoint(section, theta);
      const centre = raise(axisAt(s, t));
      const offset = add(scale(RIGHT, x), scale(up, y));
      return { point: add(centre, offset), normal: normalize(offset), depth: length(offset) };
    }
    const b = bones.findIndex((bone) => bone.name === boneName);
    if (b < 0) return null;
    const bone = bones[b];
    const limb = limbs.find((l) => l.bones.includes(b));
    const set = limb && def.limbs.find((l) => l.id === limb.set);
    const k = limb ? limb.bones.indexOf(b) : 0;
    const radius = set ? curveSampler(set.segments[k].width)(t) * build : 0.03;
    const along = normalize(sub(bone.tail, bone.head));
    const fromHeading = limb ? sub(limb.e1, scale(along, dot(limb.e1, along))) : UP;
    const f = length(fromHeading) > 0.3 ? normalize(fromHeading) : normalize(sub(limb!.e2, scale(along, dot(limb!.e2, along))));
    const side = cross(along, f);
    const offset = scale(add(scale(f, Math.cos(theta)), scale(side, Math.sin(theta))), radius);
    return { point: add(lerp(bone.head, bone.tail, t), offset), normal: normalize(offset), depth: radius };
  };
  const boneIndex = new Map(bones.map((b, i) => [b.name, i]));
  for (const { part, side, scale: k } of chosenParts) {
    const mirror = side < 0 ? -1 : 1;
    const theta = (part.around * mirror * Math.PI) / 180;
    // A mirrored part named on a right limb's bone goes on the left one's for its left twin.
    const boneName = mirror < 0 ? otherSide(part.bone) : part.bone;
    const surface = surfaceOf(boneName, part.at, theta);
    const boneId = boneIndex.get(boneName);
    if (!surface || boneId === undefined) continue;
    const rootAt = sub(surface.point, scale(surface.normal, surface.depth * part.sink));
    const dir = normalize([part.direction[0] * mirror, part.direction[1], part.direction[2]]);
    let perp = sub(UP, scale(dir, dot(UP, dir)));
    if (length(perp) < 1e-3) perp = [0, 0, 1];
    perp = normalize(perp);
    const across = normalize(cross(dir, perp));
    const len = part.length * k;
    const rad = part.radius * k;
    const rect = swatches[part.colour];
    const ringsN = 4;
    const vertsN = part.shape === "blade" ? 4 : 5;
    const ids: number[][] = [];
    const centres: Vec[] = [];
    for (let q = 0; q <= ringsN; q++) {
      const u = q / (ringsN + 1);
      const centre = add(add(rootAt, scale(dir, len * u)), scale(perp, part.curve * len * u * u));
      centres.push(centre);
      // The axis's way here, for the ring's plane.
      const next = add(add(rootAt, scale(dir, len * (u + 0.01))), scale(perp, part.curve * len * (u + 0.01) * (u + 0.01)));
      const axis = normalize(sub(next, centre));
      const a = normalize(cross(axis, across));
      const b = cross(axis, a);
      const radius = rad * Math.pow(1 - u, 0.8);
      const row: number[] = [];
      for (let j = 0; j <= vertsN; j++) {
        const th = (2 * Math.PI * j) / vertsN;
        const off = add(scale(a, Math.cos(th) * radius * part.flat), scale(b, Math.sin(th) * radius));
        row.push(vertex(add(centre, off), normalize(off), rect ? uvOf(rect, j / vertsN, u) : [0, 0], [[boneId, 1]]));
      }
      ids.push(row);
    }
    for (let q = 0; q < ringsN; q++) {
      const inside = lerp(centres[q], centres[q + 1], 0.5);
      for (let j = 0; j < vertsN; j++) {
        tri(ids[q][j], ids[q + 1][j], ids[q + 1][j + 1], inside);
        tri(ids[q][j], ids[q + 1][j + 1], ids[q][j + 1], inside);
      }
    }
    const tipPoint = add(add(rootAt, scale(dir, len)), scale(perp, part.curve * len));
    const tipId = vertex(tipPoint, dir, rect ? uvOf(rect, 0.5, 1) : [0, 0], [[boneId, 1]]);
    for (let j = 0; j < vertsN; j++) tri(ids[ringsN][j], ids[ringsN][j + 1], tipId, centres[ringsN]);
  }

  // ---- Cards (BEASTS.md, *Alpha cards*).
  const cards = buildCards(def, traits, rng, surfaceOf, boneIndex, bones);

  // ---- What it measures, and its places.
  let top = 0;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxX = 0;
  for (let v = 0; v < P.length; v += 3) {
    top = Math.max(top, P[v + 1]);
    minZ = Math.min(minZ, P[v + 2]);
    maxZ = Math.max(maxZ, P[v + 2]);
    maxX = Math.max(maxX, Math.abs(P[v]));
  }
  const headSeg = segs.findIndex((s) => s.role === "head");
  const places: Record<string, number> = {
    head: trunkBone[headSeg >= 0 ? headSeg : 0],
    mouth: trunkBone[headSeg >= 0 ? headSeg : 0],
    chest: 0,
    tail: trunkBone[segs.length - 1],
  };
  for (const [place, bone] of Object.entries(def.places)) if (boneIndex.has(bone)) places[place] = boneIndex.get(bone)!;

  // Eyes: on the eye segment's surface, a pair (or a cluster) either side.
  const eyes: Vec[] = [];
  const eyeDef = def.paint.eyes;
  const eyeSeg = segIndex.get(eyeDef.segment || segs[headSeg >= 0 ? headSeg : 0].id);
  if (eyeSeg !== undefined) {
    for (let e = 0; e < eyeDef.count; e++) {
      const at = eyeDef.at + (e % 2) * 0.12 * (e > 1 ? 1 : 0) + Math.floor(e / 2) * 0.1;
      const around = eyeDef.around - Math.floor(e / 2) * 14;
      for (const side of [-1, 1]) {
        const s = surfaceOf(segs[eyeSeg].id, Math.min(1, at), (side * around * Math.PI) / 180);
        if (s) eyes.push(s.point);
      }
    }
  }

  return {
    id: def.id,
    size,
    build,
    bones,
    limbs,
    tubes,
    positions: Float32Array.from(P),
    normals: Float32Array.from(N),
    uvs: Float32Array.from(UV),
    joints: Float32Array.from(J),
    weights: Float32Array.from(W),
    indices: Uint32Array.from(I),
    cards,
    swatches,
    atlasSize,
    parts: chosenParts.map((p) => p.part.id + (p.side < 0 ? "L" : p.side > 0 ? "R" : "")),
    cardGroups: cards.rows.length ? [...new Set(def.cards.filter((c) => cards.rows.some((r) => r.colour === c.colour && r.mask === c.mask)).map((c) => c.id))] : [],
    triangles: I.length / 3 + cards.indices.length / 3,
    height: top,
    length: maxZ - minZ,
    width: maxX * 2,
    places,
    eyes,
    roots,
  };
}

/** A limb bone's twin on the other side (`foreR2` - `foreL2`); any other name as it is. */
function otherSide(name: string): string {
  const match = /^(.*?)([LR])(\d+)$/.exec(name);
  return match ? `${match[1]}${match[2] === "R" ? "L" : "R"}${match[3]}` : name;
}

/** `v` turned by the least rotation that takes direction `from` to `to`. */
function transport(v: Vec, from: Vec, to: Vec): Vec {
  const axis = cross(from, to);
  const sin = length(axis);
  const cos = dot(from, to);
  if (sin < 1e-6) return v;
  const k = scale(axis, 1 / sin);
  // Rodrigues: v cos + (k x v) sin + k (k . v)(1 - cos).
  const out = add(add(scale(v, cos), scale(cross(k, v), sin)), scale(k, dot(k, v) * (1 - cos)));
  return normalize(sub(out, scale(to, dot(out, to))));
}

/** Rects packed in shelves, tallest first, `gap` texels apart; null when they do not fit. */
function packRects(items: { i: number; w: number; h: number }[], size: number, gap: number): AtlasRect[] | null {
  const order = [...items].sort((a, b) => b.h - a.h);
  const out: AtlasRect[] = new Array(items.length);
  let x = gap;
  let y = gap;
  let shelf = 0;
  for (const item of order) {
    if (item.w + 2 * gap > size) return null;
    if (x + item.w + gap > size) {
      x = gap;
      y += shelf + gap;
      shelf = 0;
    }
    if (y + item.h + gap > size) return null;
    out[item.i] = { x, y, w: item.w, h: item.h };
    x += item.w + gap;
    shelf = Math.max(shelf, item.h);
  }
  return out;
}

/** Card groups the individual has, as strips on the surface (BEASTS.md, *Alpha cards*). */
function buildCards(
  def: BeastDef,
  traits: Set<string>,
  rng: () => number,
  surfaceOf: (bone: string, t: number, theta: number) => { point: Vec; normal: Vec; depth: number } | null,
  boneIndex: Map<string, number>,
  bones: BeastBone[],
): BeastCards {
  const P: number[] = [];
  const N: number[] = [];
  const UV: number[] = [];
  const J: number[] = [];
  const W: number[] = [];
  const S: number[] = [];
  const I: number[] = [];
  const rows: BeastCards["rows"] = [];
  const VARIANTS = 4;
  let count = 0;
  for (const group of def.cards) {
    const forced = Object.keys(group.traits).some((t) => traits.has(t));
    const roll = rng();
    if (!forced && roll >= group.chance) continue;
    let grow = 1;
    for (const [t, m] of Object.entries(group.traits)) if (traits.has(t)) grow *= m;
    const matched = bonesMatching(group.bone, bones.map((b) => b.name));
    if (matched.length === 0) continue;
    const firstRow = rows.length;
    for (let v = 0; v < VARIANTS; v++) rows.push({ mask: group.mask, colour: group.colour, variant: v });
    for (const boneName of matched) {
    const boneId = boneIndex.get(boneName)!;
    const bone = bones[boneId];
    const along = normalize(sub(bone.tail, bone.head));
    // Cards lean back along the body: away from the head for the trunk, down a limb for a limb.
    const backward = bone.kind === "limb" ? along : dot(along, [0, 0, 1]) > 0 ? scale(along, -1) : along;
    const sides = group.mirror ? [-1, 1] : [1];
    for (let n = 0; n < group.count; n++) {
      const side = sides[n % sides.length];
      const t = group.from + (group.to - group.from) * rng();
      const theta = ((group.around + (rng() - 0.5) * group.arc) * side * Math.PI) / 180;
      const surface = surfaceOf(boneName, t, theta);
      if (!surface) continue;
      const len = (group.length[0] + (group.length[1] - group.length[0]) * rng()) * grow;
      const wid = group.width[0] + (group.width[1] - group.width[0]) * rng();
      const normal = surface.normal;
      const lean = group.lean;
      let out = normalize(add(scale(normal, 1 - lean), scale(backward, lean)));
      const flat = normalize(cross(out, normal));
      const across = length(flat) > 1e-3 ? flat : normalize(cross(out, [0, 1, 0]));
      const rowIndex = firstRow + Math.floor(rng() * VARIANTS);
      const root = sub(surface.point, scale(normal, 0.01));
      const steps = 3;
      const base = P.length / 3;
      let point = root;
      for (let q = 0; q <= steps; q++) {
        const u = q / steps;
        // Droop pulls the strip down as it goes; curl turns it about its own width.
        if (q > 0) {
          out = normalize(add(add(out, scale([0, -1, 0], group.droop * 0.5)), scale(normal, group.curl * 0.4)));
          point = add(point, scale(out, len / steps));
        }
        const half = (wid / 2) * (1 - u * 0.35);
        for (const s of [-1, 1]) {
          const p = add(point, scale(across, s * half));
          P.push(p[0], p[1], p[2]);
          N.push(normal[0], normal[1], normal[2]);
          // The texture's rows are filled in by the painter: x across the strip, y its row and along it.
          UV.push(0.04 + ((s + 1) / 2) * 0.92, rowIndex + 0.03 + u * 0.94);
          J.push(boneId, 0, 0, 0);
          W.push(1, 0, 0, 0);
          S.push(u);
        }
      }
      for (let q = 0; q < steps; q++) {
        const a = base + q * 2;
        I.push(a, a + 2, a + 3, a, a + 3, a + 1);
      }
      count++;
    }
    }
  }
  // Rows known now: v becomes the share down the card texture.
  for (let k = 1; k < UV.length; k += 2) UV[k] = UV[k] / Math.max(1, rows.length);
  return { positions: Float32Array.from(P), normals: Float32Array.from(N), uvs: Float32Array.from(UV), joints: Float32Array.from(J), weights: Float32Array.from(W), indices: Uint32Array.from(I), sway: Float32Array.from(S), rows, count };
}
