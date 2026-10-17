import { curveSampler } from "./curve";
import { createLattice, type Lattice } from "./lattice";
import type { BoneShape, RaceDef } from "./raceDef";
import { sided, type GearDef, type GearPiece, type GearShell, type GearSkirt, type GearSurface } from "./gearDef";
import { add, buildSkeleton, dot, footAxis, frameFor, length, lerp, normalize, scale, sub, type BoneDef, type Vec } from "./skeleton";

/** What a body is drawn from: one indexed mesh in the bind pose, skinned to its bones. */
export interface BodyGeometry {
  positions: number[];
  indices: number[];
  /** Four bones a vertex follows, and how much of each. */
  joints: number[];
  weights: number[];
  /** The bones, moved by the lattice as the body was. */
  bones: BoneDef[];
  /** The lattice the body was shaped by - null if it has none or it was left off. */
  lattice: Lattice | null;
  /** Points the race's bumps mark - a nipple at a pec's peak - for painting. */
  marks: { name: string; position: Vec }[];
  /** Triangles, all told and by part. */
  triangles: number;
  parts: Record<string, number>;
  /** The stretches of body the atlas unrolls as cylinders (see atlas.ts), and which one each
   *  triangle is in. */
  regions: BodyRegion[];
  triangleRegions: number[];
  /** What gear adds: the materials its triangles are drawn in, which one each triangle is (-1 for
   *  the body's own skin, which the atlas paints), and per triangle corner where in its material's
   *  texture, in metres round and along. */
  layers: GearLayer[];
  triangleLayers: number[];
  gearUVs: number[];
}

/** One material and colour gear is drawn in; `flat` faces keep their edges (a blade's). */
export interface GearLayer extends GearSurface {
  flat: boolean;
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

export interface BodyOptions {
  /** How finely the curves are cut: the race's loops per bone times this. */
  detail?: number;
  /** Apply the race's lattice (default true). */
  lattice?: boolean;
  /** Gear worn, its geometry built onto the body (see gearDef.ts). */
  gear?: GearDef[];
  /** The skin's colour, for the race's own pieces (an elf's ears) - the race's first if left out. */
  skin?: [number, number, number];
}

interface Ring {
  verts: number[];
  center: Vec;
}

const FORWARD: Vec = [0, 0, 1];
/** How far up its bone the neck's first ring is: below it, the collar joins it to the shoulders. */
const NECK_START = 0.5;
const UP: Vec = [0, 1, 0];

/**
 * Builds a race's bare body (see CHARACTERS.md, *Body from curves*). Every bone's four profile
 * curves are cut into rings; rings next to each other are zipped with triangles by angle, whatever
 * their counts. Where the body branches, fixed places join the chains:
 *
 * - **the legs** hang from the torso's lowest ring: each takes its half of that ring and one
 *   crotch vertex between them, so a 12-vertex torso gives each leg an 8-vertex port;
 * - **the arms** plug into holes cut in the side of the torso's top three rings (armpit, shoulder
 *   joint, shoulder top), eight vertices round;
 * - **the neck** is zipped onto the torso's top ring;
 * - **the ankles** plug into a hole cut in the top of the foot, and a thumb stands off each hand.
 *
 * Triangles all face out by construction: rings are laid out turning one way round their axis
 * (skeleton.ts, frameFor), and each zip and cap is wound to match.
 */
export function buildBody(race: RaceDef, options: BodyOptions = {}): BodyGeometry {
  const detail = options.detail ?? 1;
  const skeleton = buildSkeleton(race);
  const bones = skeleton.bones;
  const bone = (name: string): BoneDef => bones[skeleton.index(name)];
  const s = race.skeleton;

  const points: Vec[] = [];
  const homes: number[] = [];
  const extras: number[][] = [];
  /** Weights set by hand where the body joins itself, overriding the nearest-bones rule: bone, share. */
  const fixed = new Map<number, [number, number][]>();
  const indices: number[] = [];
  const parts: Record<string, number> = {};
  const triangleRegions: number[] = [];
  const regionAxes: { name: string; axis: Vec[]; reference: Vec; side: number }[] = [];
  let part = "";
  let region = 0;
  // Gear: the layer triangles are in (-1, the body), and per vertex its place in its material's
  // texture - round (metres), along (metres), and the circumference round which it wraps (0 for a
  // cap's tip, which takes its neighbours').
  const layers: GearLayer[] = [];
  const triangleLayers: number[] = [];
  const gearUVs: number[] = [];
  const gearU: number[] = [];
  const gearV: number[] = [];
  const gearC: number[] = [];
  let layer = -1;
  /** From here on triangles are in a new region round this axis. */
  const enter = (name: string, axis: Vec[], reference: Vec, side: number): void => {
    regionAxes.push({ name, axis, reference, side });
    region = regionAxes.length - 1;
  };

  const vertex = (p: Vec, home: number, extra: number[] = []): number => {
    points.push(p);
    homes.push(home);
    extras.push(extra);
    gearU.push(0);
    gearV.push(0);
    gearC.push(0);
    return points.length - 1;
  };
  const tri = (a: number, b: number, c: number): void => {
    indices.push(a, b, c);
    parts[part] = (parts[part] ?? 0) + 1;
    triangleRegions.push(region);
    triangleLayers.push(layer);
    if (layer < 0) {
      gearUVs.push(0, 0, 0, 0, 0, 0);
      return;
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
  };

  const samplers = new Map<BoneShape, ((t: number) => number)[]>();
  const sampled = (shape: BoneShape): ((t: number) => number)[] => {
    let found = samplers.get(shape);
    if (!found) {
      found = [curveSampler(shape.front), curveSampler(shape.back), curveSampler(shape.out), curveSampler(shape.in)];
      samplers.set(shape, found);
    }
    return found;
  };

  /** A ring of `shape` at `t` along the axis from `from` to `to`, its `front` toward `reference`. */
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

  /** Ring `a` to ring `b` further along `along`: triangles walking both by angle round their own
   *  middles, turning the way every ring is laid out. */
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

  /** A ring between `a` and `b` (further along `along`), with `b`'s count: each of `b`'s vertices
   *  matched to the point of `a` at its angle, a share `k` of the way from that point to it, and
   *  pushed out from the axis between the two rings' middles by `puff` of its distance from it. */
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

  /** Rings of equal count as quads, leaving out the ones `skip` names (by "band,column"). */
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

  /** A ring closed with a fan to a point: at the far end of its chain, or (`start`) the near end. */
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

  /** Spread `count` rings over (from, to), not touching either end. */
  const spread = (from: number, to: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + ((to - from) * (i + 1)) / (count + 1));
  const loops = (shape: BoneShape): number => Math.max(0, Math.round(shape.loops * detail));

  // --- the torso: pelvis, spine and chest, one ring count all the way up ---
  part = "torso";
  const pelvis = bone("pelvis");
  const spine = bone("spine");
  const chest = bone("chest");
  enter("torso", [pelvis.head, spine.head, chest.head, chest.tail], FORWARD, 0);
  const torsoRegion = region;
  const iPelvis = skeleton.index("pelvis");
  const iSpine = skeleton.index("spine");
  const iChest = skeleton.index("chest");
  const torso: Ring[] = [];
  const shoulderY = chest.tail[1] - s.shoulderDrop;
  const tM = Math.min(0.9, Math.max(0.3, (shoulderY - chest.head[1]) / (chest.tail[1] - chest.head[1])));
  const tA = Math.min(tM - 0.1, Math.max(0.05, (shoulderY - s.armpit - chest.head[1]) / (chest.tail[1] - chest.head[1])));
  for (const t of [0, ...spread(0, 1, loops(race.shape.pelvis))]) torso.push(ring(iPelvis, race.shape.pelvis, pelvis.head, pelvis.tail, t, FORWARD, 0));
  for (const t of [0, ...spread(0, 1, loops(race.shape.spine))]) torso.push(ring(iSpine, race.shape.spine, spine.head, spine.tail, t, FORWARD, 0));
  // The chest's loops shared out by length between below the armpit and the armpit-to-shoulder
  // stretch the arm hole spans, so the chest has rings where its shape is (and its bumps are).
  const chestLoops = loops(race.shape.chest);
  const besideArm = Math.round((chestLoops * (tM - tA)) / tM);
  for (const t of [0, ...spread(0, tA, chestLoops - besideArm)]) torso.push(ring(iChest, race.shape.chest, chest.head, chest.tail, t, FORWARD, 0));
  const armpit = torso.length;
  for (const t of [tA, ...spread(tA, tM, besideArm), tM, 1]) torso.push(ring(iChest, race.shape.chest, chest.head, chest.tail, t, FORWARD, 0));
  /** The rings the arm hole is cut through, from the armpit to the shoulders' top. */
  const holeRows = besideArm + 3;
  const N = race.shape.pelvis.verts;
  // Laid out from the front toward +x (frameFor: up × forward), so +x is a quarter of the way round.
  const holeColumn = (side: number): number => (side > 0 ? N / 4 : (3 * N) / 4);
  const skip = new Set<string>();
  for (const side of [1, -1]) {
    const c = holeColumn(side);
    for (let band = armpit; band < armpit + holeRows - 1; band++) for (const col of [c - 1, c]) skip.add(`${band},${(col + N) % N}`);
  }
  // The shoulders' top slopes down from the neck to the arms, the joint's ring a little too.
  const slope = (r: Ring, drop: number): void => {
    const widest = Math.max(...r.verts.map((v) => Math.abs(points[v][0])));
    for (const v of r.verts) points[v] = [points[v][0], points[v][1] - drop * (points[v][0] / widest) ** 2, points[v][2]];
  };
  slope(torso[torso.length - 1], s.shoulderDrop * 0.7);
  slope(torso[torso.length - 2], s.shoulderDrop * 0.25);
  // A collar between the shoulders' top and the neck's first ring - halfway in and a little way up,
  // never below the top ring's middle, which would fold the surface - so the neck rises out of a
  // slope (the trapezius) rather than off a shelf.
  const chestTop = sampled(race.shape.chest).map((f) => f(1));
  const neckBase = sampled(race.shape.neck).map((f) => f(NECK_START));
  const toward = (i: number, k: number): number => chestTop[i] + (neckBase[i] - chestTop[i]) * k;
  const collarY = chest.tail[1] + s.neck * NECK_START * 0.45;
  const collar = ring(iChest, evenShape(toward(0, 0.45), toward(1, 0.4), toward(2, 0.58), 0.8, N), [0, collarY, 0], [0, collarY + 1, 0], 0, FORWARD, 0);
  slope(collar, s.shoulderDrop * 0.35);
  for (const v of collar.verts) fixed.set(v, [[iChest, 0.55], [skeleton.index("neck"), 0.45]]);
  torso.push(collar);
  bands(torso, skip);
  const torsoTop = collar;

  // --- the legs, each hanging from its half of the hip ring and a crotch vertex ---
  const hipRing = torso[0];
  // The hip ring dips toward the middle, front and back, so the legs part low - at the crotch -
  // rather than in a V rising to the hips.
  const hipWidest = Math.max(...hipRing.verts.map((v) => Math.abs(points[v][0])));
  for (const v of hipRing.verts) points[v] = [points[v][0], points[v][1] - s.crotch * 0.7 * Math.max(0, 1 - (points[v][0] / hipWidest) ** 2), points[v][2]];
  const thighStart = Math.min(0.5, (s.crotch + 0.025) / s.thigh);
  const crotch = vertex([0, pelvis.head[1] - s.crotch, 0], iPelvis, [skeleton.index("thighR"), skeleton.index("thighL")]);
  for (const side of [1, -1]) {
    const suffix = side > 0 ? "R" : "L";
    const iThigh = skeleton.index(`thigh${suffix}`);
    const iShin = skeleton.index(`shin${suffix}`);
    const iFoot = skeleton.index(`foot${suffix}`);
    const thigh = bones[iThigh];
    const shin = bones[iShin];
    part = "legs";
    enter(`leg${suffix}`, [thigh.head, shin.head, shin.tail], FORWARD, side);
    const half = side > 0 ? hipRing.verts.slice(0, N / 2 + 1) : [...hipRing.verts.slice(N / 2), hipRing.verts[0]];
    const leg: Ring[] = [];
    for (const t of [thighStart, ...spread(thighStart, 1, loops(race.shape.thigh))]) leg.push(ring(iThigh, race.shape.thigh, thigh.head, thigh.tail, t, FORWARD, side));
    for (const t of [0, ...spread(0, 0.85, loops(race.shape.shin)), 0.85]) leg.push(ring(iShin, race.shape.shin, shin.head, shin.tail, t, FORWARD, side));
    const down = sub(thigh.tail, thigh.head);
    zip([...half, crotch], leg[0].verts, down, FORWARD);
    for (let r = 0; r + 1 < leg.length; r++) zip(leg[r].verts, leg[r + 1].verts, down, FORWARD);
    for (const v of leg[leg.length - 1].verts) extras[v] = [iFoot];
    const legRegion = region;

    // --- the foot, along its own axis from heel to toe, the ankle plugged into its top ---
    part = "feet";
    const axis = footAxis(race, side);
    enter(`foot${suffix}`, [axis.from, axis.to], UP, side);
    const footRegion = region;
    const footShape = race.shape.foot;
    const footLength = length(sub(axis.to, axis.from));
    const tAnkle = s.heel / footLength;
    const delta = Math.min(tAnkle * 0.7, 0.14);
    const foot: Ring[] = [];
    const ts = [0.05, ...spread(0.05, tAnkle - delta, Math.max(0, loops(footShape) - 2)), tAnkle - delta, tAnkle, tAnkle + delta, ...spread(tAnkle + delta, 0.95, loops(footShape)), 0.95];
    for (const t of ts) foot.push(ring(iFoot, footShape, axis.from, axis.to, t, UP, side));
    const r = ts.indexOf(tAnkle);
    const F = footShape.verts;
    const footSkip = new Set<string>([`${r - 1},${F - 1}`, `${r - 1},0`, `${r},${F - 1}`, `${r},0`]);
    bands(foot, footSkip);
    const hole = [foot[r - 1].verts[F - 1], foot[r - 1].verts[0], foot[r - 1].verts[1], foot[r].verts[1], foot[r + 1].verts[1], foot[r + 1].verts[0], foot[r + 1].verts[F - 1], foot[r].verts[F - 1]];
    for (const v of hole) extras[v] = [iShin];
    part = "legs";
    region = legRegion;
    zip(leg[leg.length - 1].verts, hole, sub(shin.tail, shin.head), FORWARD);
    part = "feet";
    region = footRegion;
    cap(foot[0], lerp(axis.from, axis.to, 0), iFoot, true);
    cap(foot[foot.length - 1], axis.to, iFoot);
  }

  // --- the arms, plugged into the holes in the torso's side ---
  for (const side of [1, -1]) {
    const suffix = side > 0 ? "R" : "L";
    const iUpper = skeleton.index(`upperArm${suffix}`);
    const iFore = skeleton.index(`forearm${suffix}`);
    const iHand = skeleton.index(`hand${suffix}`);
    const iClavicle = skeleton.index(`clavicle${suffix}`);
    const upper = bones[iUpper];
    const fore = bones[iFore];
    const hand = bones[iHand];
    part = "arms";
    enter(`arm${suffix}`, [upper.head, fore.head, fore.tail], FORWARD, side);
    const c = holeColumn(side);
    const at = (row: number, col: number): number => torso[armpit + row].verts[(col + N) % N];
    // Round the hole: along the armpit's row, up its back column, back along the top, down the front.
    const top = holeRows - 1;
    const rows = Array.from({ length: holeRows - 2 }, (_, i) => i + 1);
    const hole = [at(0, c - 1), at(0, c), at(0, c + 1), ...rows.map((r) => at(r, c + 1)), at(top, c + 1), at(top, c), at(top, c - 1), ...rows.reverse().map((r) => at(r, c - 1))];
    // The shoulder's rings go from the chest to the arm in steps: the hole mostly the chest's, the
    // ring over it shared, the root mostly the arm's - the clavicle in each, so a shrug lifts them all.
    for (const v of hole) fixed.set(v, [[iChest, 0.55], [iClavicle, 0.3], [iUpper, 0.15]]);
    // The arm's first ring level with the armpit, so the hole's bottom row runs straight across to it.
    const along = sub(upper.tail, upper.head);
    // The arm's root: a ring over the joint tilted halfway between the torso's side and the arm, so
    // its outer edge rises toward the shoulder's top, its inner edge drops to the armpit, and the
    // hole - in a wall the arm hangs beside - meets it all round rather than folding into a step.
    // Round that same halfway axis the hole and the root are both true loops, so the zips between
    // them measure their angles round it.
    const bisector = normalize(add(normalize(along), [side, 0, 0]));
    const rootAt = lerp(upper.head, upper.tail, 0.18);
    const root = ring(iUpper, race.shape.upperArm, rootAt, add(rootAt, bisector), 0, FORWARD, side);
    for (const v of root.verts) fixed.set(v, [[iUpper, 0.8], [iClavicle, 0.2]]);
    // Below it the arm proper, from level with the armpit down.
    const armStart = Math.min(0.6, Math.max(0.3, (s.armpit * 0.85) / s.upperArm));
    const arm: Ring[] = [];
    for (const t of [armStart, ...spread(armStart, 1, loops(race.shape.upperArm))]) arm.push(ring(iUpper, race.shape.upperArm, upper.head, upper.tail, t, FORWARD, side));
    for (const t of [0, ...spread(0, 1, loops(race.shape.forearm))]) arm.push(ring(iFore, race.shape.forearm, fore.head, fore.tail, t, FORWARD, side));
    // And between the hole and the root a ring halfway, puffed out, so the shoulder rounds over
    // (the deltoid) rather than turning at a crease.
    const deltoid = blend(hole, root.verts, bisector, FORWARD, 0.5, 0.25, iUpper);
    for (const v of deltoid) fixed.set(v, [[iUpper, 0.5], [iClavicle, 0.35], [iChest, 0.15]]);
    // Unrolled with the torso: on its side, over the joint, the arm's own axis has no angle for them.
    const armRegion = region;
    region = torsoRegion;
    zip(hole, deltoid, bisector, FORWARD);
    zip(deltoid, root.verts, bisector, FORWARD);
    region = armRegion;
    zip(root.verts, arm[0].verts, along, FORWARD);
    for (let r = 0; r + 1 < arm.length; r++) zip(arm[r].verts, arm[r + 1].verts, along, FORWARD);

    part = "hands";
    enter(`hand${suffix}`, [hand.head, hand.tail], FORWARD, side);
    const palm: Ring[] = [arm[arm.length - 1]];
    for (const t of [0.04, ...spread(0.04, 0.92, loops(race.shape.hand)), 0.92]) palm.push(ring(iHand, race.shape.hand, hand.head, hand.tail, t, FORWARD, side));
    for (let r = 0; r + 1 < palm.length; r++) zip(palm[r].verts, palm[r + 1].verts, along, FORWARD);
    cap(palm[palm.length - 1], hand.tail, iHand);

    // A thumb off the hand's front, toward the fingers: a short closed chain of its own.
    const [handFront] = sampled(race.shape.hand).map((f) => f(0.25));
    const handFrame = frameFor(along, FORWARD);
    const base = add(lerp(hand.head, hand.tail, 0.2), scale(handFrame.front, handFront * 0.55));
    const thumbDir = normalize(add(scale(handFrame.along, 0.75), scale(handFrame.front, 0.65)));
    const thumbLength = s.hand * 0.55;
    const thumbWidth = Math.max(0.012, handFront * 0.45);
    const thumbShape: BoneShape = { front: [[0, thumbWidth], [1, thumbWidth * 0.8]], back: [[0, thumbWidth], [1, thumbWidth * 0.8]], out: [[0, thumbWidth], [1, thumbWidth * 0.8]], in: [[0, thumbWidth], [1, thumbWidth * 0.8]], round: 0.6, loops: 1, verts: 5, bumps: [] };
    const tip = add(base, scale(thumbDir, thumbLength));
    const t0 = ring(iHand, thumbShape, base, tip, 0, handFrame.side, side);
    const t1 = ring(iHand, thumbShape, base, tip, 0.75, handFrame.side, side);
    zip(t0.verts, t1.verts, thumbDir, handFrame.side);
    cap(t0, add(base, scale(thumbDir, -thumbWidth * 0.5)), iHand, true);
    cap(t1, tip, iHand);
  }

  // --- the neck and head, zipped onto the torso's top ring ---
  part = "head";
  enter("head", [bone("neck").head, bone("head").head, bone("head").tail], FORWARD, 0);
  const iNeck = skeleton.index("neck");
  const iHead = skeleton.index("head");
  const neck = bones[iNeck];
  const head = bones[iHead];
  const column: Ring[] = [];
  for (const t of [NECK_START, ...spread(NECK_START, 1, loops(race.shape.neck))]) column.push(ring(iNeck, race.shape.neck, neck.head, neck.tail, t, FORWARD, 0));
  for (const t of [0, ...spread(0, 0.94, loops(race.shape.head)), 0.94]) column.push(ring(iHead, race.shape.head, head.head, head.tail, t, FORWARD, 0));
  zip(torsoTop.verts, column[0].verts, UP, FORWARD);
  for (let r = 0; r + 1 < column.length; r++) zip(column[r].verts, column[r + 1].verts, UP, FORWARD);
  cap(column[column.length - 1], head.tail, iHead);

  // --- gear: shells over chains of bones, skirts from the waist, rigid pieces on a bone ---
  /** The stretches gear is placed along: bones whose shapes it follows, end to end. */
  interface Segment {
    bone: number;
    shape: BoneShape;
    from: Vec;
    to: Vec;
    reference: Vec;
    side: number;
    length: number;
  }
  const segment = (name: string): Segment => {
    const i = skeleton.index(name);
    const b = bones[i];
    const [from, to] = b.shape === "foot" ? [footAxis(race, b.side).from, footAxis(race, b.side).to] : [b.head, b.tail];
    return { bone: i, shape: race.shape[b.shape!], from, to, reference: b.shape === "foot" ? UP : FORWARD, side: b.side, length: length(sub(to, from)) };
  };
  const chains: Record<string, () => Segment[]> = {
    torso: () => ["pelvis", "spine", "chest"].map(segment),
    head: () => ["neck", "head"].map(segment),
  };
  for (const suffix of ["R", "L"]) {
    chains[`arm${suffix}`] = () => [`upperArm${suffix}`, `forearm${suffix}`].map(segment);
    chains[`hand${suffix}`] = () => [segment(`hand${suffix}`)];
    chains[`leg${suffix}`] = () => [`thigh${suffix}`, `shin${suffix}`].map(segment);
    chains[`foot${suffix}`] = () => [segment(`foot${suffix}`)];
  }
  /** Where a share `u` of a chain's length falls: which segment, how far along it, and how many
   *  metres from the chain's start. */
  const locate = (chain: Segment[], u: number): { seg: Segment; t: number; along: number } => {
    const total = chain.reduce((sum, seg) => sum + seg.length, 0);
    let at = Math.min(total, Math.max(0, u * total));
    for (const seg of chain) {
      if (at <= seg.length || seg === chain[chain.length - 1]) return { seg, t: at / seg.length, along: u * total };
      at -= seg.length;
    }
    return { seg: chain[0], t: 0, along: 0 };
  };
  const layerOf = (surface: GearSurface, flat = false): number => {
    const found = layers.findIndex((l) => l.material === surface.material && l.tint.every((c, k) => c === surface.tint[k]) && l.flat === flat);
    if (found >= 0) return found;
    layers.push({ material: surface.material, tint: surface.tint, flat });
    return layers.length - 1;
  };
  /** Gives a ring's vertices their places in a texture: evenly round its circumference, `along`. */
  const mapRing = (r: Ring, along: number): void => {
    const n = r.verts.length;
    let circumference = 0;
    for (let k = 0; k < n; k++) circumference += length(sub(points[r.verts[(k + 1) % n]], points[r.verts[k]]));
    r.verts.forEach((v, k) => {
      gearU[v] = (k / n) * circumference;
      gearV[v] = along;
      gearC[v] = circumference;
    });
  };
  /** A fan cap whose tip takes its texture place round from the ring it closes. */
  const capRing = (r: Ring, tip: Vec, home: number, along: number, start = false): void => {
    const before = points.length;
    cap(r, tip, home, start);
    gearV[before] = along;
  };
  const fixAll = (from: number, weights: [number, number][]): void => {
    for (let v = from; v < points.length; v++) fixed.set(v, weights);
  };

  function buildShell(def: GearShell, chainName: string): void {
    const chain = chains[chainName]();
    const n = def.loops + 2;
    const verts = def.verts ?? chain[0].shape.verts;
    const rings: { ring: Ring; along: number; seg: Segment; t: number }[] = [];
    for (let i = 0; i < n; i++) {
      const u = def.from + ((def.to - def.from) * i) / (n - 1);
      const { seg, t, along } = locate(chain, u);
      const k = i / (n - 1);
      const grow = def.thickness + def.flare[0] * (1 - k) ** 3 + def.flare[1] * k ** 3;
      const r = ring(seg.bone, seg.shape, seg.from, seg.to, t, seg.reference, seg.side, verts, grow);
      mapRing(r, along);
      rings.push({ ring: r, along, seg, t });
    }
    const outer = layerOf(def);
    const rim = layerOf({ material: def.material, tint: def.rim });
    const direction = (a: Ring, b: Ring): Vec => (length(sub(b.center, a.center)) > 1e-6 ? sub(b.center, a.center) : sub(rings[0].seg.to, rings[0].seg.from));
    layer = outer;
    for (let i = 0; i + 1 < rings.length; i++) zip(rings[i].ring.verts, rings[i + 1].ring.verts, direction(rings[i].ring, rings[i + 1].ring), rings[i].seg.reference);
    // Its edges: a lip turned in to the body, so the shell shows its thickness.
    const lip = (end: (typeof rings)[number]): Ring => {
      const r = ring(end.seg.bone, end.seg.shape, end.seg.from, end.seg.to, end.t, end.seg.reference, end.seg.side, verts, 0.004);
      mapRing(r, end.along);
      return r;
    };
    const first = rings[0];
    const last = rings[rings.length - 1];
    layer = rim;
    zip(lip(first).verts, first.ring.verts, direction(first.ring, rings[1].ring), first.seg.reference);
    const alongN = direction(rings[rings.length - 2].ring, last.ring);
    if (def.cap) {
      layer = outer;
      capRing(last.ring, add(last.seg.to, scale(normalize(alongN), def.thickness)), last.seg.bone, last.along + def.thickness);
    } else zip(last.ring.verts, lip(last).verts, alongN, last.seg.reference);
    layer = -1;
  }

  function buildSkirt(def: GearSkirt): void {
    const { seg, t } = locate(chains.torso(), def.from);
    const top = ring(seg.bone, seg.shape, seg.from, seg.to, t, seg.reference, seg.side, N, def.thickness);
    mapRing(top, 0);
    const center = lerp(seg.from, seg.to, t);
    const [front, back, side] = sampled(seg.shape).map((f) => f(t) + def.thickness);
    const iThighs = [skeleton.index("thighR"), skeleton.index("thighL")];
    /** A level ring round the hips' middle line, `drop` metres under the skirt's top. */
    const level = (drop: number, f: number, inset: number): Ring => {
      const y = center[1] - drop;
      const r = ring(iPelvis, evenShape(front * f - inset, back * f - inset, side * f - inset, 0.75, N), [0, y, center[2]], [0, y + 1, center[2]], 0, FORWARD, 0);
      for (const v of r.verts) extras[v] = iThighs;
      mapRing(r, drop);
      return r;
    };
    const rings: Ring[] = [top];
    for (let i = 1; i <= def.loops; i++) rings.push(level(def.length * (i / def.loops), 1 + (def.flare - 1) * (i / def.loops), 0));
    const down: Vec = [0, -1, 0];
    layer = layerOf(def);
    for (let i = 0; i + 1 < rings.length; i++) zip(rings[i].verts, rings[i + 1].verts, down, FORWARD);
    // Its hem turned in, and its top tucked to the body.
    layer = layerOf({ material: def.material, tint: def.rim });
    zip(rings[rings.length - 1].verts, level(def.length, def.flare, def.thickness).verts, down, FORWARD);
    const tuck = ring(seg.bone, seg.shape, seg.from, seg.to, t, seg.reference, seg.side, N, 0.004);
    mapRing(tuck, 0);
    zip(top.verts, tuck.verts, [0, 1, 0], FORWARD);
    layer = -1;
  }

  function buildPiece(def: GearPiece, suffix: "R" | "L" | ""): void {
    const mirror = suffix === "L" ? -1 : 1;
    const iBone = skeleton.index(`${def.bone}${suffix}`);
    if (iBone < 0) return;
    const b = bones[iBone];
    const at: Vec = add(b.head, [def.at[0] * mirror, def.at[1], def.at[2]]);
    const side = suffix === "R" ? 1 : suffix === "L" ? -1 : 0;
    const start = points.length;
    if (def.kind === "dome") {
      const axis = normalize([def.axis[0] * mirror, def.axis[1], def.axis[2]]);
      const drop = normalize(sub(b.tail, b.head));
      for (let i = 0; i < def.layers; i++) {
        // Each lame below the last, a little smaller, stepping down the bone.
        const base = add(add(at, scale(drop, i * def.height * 0.75)), scale(axis, -i * 0.012));
        const radius = def.radius * (1 - 0.1 * i);
        const profile: [number, number][] = [[0, 1], [0.45, 0.88], [0.8, 0.55]];
        const rings = profile.map(([h, f]) => {
          const c = add(base, scale(axis, def.height * h));
          const r = ring(iBone, evenShape(radius * f, radius * f, radius * f, 0.85, 12), c, add(c, axis), 0, FORWARD, side);
          mapRing(r, def.height * h);
          return r;
        });
        layer = layerOf(def);
        for (let k = 0; k + 1 < rings.length; k++) zip(rings[k].verts, rings[k + 1].verts, axis, FORWARD);
        capRing(rings[rings.length - 1], add(base, scale(axis, def.height)), iBone, def.height);
        // Its underside: a rolled rim, showing the plate's thickness.
        layer = layerOf({ material: def.material, tint: def.rim });
        const under = add(base, scale(axis, -0.012));
        const lip = ring(iBone, evenShape(radius * 0.93, radius * 0.93, radius * 0.93, 0.85, 12), under, add(under, axis), 0, FORWARD, side);
        mapRing(lip, -0.012);
        zip(lip.verts, rings[0].verts, axis, FORWARD);
      }
      const clavicle = skeleton.index(`clavicle${suffix}`);
      fixAll(start, def.bone === "upperArm" && clavicle >= 0 ? [[iBone, 0.65], [clavicle, 0.35]] : [[iBone, 1]]);
    } else {
      // A sword held in the fist: its blade out past the thumb, leaning toward the fingers.
      const along = normalize(sub(b.tail, b.head));
      const frame = frameFor(along, FORWARD);
      const dir = normalize(add(scale(frame.front, 0.85), scale(along, 0.5)));
      const grip = lerp(b.head, b.tail, 0.5);
      const tube = (from: Vec, to: Vec, front: number, sideWidth: number, verts: number, round: number): Ring[] => {
        const shape = evenShape(front, front, sideWidth, round, verts);
        return [0, 1].map((t) => {
          const r = ring(iBone, shape, from, to, t, along, side, verts);
          mapRing(r, t * length(sub(to, from)));
          return r;
        });
      };
      const closed = (rings: Ring[], from: Vec, to: Vec, tipFrom: Vec, tipTo: Vec): void => {
        zip(rings[0].verts, rings[1].verts, sub(to, from), along);
        capRing(rings[0], tipFrom, iBone, 0, true);
        capRing(rings[1], tipTo, iBone, length(sub(to, from)));
      };
      layer = layerOf(def.hilt);
      const gripFrom = add(grip, scale(dir, -0.075));
      const gripTo = add(grip, scale(dir, 0.06));
      closed(tube(gripFrom, gripTo, 0.017, 0.017, 6, 0.9), gripFrom, gripTo, add(gripFrom, scale(dir, -0.025)), gripTo);
      const guardTo = add(gripTo, scale(dir, 0.025));
      layer = layerOf(def.hilt, true);
      closed(tube(gripTo, guardTo, def.width * 1.8, 0.016, 4, 0), gripTo, guardTo, gripTo, guardTo);
      layer = layerOf(def, true);
      const bladeTo = add(guardTo, scale(dir, def.length * 0.88));
      const blade = tube(guardTo, bladeTo, def.width / 2, 0.008, 4, 1);
      zip(blade[0].verts, blade[1].verts, dir, along);
      capRing(blade[0], guardTo, iBone, 0, true);
      capRing(blade[1], add(guardTo, scale(dir, def.length)), iBone, def.length);
      fixAll(start, [[iBone, 1]]);
    }
    layer = -1;
  }

  region = -1;
  // The race's own pieces: tapering spikes in the skin's colour (an elf's ears).
  part = "head";
  for (const piece of race.pieces) {
    for (const suffix of piece.sides) {
      // A bone in the middle (the head) carries both sides' pieces itself.
      const iBone = skeleton.index(`${piece.bone}${suffix}`) >= 0 ? skeleton.index(`${piece.bone}${suffix}`) : skeleton.index(piece.bone);
      if (iBone < 0) continue;
      const mirror = suffix === "L" ? -1 : 1;
      const side = suffix === "R" ? 1 : suffix === "L" ? -1 : 0;
      const root = add(bones[iBone].head, [piece.at[0] * mirror, piece.at[1], piece.at[2]]);
      const axis = normalize([piece.axis[0] * mirror, piece.axis[1], piece.axis[2]]);
      const tip = add(root, scale(axis, piece.length));
      const start = points.length;
      layer = layerOf({ material: "skin", tint: options.skin ?? race.look.skin[0] });
      const rings = ([[0, 1], [0.45, 0.65], [0.8, 0.3]] as [number, number][]).map(([t, f]) => {
        const r = piece.radius * f;
        const made = ring(iBone, evenShape(r * piece.flat, r * piece.flat, r, 0.7, 6), root, tip, t, FORWARD, side);
        mapRing(made, t * piece.length);
        return made;
      });
      for (let k = 0; k + 1 < rings.length; k++) zip(rings[k].verts, rings[k + 1].verts, axis, FORWARD);
      capRing(rings[0], root, iBone, 0, true);
      capRing(rings[rings.length - 1], tip, iBone, piece.length);
      fixAll(start, [[iBone, 1]]);
    }
  }
  layer = -1;
  part = "gear";
  for (const piece of options.gear ?? []) {
    for (const def of piece.shells) for (const chainName of sided(def.chain)) buildShell(def, chainName);
    for (const def of piece.skirts) buildSkirt(def);
    for (const def of piece.pieces) for (const suffix of def.sides) buildPiece(def, suffix);
  }

  // --- the points bumps mark, at their peaks ---
  const marks: { name: string; position: Vec }[] = [];
  for (const b of bones) {
    if (!b.shape) continue;
    const shape = race.shape[b.shape];
    const [from, to] = b.shape === "foot" ? [footAxis(race, b.side).from, footAxis(race, b.side).to] : [b.head, b.tail];
    const reference = b.shape === "foot" ? UP : FORWARD;
    const outSign = b.side === 0 ? 1 : Math.sign(dot(frameFor(sub(to, from), reference).side, [b.side, 0, 0])) || 1;
    for (const bump of shape.bumps) {
      if (!bump.mark) continue;
      for (const sign of b.side === 0 && bump.angle !== 0 ? [1, -1] : [1]) {
        const theta = ((sign * bump.angle * Math.PI) / 180) * outSign;
        marks.push({ name: bump.mark, position: surface(shape, from, to, bump.at, theta, reference, b.side) });
      }
    }
  }

  // --- the lattice, over the body and its joints alike ---
  let lattice: Lattice | null = null;
  let finalBones = bones;
  if (race.lattice && options.lattice !== false) {
    const min: Vec = [Infinity, Infinity, Infinity];
    const max: Vec = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p[a]);
      max[a] = Math.max(max[a], p[a]);
    }
    const pad = 0.02;
    lattice = createLattice(race.lattice, sub(min, [pad, pad, pad]), add(max, [pad, pad, pad]));
    const l = lattice;
    for (let i = 0; i < points.length; i++) points[i] = l.apply(points[i]);
    finalBones = bones.map((b) => ({ ...b, head: l.apply(b.head), tail: l.apply(b.tail) }));
    for (const r of regionAxes) r.axis = r.axis.map((p) => l.apply(p));
    for (const m of marks) m.position = l.apply(m.position);
  }

  // --- skinning: each vertex follows the nearest of its own bone and the bones next to it ---
  const neighbours = finalBones.map((_, i) => {
    const near = new Set<number>([i]);
    const parent = finalBones[i].parent;
    if (parent > 0) near.add(parent);
    finalBones.forEach((b, j) => {
      if (b.parent === i) near.add(j);
    });
    return near;
  });
  const joints: number[] = [];
  const weights: number[] = [];
  for (let v = 0; v < points.length; v++) {
    const set = fixed.get(v);
    if (set) {
      for (let k = 0; k < 4; k++) {
        joints.push(set[k]?.[0] ?? 0);
        weights.push(set[k]?.[1] ?? 0);
      }
      continue;
    }
    const candidates = new Set([...neighbours[homes[v]], ...extras[v]]);
    const scored = [...candidates]
      .filter((b) => b > 0)
      .map((b) => {
        const d = segmentDistance(points[v], finalBones[b].head, finalBones[b].tail);
        return { b, w: (b === homes[v] ? 1.5 : 1) / (d ** 4 + 1e-7) };
      })
      .sort((p, q) => q.w - p.w)
      .slice(0, 4);
    const total = scored.reduce((sum, e) => sum + e.w, 0);
    for (let k = 0; k < 4; k++) {
      joints.push(scored[k]?.b ?? 0);
      weights.push(scored[k] ? scored[k].w / total : 0);
    }
  }

  return { positions: points.flat(), indices, joints, weights, bones: finalBones, lattice, marks, triangles: indices.length / 3, parts, regions: regionAxes, triangleRegions, layers, triangleLayers, gearUVs };
}

/** A shape the same all along: front, back and both sides at the given distances. */
function evenShape(front: number, back: number, side: number, round: number, verts: number): BoneShape {
  return { front: [[0, front]], back: [[0, back]], out: [[0, side]], in: [[0, side]], round, loops: 0, verts, bumps: [] };
}

function segmentDistance(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / Math.max(1e-9, dot(ab, ab))));
  return length(sub(p, add(a, scale(ab, t))));
}

