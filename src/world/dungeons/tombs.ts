// Tombs standing free in a room (DUNGEONS.md, *What fills it*): where a part's sarcophagi go,
// worked out from its own colliders and walk lines when it is read - on open floor, clear of the
// ways through it, of its walls and of what else stands at its spots - so they are part of its
// colliders like any wall, and the way through is measured past them.

import { vec3, type ShapeDesc, type Vec3 } from "../collision/index";
import type { Polyline } from "./kitShapes";

/** A tomb's size: long, wide, high (to the top of its lid). */
export const TOMB_SIZE: [number, number, number] = [3.4, 1.5, 1.4];

/** Kept this far from a walk line, from anything standing (a wall, a pillar), from a spot, and from each other. */
const CLEAR_OF_WAYS = 3;
const CLEAR_OF_WALLS = 2;
const CLEAR_OF_SPOTS = 2;
const CLEAR_OF_TOMBS = 2.5;

/** A tomb: its floor's middle, and which way its length runs (0: along z, 90: along x). */
export interface TombDef {
  at: Vec3;
  yaw: 0 | 90;
}

type Box = { min: [number, number, number]; max: [number, number, number] };

/**
 * Up to `count` tombs for a part: on a 0.5 m grid over its plan, wherever a tomb's footprint lies on
 * one floor with headroom over it, clear of all the rest - then, of those, the ones farthest from
 * the ways and from each other, so they stand out in the room rather than crowd its edges. Their
 * length along the part's longer side. Only its boxes count (a room is built of them).
 */
export function placeTombs(shapes: readonly ShapeDesc[], paths: readonly Polyline[], spots: Record<string, Vec3[]>, count: number): TombDef[] {
  if (count <= 0) return [];
  const boxes: Box[] = [];
  for (const s of shapes) {
    if (s.kind !== "box" || s.rotation) continue;
    boxes.push({ min: [s.center.x - s.half.x, s.center.y - s.half.y, s.center.z - s.half.z], max: [s.center.x + s.half.x, s.center.y + s.half.y, s.center.z + s.half.z] });
  }
  if (boxes.length === 0) return [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.min[0]); x1 = Math.max(x1, b.max[0]);
    z0 = Math.min(z0, b.min[2]); z1 = Math.max(z1, b.max[2]);
  }
  const yaw: 0 | 90 = x1 - x0 > z1 - z0 ? 90 : 0;
  const [len, wid, high] = TOMB_SIZE;
  const hx = (yaw === 90 ? len : wid) / 2, hz = (yaw === 90 ? wid : len) / 2;
  const inBox = (b: Box, x: number, y: number, z: number) => x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1] && z > b.min[2] && z < b.max[2];
  /** The floor under (x, z) with room over it to stand a tomb, the lowest such. */
  const floorAt = (x: number, z: number): number | null => {
    const tops = boxes.filter((b) => x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2]).map((b) => b.max[1]).sort((p, q) => p - q);
    for (const y of tops) if (!boxes.some((b) => inBox(b, x, y + 0.1, z) || inBox(b, x, y + high + 1, z))) return y;
    return null;
  };
  const ways: [Vec3, Vec3][] = paths.flatMap((line) => line.slice(1).map((q, i): [Vec3, Vec3] => [line[i], q]));
  const toWay = (p: Vec3): number => Math.min(Infinity, ...ways.map(([a, b]) => distanceToSegment(p, a, b)));
  const allSpots = Object.values(spots).flat();
  type Candidate = { at: Vec3; way: number };
  const candidates: Candidate[] = [];
  for (let x = x0 + hx; x <= x1 - hx; x += 0.5) {
    for (let z = z0 + hz; z <= z1 - hz; z += 0.5) {
      const y = floorAt(x, z);
      if (y === null) continue;
      // The whole footprint on that floor, its edges included.
      if (![[x - hx, z - hz], [x + hx, z - hz], [x + hx, z + hz], [x - hx, z + hz]].every(([cx, cz]) => floorAt(cx, cz) === y)) continue;
      // Nothing standing within reach of it, from the floor to over its lid.
      const g = CLEAR_OF_WALLS;
      if (boxes.some((b) => b.max[0] > x - hx - g && b.min[0] < x + hx + g && b.max[2] > z - hz - g && b.min[2] < z + hz + g && b.max[1] > y + 0.05 && b.min[1] < y + high + 0.5)) continue;
      const at = vec3(x, y, z);
      const way = toWay(at) - Math.hypot(hx, hz);
      if (way < CLEAR_OF_WAYS) continue;
      if (allSpots.some((s) => Math.abs(s.y - y) < 4 && Math.hypot(s.x - x, s.z - z) < Math.hypot(hx, hz) + CLEAR_OF_SPOTS)) continue;
      candidates.push({ at, way });
    }
  }
  // The farthest from the ways first, then each next the farthest from the ways and those chosen.
  const chosen: TombDef[] = [];
  while (chosen.length < count) {
    let best: Candidate | null = null, bestScore = -Infinity;
    for (const c of candidates) {
      const apart = Math.min(Infinity, ...chosen.map((t) => Math.hypot(t.at.x - c.at.x, t.at.z - c.at.z)));
      if (apart < 2 * Math.max(hx, hz) + CLEAR_OF_TOMBS) continue;
      const score = Math.min(c.way, apart / 2);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) break;
    chosen.push({ at: best.at, yaw });
  }
  return chosen;
}

/** A tomb's collider: a box from its floor to the top of its lid. */
export function tombShape(t: TombDef): ShapeDesc {
  const [len, wid, high] = TOMB_SIZE;
  const hx = (t.yaw === 90 ? len : wid) / 2, hz = (t.yaw === 90 ? wid : len) / 2;
  return { kind: "box", center: vec3(t.at.x, t.at.y + high / 2, t.at.z), half: vec3(hx, high / 2, hz) };
}

function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const d = [b.x - a.x, b.y - a.y, b.z - a.z];
  const l = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
  const k = Math.max(0, Math.min(1, ((p.x - a.x) * d[0] + (p.y - a.y) * d[1] + (p.z - a.z) * d[2]) / l));
  return Math.hypot(p.x - a.x - d[0] * k, p.y - a.y - d[1] * k, p.z - a.z - d[2] * k);
}
