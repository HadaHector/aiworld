// The way through, measured (DUNGEONS.md, *Scale*): along a part's walk lines, a floor underfoot
// and no less than the rules' minimum width and height - by rays against the colliders themselves.
import { createCollisionWorld, vec3, type CollisionWorld, type ShapeDesc, type Vec3 } from "../collision/index";
import type { Polyline } from "./kitShapes";

/** How far apart the walk lines are measured. */
const STEP = 1.5;
/** Leeway on the minimum, for rounding in the colliders. */
const SLACK = 0.02;

export interface ClearanceSample {
  at: Vec3;
  width: number;
  height: number;
  floor: boolean;
}

/** Width and height at a point on the floor, the way through going along `along` (horizontal). */
export function measureAt(world: CollisionWorld, at: Vec3, along: Vec3): ClearanceSample {
  const down = world.raycast(vec3(at.x, at.y + 1, at.z), vec3(0, -1, 0), 1.6);
  const floorY = down ? at.y + 1 - down.distance : at.y;
  const floor = down !== null && Math.abs(floorY - at.y) < 0.35;
  const up = world.raycast(vec3(at.x, floorY + 0.1, at.z), vec3(0, 1, 0), 60);
  const height = up ? up.distance + 0.1 : Infinity;
  const l = Math.hypot(along.x, along.z) || 1;
  const across = vec3(along.z / l, 0, -along.x / l);
  let width = Infinity;
  for (let y = 1; y < Math.min(height, 6) - 0.5; y += 2) {
    const from = vec3(at.x, floorY + y, at.z);
    const right = world.raycast(from, across, 60);
    const left = world.raycast(from, vec3(-across.x, 0, -across.z), 60);
    width = Math.min(width, (right ? right.distance : Infinity) + (left ? left.distance : Infinity));
  }
  return { at, width, height, floor };
}

/** Points every STEP along a line, each with its way, kept clear of the line's very ends. */
export function samplePath(line: Polyline): { at: Vec3; along: Vec3 }[] {
  const out: { at: Vec3; along: Vec3 }[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    const d = vec3(b.x - a.x, b.y - a.y, b.z - a.z);
    const length = Math.hypot(d.x, d.z);
    if (length < 1e-6) continue;
    const n = Math.max(1, Math.ceil(length / STEP));
    for (let k = 0; k <= n; k++) {
      // Half a metre back from an end: the opening itself is measured as a socket, facing its way.
      const t = Math.min(1 - 0.5 / length, Math.max(0.5 / length, k / n));
      // Kept off the very ends of the whole line only - inner joints are measured as they are.
      if ((i > 0 && k === 0)) continue;
      out.push({ at: vec3(a.x + d.x * t, a.y + d.y * t, a.z + d.z * t), along: d });
    }
  }
  return out;
}

/**
 * What is wrong with the way through a set of colliders along their walk lines, and at their
 * sockets: no floor, or under the minimum. Empty when it is all clear.
 */
export function checkPaths(shapes: readonly ShapeDesc[], paths: readonly Polyline[], minClear: [number, number], sockets: readonly { at: Vec3; facing: number }[] = [], world?: CollisionWorld): string[] {
  const w = world ?? createCollisionWorld();
  if (!world) w.addBatch(shapes);
  const problems: string[] = [];
  const say = (where: string, s: ClearanceSample): void => {
    const p = `(${s.at.x.toFixed(1)}, ${s.at.y.toFixed(1)}, ${s.at.z.toFixed(1)})`;
    if (!s.floor) problems.push(`${where} ${p}: no floor underfoot`);
    else if (s.width < minClear[0] - SLACK) problems.push(`${where} ${p}: only ${s.width.toFixed(2)} m wide, under ${minClear[0]}`);
    else if (s.height < minClear[1] - SLACK) problems.push(`${where} ${p}: only ${s.height.toFixed(2)} m high, under ${minClear[1]}`);
  };
  paths.forEach((line, i) => {
    for (const { at, along } of samplePath(line)) say(`walk line ${i}`, measureAt(w, at, along));
  });
  sockets.forEach((socket, i) => {
    // Half a metre in from the opening.
    const f = (socket.facing * Math.PI) / 180;
    const dir = vec3(Math.sin(f), 0, Math.cos(f));
    say(`socket ${i}`, measureAt(w, vec3(socket.at.x - dir.x * 0.5, socket.at.y, socket.at.z - dir.z * 0.5), dir));
  });
  // One problem a line is enough to find it.
  return [...new Set(problems.map((p) => p.replace(/ \(.*?\):/, ":")))].map((key) => problems.find((p) => p.replace(/ \(.*?\):/, ":") === key)!);
}
