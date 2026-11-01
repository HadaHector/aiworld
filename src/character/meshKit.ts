import { curveSampler } from "./curve";
import type { BoneShape } from "./raceDef";
import type { GearSurface } from "./gearDef";
import { add, dot, frameFor, length, lerp, normalize, scale, sub, type Vec } from "./skeleton";

/** One material and colour gear is drawn in; `flat` faces keep their edges (a blade's). */
export interface GearLayer extends GearSurface {
  flat: boolean;
  /** Set when its triangles are textured by a piece's own texture (an index into the body's
   *  `pieceTextures`; 0 until the piece is joined to a body) instead of tiling a material. */
  texture?: number;
}

/** A stretch of a piece unrolled into one rectangle of its own texture (CHARACTERS.md, *Pieces and
 *  islands*): round it across, along it down from its top. */
export interface IslandRec {
  name: string;
  /** Which way along the raw `along` the island goes down: +1 increasing, -1 decreasing. */
  down: 1 | -1;
  /** How wide it is round at each `along` (raw, circumference) wherever something is mapped into
   *  it, and the extent of its raw `along`: the width of the panel, which is its outline. */
  samples: [number, number][];
  rawMin: number;
  rawMax: number;
  /** How far round (0-1) the middle of the piece is, and how much of the way round it takes (1 for
   *  a tube cut open, a half for a front or a back): triangles go to the piece they are nearest. */
  centre: number;
  span: number;
  /** Its edges, as the points that make them (round, `along`, circumference there): a top (a
   *  neckline, a sleeve head), a bottom (a hem, a cuff) and joins (an armhole). */
  loops: IslandLoop[];
}

export interface IslandLoop {
  kind: "top" | "bottom" | "join" | "seam";
  /** A ring right round the panel (in order of how far round), or a loop of its own (an armhole:
   *  in the order it is walked, closed). */
  ring: boolean;
  points: { round: number; raw: number; circumference: number }[];
}

/** A stretch of body round one axis - the torso, an arm, a leg - unrolled into one rectangle of
 *  the atlas: round it across, along it down. */
export interface BodyRegion {
  name: string;
  /** Its axis, as a line through joints (moved by the lattice, as the body is). */
  axis: Vec[];
  /** Toward its front, for where round it the atlas starts. */
  reference: Vec;
  /** -1, 0 or 1, as bones' sides: a -x region is unrolled mirrored, so both sides read alike. */
  side: number;
}

export interface Ring {
  verts: number[];
  center: Vec;
}

/**
 * The tools a body is built with, and the geometry as it grows (CHARACTERS.md, *Body from curves*):
 * points, triangles, rings sampled from a bone's curves, zips between rings, caps, and the
 * bookkeeping of which part, atlas region and gear layer the triangles being made belong to. A
 * humanoid (bodyMesh.ts) is one recipe on top of it; a creature's body would be another.
 */
export interface MeshKit {
  points: Vec[];
  /** Per vertex: the bone it belongs to, and further bones its skin weights may follow. */
  homes: number[];
  extras: number[][];
  /** Weights set by hand where the body joins itself, overriding the nearest-bones rule: bone, share. */
  fixed: Map<number, [number, number][]>;
  indices: number[];
  parts: Record<string, number>;
  triangleRegions: number[];
  regionAxes: BodyRegion[];
  /** Gear: the layer triangles are in (-1, the body), and per triangle corner its place in its
   *  material's texture, in metres round and along. */
  layers: GearLayer[];
  triangleLayers: number[];
  gearUVs: number[];
  /** The islands of the piece being built, and per triangle corner the island it is in (-1 for
   *  none), how far round it (0-1, past 1 across the seam) and how far along it (raw metres). */
  islands: IslandRec[];
  cornerIsland: number[];
  cornerRound: number[];
  cornerAlong: number[];
  /** The circumference round the ring each corner is on (0 for a cap's tip, which has none). */
  cornerCircumference: number[];
  /** What the triangles made from now on are: a part to count in, an atlas region, a gear layer,
   *  an island of the piece's texture (-1 for none: the layers' material tiles). */
  part: string;
  region: number;
  layer: number;
  island: number;
  /** From here on rings are mapped into the island of that name, made if new. `down`: which way
   *  its `along` runs toward the bottom. Returns how far down it already reaches, in raw `along`
   *  (the end a continuing part - a skirt under a tunic's body - picks up from). */
  beginIsland: (name: string, down: 1 | -1) => number;
  endIsland: () => void;
  /** Puts a vertex made some other way (a cover's, from the body's own) in the island being built:
   *  how far round it (0-1) and its raw `along` (what a cover measures over its own surface). */
  mapVertex: (vertex: number, round: number, along: number, circumference: number) => void;
  /** From here on cloth is cut into these pieces, each triangle going to the piece it lies in
   *  (nearest its middle round the body): a front and a back cut at the sides, a sleeve cut under the
   *  arm. Vertices are shared across the cuts; each triangle has its own places in its piece. */
  beginPieces: (pieces: { name: string; centre: number; span: number }[], down: 1 | -1) => void;
  /** Where a vertex was mapped: its island (-2 in a piece, whose island is per triangle), how far
   *  round, its `along`, and the circumference there. */
  vertexInfo: (vertex: number) => { round: number; raw: number; circumference: number };
  /** Vertices that are already in their final place (the lattice has been applied to them). */
  placed: Set<number>;
  /** From here on triangles are in a new region round this axis. */
  enter: (name: string, axis: Vec[], reference: Vec, side: number) => void;
  vertex: (p: Vec, home: number, extra?: number[]) => number;
  tri: (a: number, b: number, c: number) => void;
  sampled: (shape: BoneShape) => ((t: number) => number)[];
  /** A ring of `shape` at `t` along the axis from `from` to `to`, its `front` toward `reference`. */
  ring: (home: number, shape: BoneShape, from: Vec, to: Vec, t: number, reference: Vec, side: number, verts?: number, grow?: number) => Ring;
  /** The point of `shape`'s surface at `t` along the axis, `theta` round it from its front. */
  surface: (shape: BoneShape, from: Vec, to: Vec, t: number, theta: number, reference: Vec, side: number, grow?: number) => Vec;
  /** Ring `a` to ring `b` further along `along`: triangles walking both by angle round their own
   *  middles, turning the way every ring is laid out. */
  zip: (a: number[], b: number[], along: Vec, reference: Vec) => void;
  /** A ring between `a` and `b`, with `b`'s count, `k` of the way from one to the other, puffed out. */
  blend: (a: number[], b: number[], along: Vec, reference: Vec, k: number, puff: number, home: number) => number[];
  /** Rings of equal count as quads, leaving out the ones `skip` names (by "band,column"). */
  bands: (rings: Ring[], skip?: Set<string>) => void;
  /** A ring closed with a fan to a point: at the far end of its chain, or (`start`) the near end. */
  cap: (r: Ring, tip: Vec, home: number, start?: boolean) => void;
  layerOf: (surface: GearSurface, flat?: boolean) => number;
  /** Gives a ring's vertices their places in a texture: evenly round its circumference, `along`. */
  mapRing: (r: Ring, along: number) => void;
  /** Gives a vertex a place in the tiling material of its layer: metres across and along. */
  tile: (vertex: number, u: number, w: number) => void;
  /** A fan cap whose tip takes its texture place round from the ring it closes. */
  capRing: (r: Ring, tip: Vec, home: number, along: number, start?: boolean) => void;
  /** Gives every vertex made since `from` the same hand-set weights. */
  fixAll: (from: number, weights: [number, number][]) => void;
}

export function createMeshKit(): MeshKit {
  const points: Vec[] = [];
  const homes: number[] = [];
  const extras: number[][] = [];
  const fixed = new Map<number, [number, number][]>();
  const indices: number[] = [];
  const parts: Record<string, number> = {};
  const triangleRegions: number[] = [];
  const regionAxes: BodyRegion[] = [];
  const layers: GearLayer[] = [];
  const triangleLayers: number[] = [];
  const gearUVs: number[] = [];
  // Per vertex, its place in its material's texture - round (metres), along (metres), and the
  // circumference round which it wraps (0 for a cap's tip, which takes its neighbours').
  const gearU: number[] = [];
  const gearV: number[] = [];
  const gearC: number[] = [];
  const islands: IslandRec[] = [];
  const cornerIsland: number[] = [];
  const cornerRound: number[] = [];
  const cornerAlong: number[] = [];
  const cornerCircumference: number[] = [];
  /** Per vertex: its island (-1 none) and how far round its ring it is (-1 for a cap's tip). */
  const islandOf: number[] = [];
  const roundOf: number[] = [];
  const circOf: number[] = [];
  const samplers = new Map<BoneShape, ((t: number) => number)[]>();

  const kit: MeshKit = {
    points, homes, extras, fixed, indices, parts, triangleRegions, regionAxes, layers, triangleLayers, gearUVs,
    islands, cornerIsland, cornerRound, cornerAlong, cornerCircumference,
    part: "",
    region: 0,
    layer: -1,
    island: -1,
    beginIsland,
    endIsland,
    mapVertex,
    beginPieces,
    vertexInfo,
    placed: new Set<number>(),
    enter, vertex, tri, sampled, ring, surface, zip, blend, bands, cap, layerOf, mapRing, capRing, fixAll, tile,
  };

  /** The islands the pieces being cut go in (kit.island is -2 while it is on). */
  let pieceList: number[] | null = null;

  function beginPieces(pieces: { name: string; centre: number; span: number }[], down: 1 | -1): void {
    pieceList = pieces.map((p) => {
      let at = islands.findIndex((i) => i.name === p.name);
      if (at < 0) {
        islands.push({ name: p.name, down, samples: [], rawMin: Infinity, rawMax: -Infinity, loops: [], centre: p.centre, span: p.span });
        at = islands.length - 1;
      }
      return at;
    });
    kit.island = -2;
  }

  function vertexInfo(v: number): { round: number; raw: number; circumference: number } {
    return { round: roundOf[v], raw: gearV[v], circumference: circOf[v] };
  }

  function beginIsland(name: string, down: 1 | -1): number {
    let at = islands.findIndex((i) => i.name === name);
    if (at < 0) {
      islands.push({ name, down, samples: [], rawMin: Infinity, rawMax: -Infinity, loops: [], centre: 0.5, span: 1 });
      at = islands.length - 1;
    }
    kit.island = at;
    const rec = islands[at];
    return Number.isFinite(rec.rawMin) ? (rec.down > 0 ? rec.rawMax : rec.rawMin) : 0;
  }

  function tile(v: number, u: number, w: number): void {
    gearU[v] = u;
    gearV[v] = w;
  }

  function endIsland(): void {
    kit.island = -1;
    pieceList = null;
  }

  function mapVertex(v: number, round: number, raw: number, circumference: number): void {
    islandOf[v] = kit.island;
    roundOf[v] = round;
    gearV[v] = raw;
    circOf[v] = circumference;
    // In pieces a vertex belongs to whichever its triangle does; they count what they hold.
    if (kit.island < 0) return;
    const rec = islands[kit.island];
    rec.samples.push([raw, circumference]);
    rec.rawMin = Math.min(rec.rawMin, raw);
    rec.rawMax = Math.max(rec.rawMax, raw);
  }

  function enter(name: string, axis: Vec[], reference: Vec, side: number): void {
    regionAxes.push({ name, axis, reference, side });
    kit.region = regionAxes.length - 1;
  }

  function vertex(p: Vec, home: number, extra: number[] = []): number {
    points.push(p);
    homes.push(home);
    extras.push(extra);
    gearU.push(0);
    gearV.push(0);
    gearC.push(0);
    islandOf.push(-1);
    roundOf.push(-1);
    circOf.push(0);
    return points.length - 1;
  }

  function tri(a: number, b: number, c: number): void {
    indices.push(a, b, c);
    parts[kit.part] = (parts[kit.part] ?? 0) + 1;
    triangleRegions.push(kit.region);
    triangleLayers.push(kit.layer);
    if (kit.layer < 0) {
      gearUVs.push(0, 0, 0, 0, 0, 0);
      cornerIsland.push(-1, -1, -1);
      cornerRound.push(0, 0, 0);
      cornerAlong.push(0, 0, 0);
      cornerCircumference.push(0, 0, 0);
      return;
    }
    // In an island, a corner's place is how far round its ring (a triangle across the seam carries
    // its low side past 1) and how far along; tiling material's metres are kept beside it.
    const own = [a, b, c];
    const island = islandOf[a];
    if (island === -2 && pieceList) {
      // Cut in pieces: the piece the triangle lies in - by how far round its middle is - and each
      // corner's place round that piece's own middle, so across a cut is no wrap.
      let sx = 0;
      let sy = 0;
      for (const v of own) {
        sx += Math.cos(roundOf[v] * 2 * Math.PI);
        sy += Math.sin(roundOf[v] * 2 * Math.PI);
      }
      const middle = Math.atan2(sy, sx) / (2 * Math.PI);
      let best = pieceList[0];
      let nearest = Infinity;
      for (const p of pieceList) {
        let d = middle - islands[p].centre;
        d = Math.abs(d - Math.round(d));
        if (d < nearest) {
          nearest = d;
          best = p;
        }
      }
      const rec = islands[best];
      // The triangle's middle, round the piece's, and each corner a little either side of it: a
      // triangle across a cut sits whole on one side, reaching a little past the edge.
      let toMiddle = middle - rec.centre;
      toMiddle -= Math.round(toMiddle);
      own.forEach((v) => {
        let d = roundOf[v] - middle;
        d -= Math.round(d);
        cornerIsland.push(best);
        cornerRound.push(0.5 + toMiddle + d);
        cornerAlong.push(gearV[v]);
        cornerCircumference.push(circOf[v]);
        rec.samples.push([gearV[v], circOf[v] * rec.span]);
        rec.rawMin = Math.min(rec.rawMin, gearV[v]);
        rec.rawMax = Math.max(rec.rawMax, gearV[v]);
      });
    } else if (island >= 0) {
      const real = own.map((v) => roundOf[v] >= 0);
      const rounds = own.map((v) => roundOf[v]);
      const known = rounds.filter((_, k) => real[k]);
      if (known.length > 0 && Math.max(...known) - Math.min(...known) > 0.5) rounds.forEach((r, k) => (rounds[k] = real[k] && r < 0.5 ? r + 1 : r));
      const mean = rounds.filter((_, k) => real[k]).reduce((x, y) => x + y, 0) / Math.max(1, real.filter(Boolean).length);
      const meanCirc = own.filter((_, k) => real[k]).reduce((x, v) => x + circOf[v], 0) / Math.max(1, real.filter(Boolean).length);
      own.forEach((v, k) => {
        cornerIsland.push(island);
        cornerRound.push(real[k] ? rounds[k] : mean);
        cornerAlong.push(gearV[v]);
        cornerCircumference.push(real[k] ? circOf[v] : meanCirc);
      });
    } else {
      cornerIsland.push(-1, -1, -1);
      cornerRound.push(0, 0, 0);
      cornerAlong.push(0, 0, 0);
      cornerCircumference.push(0, 0, 0);
    }
    // Round the seam as the atlas does: a triangle across it carries its low side past the wrap.
    const corners = [a, b, c];
    const wrap = Math.max(...corners.map((v) => gearC[v]));
    const us = corners.map((v) => gearU[v]);
    const real = corners.map((v) => gearC[v] > 0);
    if (wrap > 0) {
      const known = us.filter((_, k) => real[k]);
      if (Math.max(...known) - Math.min(...known) > wrap / 2) us.forEach((u, k) => (us[k] = real[k] && u < wrap / 2 ? u + wrap : u));
      const mean = us.filter((_, k) => real[k]).reduce((x, y) => x + y, 0) / Math.max(1, real.filter(Boolean).length);
      us.forEach((u, k) => (us[k] = real[k] ? u : mean));
    }
    corners.forEach((v, k) => gearUVs.push(us[k], gearV[v]));
  }

  function sampled(shape: BoneShape): ((t: number) => number)[] {
    let found = samplers.get(shape);
    if (!found) {
      found = [curveSampler(shape.front), curveSampler(shape.back), curveSampler(shape.out), curveSampler(shape.in)];
      samplers.set(shape, found);
    }
    return found;
  }

  function ring(home: number, shape: BoneShape, from: Vec, to: Vec, t: number, reference: Vec, side: number, verts = shape.verts, grow = 0): Ring {
    const list: number[] = [];
    for (let k = 0; k < verts; k++) list.push(vertex(surface(shape, from, to, t, (2 * Math.PI * k) / verts, reference, side, grow), home));
    return { verts: list, center: lerp(from, to, t) };
  }

  /** The point of `shape`'s surface at `t` along the axis from `from` to `to`, `theta` round it
   *  from its front (toward the frame's side): its four curves filled between as a superellipse,
   *  then its bumps. */
  function surface(shape: BoneShape, from: Vec, to: Vec, t: number, theta: number, reference: Vec, side: number, grow = 0): Vec {
    const frame = frameFor(sub(to, from), reference);
    const [front, back, out, inner] = sampled(shape).map((f) => f(t) + grow);
    // Which of the frame's sides is away from the body's middle.
    const outSign = side === 0 ? 1 : Math.sign(dot(frame.side, [side, 0, 0])) || 1;
    const n = 2 + (1 - shape.round) * 4;
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    const x = (c >= 0 ? front : back) * Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = ((sn >= 0) === outSign > 0 ? out : inner) * Math.sign(sn) * Math.abs(sn) ** (2 / n);
    let offset = add(scale(frame.front, x), scale(frame.side, y));
    if (shape.bumps.length > 0) {
      // Degrees round from the front toward the outer side; a middle bone's bumps on both sides.
      let toward = ((theta * 180) / Math.PI) * outSign;
      toward = ((toward + 540) % 360) - 180;
      let rise = 0;
      for (const bump of shape.bumps) {
        const along = (t - bump.at) / bump.length;
        const round = (side === 0 ? Math.abs(Math.abs(toward) - Math.abs(bump.angle)) : Math.abs((((toward - bump.angle + 540) % 360) - 180))) / bump.width;
        rise += bump.height * Math.exp(-3 * (along * along + round * round));
      }
      offset = add(offset, scale(normalize(offset), rise));
    }
    return add(lerp(from, to, t), offset);
  }

  function zip(a: number[], b: number[], along: Vec, reference: Vec): void {
    const frame = frameFor(along, reference);
    const angles = (list: number[]): { v: number; u: number }[] => {
      const mid = scale(list.reduce<Vec>((sum, v) => add(sum, points[v]), [0, 0, 0]), 1 / list.length);
      return list
        .map((v) => {
          const d = sub(points[v], mid);
          const u = Math.atan2(dot(d, frame.side), dot(d, frame.front)) / (2 * Math.PI);
          return { v, u: u < 0 ? u + 1 : u };
        })
        .sort((p, q) => p.u - q.u);
    };
    const A = angles(a);
    const B = angles(b);
    const at = (list: { v: number; u: number }[], i: number): { v: number; u: number } => {
      const wrapped = list[i % list.length];
      return { v: wrapped.v, u: wrapped.u + Math.floor(i / list.length) };
    };
    // Both walks start from the vertex nearest angle 0.
    let i = 0;
    let j = 0;
    while (i < A.length || j < B.length) {
      const nextA = at(A, i + 1).u;
      const nextB = at(B, j + 1).u;
      if (j >= B.length || (i < A.length && nextA <= nextB)) {
        tri(at(A, i).v, at(A, i + 1).v, at(B, j).v);
        i++;
      } else {
        tri(at(A, i).v, at(B, j + 1).v, at(B, j).v);
        j++;
      }
    }
  }

  /** Each of `b`'s vertices matched to the point of `a` at its angle, a share `k` of the way from
   *  that point to it, and pushed out from the axis between the two rings' middles by `puff` of
   *  its distance from it. */
  function blend(a: number[], b: number[], along: Vec, reference: Vec, k: number, puff: number, home: number): number[] {
    const frame = frameFor(along, reference);
    const middle = (list: number[]): Vec => scale(list.reduce<Vec>((sum, v) => add(sum, points[v]), [0, 0, 0]), 1 / list.length);
    const ma = middle(a);
    const mb = middle(b);
    const angleOf = (p: Vec, mid: Vec): number => {
      const d = sub(p, mid);
      const u = Math.atan2(dot(d, frame.side), dot(d, frame.front));
      return u < 0 ? u + 2 * Math.PI : u;
    };
    const around = a.map((v) => ({ p: points[v], u: angleOf(points[v], ma) })).sort((p, q) => p.u - q.u);
    const onA = (u: number): Vec => {
      for (let i = 0; i < around.length; i++) {
        const p = around[i];
        const q = around[(i + 1) % around.length];
        const u0 = p.u;
        const u1 = i + 1 < around.length ? q.u : q.u + 2 * Math.PI;
        const uu = u < u0 ? u + 2 * Math.PI : u;
        if (uu >= u0 && uu <= u1) return lerp(p.p, q.p, (uu - u0) / Math.max(1e-9, u1 - u0));
      }
      return around[0].p;
    };
    const axis = lerp(ma, mb, k);
    return b.map((v) => {
      const p = lerp(onA(angleOf(points[v], mb)), points[v], k);
      return vertex(add(p, scale(sub(p, axis), puff)), home);
    });
  }

  function bands(rings: Ring[], skip: Set<string> = new Set()): void {
    for (let r = 0; r + 1 < rings.length; r++) {
      const a = rings[r].verts;
      const b = rings[r + 1].verts;
      const n = a.length;
      for (let k = 0; k < n; k++) {
        if (skip.has(`${r},${k}`)) continue;
        const k1 = (k + 1) % n;
        tri(a[k], a[k1], b[k]);
        tri(a[k1], b[k1], b[k]);
      }
    }
  }

  function cap(r: Ring, tip: Vec, home: number, start = false): void {
    const c = vertex(tip, home);
    const n = r.verts.length;
    for (let k = 0; k < n; k++) {
      const a = r.verts[k];
      const b = r.verts[(k + 1) % n];
      if (start) tri(b, a, c);
      else tri(a, b, c);
    }
  }

  function layerOf(surface: GearSurface, flat = false): number {
    // Inside an island a layer is only a mesh to group triangles in: its texture is the piece's.
    const textured = kit.island !== -1;
    const found = layers.findIndex((l) => l.material === surface.material && l.tint.every((c, k) => c === surface.tint[k]) && l.flat === flat && (l.texture !== undefined) === textured);
    if (found >= 0) return found;
    layers.push(textured ? { material: surface.material, tint: surface.tint, flat, texture: 0 } : { material: surface.material, tint: surface.tint, flat });
    return layers.length - 1;
  }

  function mapRing(r: Ring, along: number): void {
    const n = r.verts.length;
    let circumference = 0;
    for (let k = 0; k < n; k++) circumference += length(sub(points[r.verts[(k + 1) % n]], points[r.verts[k]]));
    r.verts.forEach((v, k) => {
      gearU[v] = (k / n) * circumference;
      gearV[v] = along;
      gearC[v] = circumference;
      if (kit.island >= 0) {
        islandOf[v] = kit.island;
        roundOf[v] = k / n;
      }
    });
    if (kit.island >= 0) {
      const rec = islands[kit.island];
      for (const v of r.verts) circOf[v] = circumference;
      rec.samples.push([along, circumference]);
      rec.rawMin = Math.min(rec.rawMin, along);
      rec.rawMax = Math.max(rec.rawMax, along);
    }
  }

  function capRing(r: Ring, tip: Vec, home: number, along: number, start = false): void {
    const before = points.length;
    cap(r, tip, home, start);
    gearV[before] = along;
    if (kit.island >= 0) {
      islandOf[before] = kit.island;
      const rec = islands[kit.island];
      rec.rawMin = Math.min(rec.rawMin, along);
      rec.rawMax = Math.max(rec.rawMax, along);
    }
  }

  function fixAll(from: number, weights: [number, number][]): void {
    for (let v = from; v < points.length; v++) fixed.set(v, weights);
  }

  return kit;
}

/** A shape the same all along: front, back and both sides at the given distances. */
export function evenShape(front: number, back: number, side: number, round: number, verts: number): BoneShape {
  return { front: [[0, front]], back: [[0, back]], out: [[0, side]], in: [[0, side]], round, loops: 0, verts, bumps: [] };
}

/** Skinning by distance: a point's distance from a bone's segment. */
export function segmentDistance(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / Math.max(1e-9, dot(ab, ab))));
  return length(sub(p, add(a, scale(ab, t))));
}
