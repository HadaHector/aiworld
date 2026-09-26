import { mulberry32 } from "../rng";
import { lerp, smoothstep } from "../mathUtils";
import type { BranchingTree, BushShape } from "./foliageConfig";

/**
 * One generated tree, in tree space (the base of the trunk at the origin, up +Y), as two meshes'
 * worth of plain arrays: the wood - trunk, roots, branches and twigs - and the leaf cards.
 */
export interface TreeGeometry {
  wood: {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    /** Per vertex, the direction the limb runs - the bark texture's "up", for its normal map. */
    axes: Float32Array;
    indices: Uint32Array;
  };
  leaves: {
    positions: Float32Array;
    /** Not the cards' own facing but out from the crown's centre, so the crown shades as one soft
     *  mass instead of a pile of flat cards. */
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
  };
  /** Top of the foliage, for bounding boxes. */
  height: number;
}

type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};
/** Any unit vector at right angles to `v`. */
const perpendicular = (v: V3): V3 => normalize(cross(v, Math.abs(v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
/** `v` turned by `angle` about the unit `axis` (Rodrigues). */
const rotate = (v: V3, axis: V3, angle: number): V3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
};

const DEG = Math.PI / 180;

class WoodBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  axes: number[] = [];
  indices: number[] = [];

  /**
   * A tapered tube along a centreline, `sides` around, closed at its far end by a single apex vertex.
   * Its rings are oriented by parallel transport - each ring's frame is the previous one turned just
   * enough to stay square to the line - so a curving limb does not twist. The bark tiles a whole
   * number of times around (so the seam matches) and at its true scale along.
   */
  tube(points: V3[], radii: number[], sides: number, tile: number): void {
    const base = this.positions.length / 3;
    const ring = sides + 1;
    // Sized on the limb's average girth: its first ring can be a flared base twice the width of
    // the rest, which would squeeze the bark sideways everywhere else.
    const meanRadius = radii.reduce((sum, r) => sum + r, 0) / radii.length;
    const around = Math.max(1, Math.round((2 * Math.PI * meanRadius) / tile));
    let normal: V3 = perpendicular(normalize(sub(points[1], points[0])));
    let v = 0;

    for (let i = 0; i < points.length; i++) {
      const tangent = normalize(i === 0 ? sub(points[1], points[0]) : i === points.length - 1 ? sub(points[i], points[i - 1]) : sub(points[i + 1], points[i - 1]));
      normal = normalize(sub(normal, scale(tangent, dot(normal, tangent))));
      const binormal = cross(tangent, normal);
      if (i > 0) v += Math.hypot(...sub(points[i], points[i - 1])) / tile;
      for (let j = 0; j <= sides; j++) {
        const angle = (j / sides) * Math.PI * 2;
        const out = add(scale(normal, Math.cos(angle)), scale(binormal, Math.sin(angle)));
        const p = add(points[i], scale(out, radii[i]));
        this.positions.push(p[0], p[1], p[2]);
        this.normals.push(out[0], out[1], out[2]);
        this.uvs.push((j / sides) * around, v);
        this.axes.push(tangent[0], tangent[1], tangent[2]);
      }
      if (i > 0) {
        const a0 = base + (i - 1) * ring;
        const b0 = base + i * ring;
        for (let j = 0; j < sides; j++) {
          this.indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
        }
      }
    }

    // The apex: a short cone off the last ring, rather than an open end.
    const last = points.length - 1;
    const tipDirection = normalize(sub(points[last], points[last - 1]));
    const apex = add(points[last], scale(tipDirection, radii[last] * 2));
    const apexIndex = this.positions.length / 3;
    this.positions.push(apex[0], apex[1], apex[2]);
    this.normals.push(tipDirection[0], tipDirection[1], tipDirection[2]);
    this.uvs.push(around * 0.5, v + (radii[last] * 2) / tile);
    this.axes.push(tipDirection[0], tipDirection[1], tipDirection[2]);
    const lastRing = base + last * ring;
    for (let j = 0; j < sides; j++) this.indices.push(lastRing + j, lastRing + j + 1, apexIndex);
  }
}

class LeafBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];

  /** One card: a square `size` across in the plane of `u` and `v`, showing atlas cell `cell` - the
   *  right way up along `v` with `upright`, where a cell's picture has a bottom (a bush's twigs). */
  card(centre: V3, u: V3, v: V3, size: number, cell: number, crownCentre: V3, crownRadius: number, upright = false): void {
    const base = this.positions.length / 3;
    const half = size / 2;
    const cellU = (cell % 2) * 0.5;
    const cellV = Math.floor(cell / 2) * 0.5;
    const inset = 0.004;
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const [a, b] of corners) {
      const p = add(centre, add(scale(u, a * half), scale(v, b * half)));
      this.positions.push(p[0], p[1], p[2]);
      // Out from the crown's centre - flattened a little vertically, since a crown is wider than
      // it is tall - with the card's height in the crown tilting it up or down.
      const out = sub(p, crownCentre);
      const n = normalize([out[0], out[1] * 1.3 + crownRadius * 0.15, out[2]]);
      this.normals.push(n[0], n[1], n[2]);
      // An atlas row runs down the picture, so the card's top (+v) is the cell's first row.
      const up = upright ? -b : b;
      this.uvs.push(cellU + (a > 0 ? 0.5 - inset : inset), cellV + (up > 0 ? 0.5 - inset : inset));
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * An upright card `width` by `height` standing on `foot`, spanning `u` horizontally and showing
   * atlas cell `cell` the right way up (mirrored left to right with `mirror`). A 3x3 grid rather
   * than a quad, because its normals are the crown's (see `card`) and a card through the middle of
   * a bush has them pointing opposite ways at its two edges - with only corners to interpolate
   * between, its middle would be lit as a flat diagonal crease.
   */
  panel(foot: V3, u: V3, width: number, height: number, cell: number, mirror: boolean, crownCentre: V3, crownRadius: number): void {
    const base = this.positions.length / 3;
    const cellU = (cell % 2) * 0.5;
    const cellV = Math.floor(cell / 2) * 0.5;
    const inset = 0.004;
    const span = 0.5 - inset * 2;
    for (let row = 0; row <= 2; row++) {
      for (let col = 0; col <= 2; col++) {
        const p = add(foot, add(scale(u, (col / 2 - 0.5) * width), [0, (row / 2) * height, 0]));
        this.positions.push(p[0], p[1], p[2]);
        const out = sub(p, crownCentre);
        const n = normalize([out[0], out[1] * 1.3 + crownRadius * 0.15, out[2]]);
        this.normals.push(n[0], n[1], n[2]);
        const across = mirror ? 1 - col / 2 : col / 2;
        this.uvs.push(cellU + inset + across * span, cellV + 0.5 - inset - (row / 2) * span);
      }
    }
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const a = base + row * 3 + col;
        this.indices.push(a, a + 1, a + 4, a, a + 4, a + 3);
      }
    }
  }
}

/**
 * How finely the wood is built. "far" is the same tree - every random draw is made regardless of
 * detail, and every limb follows the same line - with fewer sides and rings and no twigs, for trees
 * out where those cannot be told apart. The leaf cards are identical at both, so a tree changing
 * detail does not change shape.
 */
export type TreeDetail = "near" | "far";

/** Every other point of a limb's line, always keeping its last. */
function thinned<T>(items: T[]): T[] {
  const kept = items.filter((_, i) => i % 2 === 0);
  if ((items.length - 1) % 2 !== 0) kept.push(items[items.length - 1]);
  return kept;
}

/**
 * Generates one tree from a BranchingTree description. Deterministic from `seed`, which is what
 * makes each of a kind's variants a different but repeatable tree.
 */
export function generateTree(spec: BranchingTree, seed: number, detail: TreeDetail = "near"): TreeGeometry {
  const rng = mulberry32(seed);
  const between = ([lo, hi]: [number, number]): number => lo + rng() * (hi - lo);
  const intBetween = ([lo, hi]: [number, number]): number => Math.floor(lo + rng() * (hi - lo + 1));
  const { trunk, roots, branches, leaves, bark } = spec;
  const wood = new WoodBuilder();
  const leafBuilder = new LeafBuilder();
  const far = detail === "far";
  const limb = (points: V3[], radii: number[], sides: number): void => {
    if (far) wood.tube(thinned(points), thinned(radii), Math.max(3, Math.round(sides * 0.6)), bark.tile);
    else wood.tube(points, radii, sides, bark.tile);
  };

  // --- trunk ---
  // A gentle lean in one direction plus two slow sways, all zero at the base so the trunk stands
  // where it is planted.
  const leanAngle = rng() * Math.PI * 2;
  const leanX = Math.cos(leanAngle) * trunk.lean * trunk.height;
  const leanZ = Math.sin(leanAngle) * trunk.lean * trunk.height;
  const phaseX = rng() * Math.PI * 2;
  const phaseZ = rng() * Math.PI * 2;
  const buried = 0.6;
  const trunkPoint = (t: number): V3 => {
    const y = -buried + (trunk.height + buried) * t;
    const rise = Math.max(0, y) / trunk.height;
    return [
      leanX * rise * rise + trunk.wobble * rise * Math.sin(rise * 5 + phaseX),
      y,
      leanZ * rise * rise + trunk.wobble * rise * Math.sin(rise * 4.3 + phaseZ),
    ];
  };
  const trunkRadius = (t: number): number => {
    const y = -buried + (trunk.height + buried) * t;
    const rise = Math.max(0, y) / trunk.height;
    const flare = 1 + (trunk.flare - 1) * (1 - smoothstep(0, trunk.flareHeight, y));
    return lerp(trunk.radius, trunk.topRadius, rise) * flare;
  };
  const trunkTs: number[] = [];
  for (let i = 0; i <= trunk.rings; i++) {
    // Rings bunched towards the base, where the flare needs them.
    trunkTs.push(Math.pow(i / trunk.rings, 1.4));
  }
  limb(trunkTs.map(trunkPoint), trunkTs.map(trunkRadius), trunk.sides);

  // --- roots ---
  const rootStart = trunk.flareHeight * 0.55;
  for (let r = 0; r < roots.count; r++) {
    const heading = ((r + rng() * 0.6) / roots.count) * Math.PI * 2;
    const out: V3 = [Math.cos(heading), 0, Math.sin(heading)];
    const curl = (rng() - 0.5) * 0.6;
    const length = between(roots.length);
    const startRadius = trunk.radius * roots.radius;
    const points: V3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= roots.rings; i++) {
      const s = i / roots.rings;
      const bent = rotate(out, [0, 1, 0], curl * s);
      // Out along the ground, then down into it: the arch of a buttress root.
      const y = rootStart * Math.pow(1 - s, 2) - roots.drop * s * s;
      const reach = trunk.radius * 0.3 + length * s;
      points.push([bent[0] * reach, y, bent[2] * reach]);
      radii.push(startRadius * (1 - 0.8 * s));
    }
    limb(points, radii, roots.sides);
  }

  // --- branches and twigs ---
  const clusterPoints: V3[] = [];
  const branchCount = intBetween(branches.count);
  for (let b = 0; b < branchCount; b++) {
    const t = Math.min(0.97, branches.from + (1 - branches.from) * ((b + rng()) / branchCount));
    const heading = b * 2.39996 + (rng() - 0.5) * 0.6; // the golden angle, so no two line up
    const tilt = between(branches.angle) * DEG;
    const direction: V3 = [Math.sin(tilt) * Math.cos(heading), Math.cos(tilt), Math.sin(tilt) * Math.sin(heading)];
    const side = perpendicular(direction);
    const wander = (rng() - 0.5) * 0.3;
    const length = between(branches.length);
    const start = trunkPoint(t);
    const startRadius = trunkRadius(t) * branches.radius;

    const points: V3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= branches.rings; i++) {
      const s = i / branches.rings;
      // Straight out along its direction, curving back up towards the tip, with a slight sideways drift.
      const along = scale(direction, length * s);
      const lift: V3 = [0, branches.arc * length * s * s, 0];
      const drift = scale(side, wander * length * s * s);
      points.push(add(add(add(start, along), lift), drift));
      radii.push(startRadius * (1 - 0.78 * s));
    }
    limb(points, radii, branches.sides);
    clusterPoints.push(points[points.length - 1]);

    const branchAt = (s: number): { point: V3; tangent: V3; radius: number } => {
      const f = s * branches.rings;
      const i = Math.min(branches.rings - 1, Math.floor(f));
      const k = f - i;
      return {
        point: add(scale(points[i], 1 - k), scale(points[i + 1], k)),
        tangent: normalize(sub(points[i + 1], points[i])),
        radius: lerp(radii[i], radii[i + 1], k),
      };
    };

    const twigCount = intBetween(branches.twigs.count);
    for (let w = 0; w < twigCount; w++) {
      const at = branchAt(0.4 + rng() * 0.45);
      const away = rotate(perpendicular(at.tangent), at.tangent, rng() * Math.PI * 2);
      const angle = between(branches.twigs.angle) * DEG;
      // Off the branch, then nudged upward - twigs reach for the light.
      const twigDirection = normalize(add(add(scale(at.tangent, Math.cos(angle)), scale(away, Math.sin(angle))), [0, 0.35, 0]));
      const twigLength = length * between(branches.twigs.length);
      const twigPoints: V3[] = [];
      const twigRadii: number[] = [];
      for (let i = 0; i <= branches.twigs.rings; i++) {
        const s = i / branches.twigs.rings;
        twigPoints.push(add(at.point, add(scale(twigDirection, twigLength * s), [0, twigLength * 0.15 * s * s, 0])));
        twigRadii.push(at.radius * 0.7 * (1 - 0.75 * s));
      }
      if (!far) wood.tube(twigPoints, twigRadii, branches.twigs.sides, bark.tile);
      clusterPoints.push(twigPoints[twigPoints.length - 1]);
    }

    for (let a = 0; a < leaves.alongBranch; a++) clusterPoints.push(branchAt(0.55 + rng() * 0.35).point);
  }
  const top = trunkPoint(1);
  for (let a = 0; a < leaves.top; a++) {
    clusterPoints.push(add(top, [(rng() - 0.5) * leaves.spread * 2, leaves.size[0] * 0.25 + rng() * leaves.spread, (rng() - 0.5) * leaves.spread * 2]));
  }

  // --- leaf clusters ---
  const crownCentre = scale(clusterPoints.reduce<V3>((sum, p) => add(sum, p), [0, 0, 0]), 1 / Math.max(1, clusterPoints.length));
  const crownRadius = Math.max(1, ...clusterPoints.map((p) => Math.hypot(...sub(p, crownCentre))));
  let foliageTop = trunk.height;
  for (const point of clusterPoints) {
    // Each cluster is `cards` cards crossed about one axis - out from the crown and upward - like a
    // tuft of grass turned on its side, so it reads as a clump from any direction.
    const outward = normalize(add(sub(point, crownCentre), [0, crownRadius * 0.4, 0]));
    const axis = normalize(add(outward, [(rng() - 0.5) * 0.8, (rng() - 0.5) * 0.8, (rng() - 0.5) * 0.8]));
    const first = rotate(perpendicular(axis), axis, rng() * Math.PI);
    for (let c = 0; c < leaves.cards; c++) {
      const normal = rotate(first, axis, (c * Math.PI) / leaves.cards);
      const across = cross(axis, normal);
      const size = between(leaves.size);
      const offset: V3 = [(rng() - 0.5) * 2 * leaves.spread, (rng() - 0.5) * leaves.spread, (rng() - 0.5) * 2 * leaves.spread];
      const centre = add(point, offset);
      leafBuilder.card(centre, axis, across, size, Math.floor(rng() * 4), crownCentre, crownRadius);
      foliageTop = Math.max(foliageTop, centre[1] + size * 0.7);
    }
  }

  return {
    wood: {
      positions: new Float32Array(wood.positions),
      normals: new Float32Array(wood.normals),
      uvs: new Float32Array(wood.uvs),
      axes: new Float32Array(wood.axes),
      indices: new Uint32Array(wood.indices),
    },
    leaves: {
      positions: new Float32Array(leafBuilder.positions),
      normals: new Float32Array(leafBuilder.normals),
      uvs: new Float32Array(leafBuilder.uvs),
      indices: new Uint32Array(leafBuilder.indices),
    },
    height: foliageTop,
  };
}

/** One generated bush, in bush space (its base at the origin, up +Y): cards only. */
export interface BushGeometry {
  leaves: TreeGeometry["leaves"];
  height: number;
}

/**
 * Generates one bush from a BushShape: `cards` whole-bush cards crossed through its middle at even
 * turns, each showing one of the atlas's two side views, and `clumps` pairs of crossed clump cards
 * spread over its upper half, each pointing out from the middle with its twigs towards it.
 * Deterministic from `seed`.
 */
export function generateBush(spec: BushShape, seed: number): BushGeometry {
  const rng = mulberry32(seed);
  const between = ([lo, hi]: [number, number]): number => lo + rng() * (hi - lo);
  const builder = new LeafBuilder();
  const width = between(spec.width);
  const height = between(spec.height);
  const radius = width / 2;
  const crownCentre: V3 = [0, height * 0.5, 0];
  let top = height;

  const start = rng() * Math.PI;
  for (let c = 0; c < spec.cards; c++) {
    const angle = start + (c * Math.PI) / spec.cards + (rng() - 0.5) * 0.3;
    const u: V3 = [Math.cos(angle), 0, Math.sin(angle)];
    // Only a hair off the middle: every card's stems have to meet at the same root, or the base of
    // the bush splays into several.
    const off = (rng() - 0.5) * 0.03 * width;
    const foot: V3 = [-u[2] * off, -0.1, u[0] * off];
    const cardHeight = height * (0.9 + rng() * 0.2);
    builder.panel(foot, u, width * (0.9 + rng() * 0.2), cardHeight, Math.floor(rng() * 2), rng() < 0.5, crownCentre, radius);
    top = Math.max(top, cardHeight);
  }

  for (let k = 0; k < spec.clumps; k++) {
    const heading = start + k * 2.39996 + (rng() - 0.5) * 0.5;
    const elevation = (20 + rng() * 60) * DEG;
    const point: V3 = [
      Math.cos(elevation) * Math.cos(heading) * radius * 0.7,
      height * 0.55 + Math.sin(elevation) * height * 0.32,
      Math.cos(elevation) * Math.sin(heading) * radius * 0.7,
    ];
    const outward = normalize(sub(point, [0, height * 0.3, 0]));
    const axis = normalize(add(outward, [(rng() - 0.5) * 0.5, (rng() - 0.5) * 0.5, (rng() - 0.5) * 0.5]));
    const size = between(spec.clumpSize);
    const centre = add(point, scale(axis, size * 0.2));
    const first = rotate(perpendicular(axis), axis, rng() * Math.PI);
    const cell = 2 + Math.floor(rng() * 2);
    for (let c = 0; c < 2; c++) {
      const normal = rotate(first, axis, (c * Math.PI) / 2);
      builder.card(centre, cross(axis, normal), axis, size, cell, crownCentre, radius, true);
      top = Math.max(top, centre[1] + size * 0.6);
    }
  }

  return {
    leaves: {
      positions: new Float32Array(builder.positions),
      normals: new Float32Array(builder.normals),
      uvs: new Float32Array(builder.uvs),
      indices: new Uint32Array(builder.indices),
    },
    height: top,
  };
}
