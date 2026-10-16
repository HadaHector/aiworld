import { curveSampler } from "./curve";
import { createLattice, type Lattice } from "./lattice";
import type { BoneShape, RaceDef } from "./raceDef";
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
  /** Triangles, all told and by part. */
  triangles: number;
  parts: Record<string, number>;
}

export interface BodyOptions {
  /** How finely the curves are cut: the race's loops per bone times this. */
  detail?: number;
  /** Apply the race's lattice (default true). */
  lattice?: boolean;
}

interface Ring {
  verts: number[];
  center: Vec;
}

const FORWARD: Vec = [0, 0, 1];
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
  const indices: number[] = [];
  const parts: Record<string, number> = {};
  let part = "";

  const vertex = (p: Vec, home: number, extra: number[] = []): number => {
    points.push(p);
    homes.push(home);
    extras.push(extra);
    return points.length - 1;
  };
  const tri = (a: number, b: number, c: number): void => {
    indices.push(a, b, c);
    parts[part] = (parts[part] ?? 0) + 1;
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
    const frame = frameFor(sub(to, from), reference);
    const [front, back, out, inner] = sampled(shape).map((f) => f(t) + grow);
    // Which of the frame's sides is away from the body's middle.
    const outSign = side === 0 ? 1 : Math.sign(dot(frame.side, [side, 0, 0])) || 1;
    const n = 2 + (1 - shape.round) * 4;
    const center = lerp(from, to, t);
    const list: number[] = [];
    for (let k = 0; k < verts; k++) {
      const theta = (2 * Math.PI * k) / verts;
      const c = Math.cos(theta);
      const sn = Math.sin(theta);
      const x = (c >= 0 ? front : back) * Math.sign(c) * Math.abs(c) ** (2 / n);
      const y = ((sn >= 0) === outSign > 0 ? out : inner) * Math.sign(sn) * Math.abs(sn) ** (2 / n);
      list.push(vertex(add(center, add(scale(frame.front, x), scale(frame.side, y))), home));
    }
    return { verts: list, center };
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
  const iPelvis = skeleton.index("pelvis");
  const iSpine = skeleton.index("spine");
  const iChest = skeleton.index("chest");
  const torso: Ring[] = [];
  const shoulderY = chest.tail[1] - s.shoulderDrop;
  const tM = Math.min(0.9, Math.max(0.3, (shoulderY - chest.head[1]) / (chest.tail[1] - chest.head[1])));
  const tA = Math.max(0.05, 2 * tM - 1);
  for (const t of [0, ...spread(0, 1, loops(race.shape.pelvis))]) torso.push(ring(iPelvis, race.shape.pelvis, pelvis.head, pelvis.tail, t, FORWARD, 0));
  for (const t of [0, ...spread(0, 1, loops(race.shape.spine))]) torso.push(ring(iSpine, race.shape.spine, spine.head, spine.tail, t, FORWARD, 0));
  for (const t of [0, ...spread(0, tA, loops(race.shape.chest))]) torso.push(ring(iChest, race.shape.chest, chest.head, chest.tail, t, FORWARD, 0));
  const armpit = torso.length;
  for (const t of [tA, tM, 1]) torso.push(ring(iChest, race.shape.chest, chest.head, chest.tail, t, FORWARD, 0));
  const N = race.shape.pelvis.verts;
  // Laid out from the front toward +x (frameFor: up × forward), so +x is a quarter of the way round.
  const holeColumn = (side: number): number => (side > 0 ? N / 4 : (3 * N) / 4);
  const skip = new Set<string>();
  for (const side of [1, -1]) {
    const c = holeColumn(side);
    for (const band of [armpit, armpit + 1]) for (const col of [c - 1, c]) skip.add(`${band},${(col + N) % N}`);
  }
  bands(torso, skip);
  const torsoTop = torso[torso.length - 1];

  // --- the legs, each hanging from its half of the hip ring and a crotch vertex ---
  const hipRing = torso[0];
  const thighStart = 0.16;
  const crotch = vertex([0, pelvis.head[1] - s.thigh * thighStart * 0.75, 0], iPelvis, [skeleton.index("thighR"), skeleton.index("thighL")]);
  for (const side of [1, -1]) {
    const suffix = side > 0 ? "R" : "L";
    const iThigh = skeleton.index(`thigh${suffix}`);
    const iShin = skeleton.index(`shin${suffix}`);
    const iFoot = skeleton.index(`foot${suffix}`);
    const thigh = bones[iThigh];
    const shin = bones[iShin];
    part = "legs";
    const half = side > 0 ? hipRing.verts.slice(0, N / 2 + 1) : [...hipRing.verts.slice(N / 2), hipRing.verts[0]];
    const leg: Ring[] = [];
    for (const t of [thighStart, ...spread(thighStart, 1, loops(race.shape.thigh))]) leg.push(ring(iThigh, race.shape.thigh, thigh.head, thigh.tail, t, FORWARD, side));
    for (const t of [0, ...spread(0, 0.85, loops(race.shape.shin)), 0.85]) leg.push(ring(iShin, race.shape.shin, shin.head, shin.tail, t, FORWARD, side));
    const down = sub(thigh.tail, thigh.head);
    zip([...half, crotch], leg[0].verts, down, FORWARD);
    for (let r = 0; r + 1 < leg.length; r++) zip(leg[r].verts, leg[r + 1].verts, down, FORWARD);
    for (const v of leg[leg.length - 1].verts) extras[v] = [iFoot];

    // --- the foot, along its own axis from heel to toe, the ankle plugged into its top ---
    part = "feet";
    const axis = footAxis(race, side);
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
    zip(leg[leg.length - 1].verts, hole, sub(shin.tail, shin.head), FORWARD);
    part = "feet";
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
    const c = holeColumn(side);
    const at = (row: number, col: number): number => torso[armpit + row].verts[(col + N) % N];
    const hole = [at(0, c - 1), at(0, c), at(0, c + 1), at(1, c + 1), at(2, c + 1), at(2, c), at(2, c - 1), at(1, c - 1)];
    for (const v of hole) extras[v] = [iClavicle, iUpper];
    const armStart = 0.2;
    const arm: Ring[] = [];
    for (const t of [armStart, ...spread(armStart, 1, loops(race.shape.upperArm))]) arm.push(ring(iUpper, race.shape.upperArm, upper.head, upper.tail, t, FORWARD, side));
    for (const t of [0, ...spread(0, 1, loops(race.shape.forearm))]) arm.push(ring(iFore, race.shape.forearm, fore.head, fore.tail, t, FORWARD, side));
    const along = sub(upper.tail, upper.head);
    zip(hole, arm[0].verts, along, FORWARD);
    for (let r = 0; r + 1 < arm.length; r++) zip(arm[r].verts, arm[r + 1].verts, along, FORWARD);

    part = "hands";
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
    const thumbShape: BoneShape = { front: [[0, thumbWidth], [1, thumbWidth * 0.8]], back: [[0, thumbWidth], [1, thumbWidth * 0.8]], out: [[0, thumbWidth], [1, thumbWidth * 0.8]], in: [[0, thumbWidth], [1, thumbWidth * 0.8]], round: 0.6, loops: 1, verts: 5 };
    const tip = add(base, scale(thumbDir, thumbLength));
    const t0 = ring(iHand, thumbShape, base, tip, 0, handFrame.side, side);
    const t1 = ring(iHand, thumbShape, base, tip, 0.75, handFrame.side, side);
    zip(t0.verts, t1.verts, thumbDir, handFrame.side);
    cap(t0, add(base, scale(thumbDir, -thumbWidth * 0.5)), iHand, true);
    cap(t1, tip, iHand);
  }

  // --- the neck and head, zipped onto the torso's top ring ---
  part = "head";
  const iNeck = skeleton.index("neck");
  const iHead = skeleton.index("head");
  const neck = bones[iNeck];
  const head = bones[iHead];
  const column: Ring[] = [];
  for (const t of [0.2, ...spread(0.2, 1, loops(race.shape.neck))]) column.push(ring(iNeck, race.shape.neck, neck.head, neck.tail, t, FORWARD, 0));
  for (const t of [0, ...spread(0, 0.94, loops(race.shape.head)), 0.94]) column.push(ring(iHead, race.shape.head, head.head, head.tail, t, FORWARD, 0));
  zip(torsoTop.verts, column[0].verts, UP, FORWARD);
  for (let r = 0; r + 1 < column.length; r++) zip(column[r].verts, column[r + 1].verts, UP, FORWARD);
  cap(column[column.length - 1], head.tail, iHead);

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

  return { positions: points.flat(), indices, joints, weights, bones: finalBones, lattice, triangles: indices.length / 3, parts };
}

function segmentDistance(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / Math.max(1e-9, dot(ab, ab))));
  return length(sub(p, add(a, scale(ab, t))));
}

