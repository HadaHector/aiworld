import { createNoise3D } from "simplex-noise";
import { mulberry32 } from "../rng";
import type { BoulderShape } from "./foliageConfig";
import type { TreeDetail } from "./treeGenerator";

/** One boulder, in its own space: centred on the origin across, its base sunk below y = 0. */
export interface BoulderGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** How finely the sphere a boulder starts from is cut: 1280 triangles close up, 320 far away. */
const SUBDIVISIONS: Record<TreeDetail, number> = { near: 3, far: 2 };

/** An icosahedron's corners and faces, each face then split into four `levels` times, the new
 *  corners pushed out onto the unit sphere. Shared corners are shared, so the surface is closed. */
function icosphere(levels: number): { directions: number[]; faces: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const directions: number[] = [];
  const add = (x: number, y: number, z: number): number => {
    const length = Math.hypot(x, y, z);
    directions.push(x / length, y / length, z / length);
    return directions.length / 3 - 1;
  };
  for (const [x, y, z] of [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ]) add(x, y, z);
  let faces = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  for (let level = 0; level < levels; level++) {
    const midpoints = new Map<number, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 100000 + b : b * 100000 + a;
      let index = midpoints.get(key);
      if (index === undefined) {
        index = add(directions[a * 3] + directions[b * 3], directions[a * 3 + 1] + directions[b * 3 + 1], directions[a * 3 + 2] + directions[b * 3 + 2]);
        midpoints.set(key, index);
      }
      return index;
    };
    const next: number[] = [];
    for (let f = 0; f < faces.length; f += 3) {
      const [a, b, c] = [faces[f], faces[f + 1], faces[f + 2]];
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }
  return { directions, faces };
}

/** A random direction, even over the sphere. */
function randomDirection(random: () => number): [number, number, number] {
  const y = random() * 2 - 1;
  const angle = random() * Math.PI * 2;
  const across = Math.sqrt(1 - y * y);
  return [across * Math.cos(angle), y, across * Math.sin(angle)];
}

/**
 * One boulder of a kind, the same for the same seed at either level of detail: everything about its
 * shape is drawn from the seed and read off at each corner's direction, so the far model is the near
 * one with fewer corners, not a different stone.
 *
 * A unit sphere, swollen and dented by a slow noise over its surface; then flat faces sheared off -
 * every corner beyond a plane pulled back onto it - which is what makes it read as split, weathered
 * stone rather than a potato; then squashed to its height, stretched along its length, sized, tipped
 * off upright and sunk.
 */
export function generateBoulder(shape: BoulderShape, seed: number, detail: TreeDetail): BoulderGeometry {
  const random = mulberry32(seed);
  const noise = createNoise3D(random);
  const between = ([low, high]: [number, number]): number => low + random() * (high - low);
  const squash = between(shape.squash);
  const stretch = between(shape.stretch);
  // Faces cut from above and the sides: one underneath would be in the ground anyway.
  const cuts = Array.from({ length: Math.round(between(shape.facets)) }, () => {
    const [x, y, z] = randomDirection(random);
    const normal = [x, Math.abs(y) * 0.8 + 0.1, z];
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    return { normal: normal.map((v) => v / length), at: 1 - shape.facetDepth * (0.35 + 0.65 * random()) };
  });
  const tiltAxis = random() * Math.PI * 2;
  const tilt = ((random() * shape.tilt) / 180) * Math.PI;
  const offset = [random() * 100, random() * 100, random() * 100];

  const { directions, faces } = icosphere(SUBDIVISIONS[detail]);
  const count = directions.length / 3;
  const positions = new Float32Array(count * 3);
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  const axisX = Math.cos(tiltAxis);
  const axisZ = Math.sin(tiltAxis);
  for (let i = 0; i < count; i++) {
    const dx = directions[i * 3];
    const dy = directions[i * 3 + 1];
    const dz = directions[i * 3 + 2];
    // Two octaves: the slow swell of the whole stone, and knobs on it.
    const swell = noise(dx * 1.1 + offset[0], dy * 1.1 + offset[1], dz * 1.1 + offset[2]) + 0.4 * noise(dx * 2.7 + offset[1], dy * 2.7 + offset[2], dz * 2.7 + offset[0]);
    const r = 1 + (shape.lumps * swell) / 1.4;
    let x = dx * r;
    let y = dy * r;
    let z = dz * r;
    // Twice over, so a corner pulled onto one face and past another ends up inside both.
    for (let pass = 0; pass < 2; pass++) {
      for (const { normal, at } of cuts) {
        const beyond = x * normal[0] + y * normal[1] + z * normal[2] - at;
        if (beyond <= 0) continue;
        x -= beyond * normal[0];
        y -= beyond * normal[1];
        z -= beyond * normal[2];
      }
    }
    x *= shape.radius * stretch;
    y *= shape.radius * squash;
    z *= shape.radius;
    // Tipped about a level axis (axisX, 0, axisZ) - Rodrigues' rotation, the axis having no y.
    const along = x * axisX + z * axisZ;
    const crossX = -y * axisZ;
    const crossY = z * axisX - x * axisZ;
    const crossZ = y * axisX;
    positions[i * 3] = x * cosTilt + crossX * sinTilt + axisX * along * (1 - cosTilt);
    positions[i * 3 + 1] = y * cosTilt + crossY * sinTilt;
    positions[i * 3 + 2] = z * cosTilt + crossZ * sinTilt + axisZ * along * (1 - cosTilt);
  }

  // Stood on the ground with `sink` of its height below it.
  let bottom = Infinity;
  let top = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    bottom = Math.min(bottom, positions[i]);
    top = Math.max(top, positions[i]);
  }
  const lift = -bottom - shape.sink * (top - bottom);
  for (let i = 1; i < positions.length; i += 3) positions[i] += lift;

  // Smooth normals, each corner's the area-weighted sum of its faces': the sheared faces come out
  // flat in the middle and rounded over at their edges, like worn stone.
  const normals = new Float32Array(count * 3);
  for (let f = 0; f < faces.length; f += 3) {
    const [a, b, c] = [faces[f] * 3, faces[f + 1] * 3, faces[f + 2] * 3];
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const corner of [a, b, c]) {
      normals[corner] += nx;
      normals[corner + 1] += ny;
      normals[corner + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= length;
    normals[i + 1] /= length;
    normals[i + 2] /= length;
  }
  // The faces are wound counter-clockwise seen from outside; Babylon's front faces are clockwise.
  const indices = new Uint32Array(faces.length);
  for (let f = 0; f < faces.length; f += 3) {
    indices[f] = faces[f];
    indices[f + 1] = faces[f + 2];
    indices[f + 2] = faces[f + 1];
  }
  return { positions, normals, indices };
}
