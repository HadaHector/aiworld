import { mulberry32 } from "../rng";
import { lerp, smoothstep } from "../mathUtils";
import { FROND_STALK_HALF_WIDTH, FROND_STALK_SHARE, type BranchingTree, type BushShape, type ConiferTree, type Fronds } from "./foliageConfig";

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
    /** Per vertex, how level the surface itself lies there, 0 (upright) to 1 (flat) - what holds
     *  snow. Smooth across a card's folds, unlike its triangles' facing, and free of the crown's
     *  shading bias, unlike `normals`. */
    lie: Float32Array;
    /** Per vertex, how far it bends in the wind, 0 (held fast) to 1: a frond's share of its length
     *  from its root, so it bends from where it grows. Below 0, the crown sways as one, more the
     *  higher up - cards and conifer panels. */
    flex: Float32Array;
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
   * number of times around (so the seam matches) and at its true scale along. A `blunt` tube - a
   * limb snapped off - ends in a low cap instead of a tapering point.
   *
   * With `heights`, each ring is an upright wedge instead of a circle - `radii` across at its foot,
   * narrowing to a sharp edge at its top, `heights` up and down - framed on the vertical rather than
   * transported: a buttress root's plank, standing on edge.
   */
  tube(points: V3[], radii: number[], sides: number, tile: number, blunt = false, heights?: number[]): void {
    const base = this.positions.length / 3;
    const ring = sides + 1;
    // Sized on the limb's average girth: its first ring can be a flared base twice the width of
    // the rest, which would squeeze the bark sideways everywhere else.
    const meanRadius = radii.reduce((sum, r, i) => sum + (heights ? (r + heights[i]) / 2 : r), 0) / radii.length;
    const around = Math.max(1, Math.round((2 * Math.PI * meanRadius) / tile));
    let normal: V3 = perpendicular(normalize(sub(points[1], points[0])));
    let v = 0;

    for (let i = 0; i < points.length; i++) {
      const along = normalize(i === 0 ? sub(points[1], points[0]) : i === points.length - 1 ? sub(points[i], points[i - 1]) : sub(points[i + 1], points[i - 1]));
      // A wedge's slices stand upright whatever its centreline does: squared to the line, they would
      // tip outwards where it falls steeply and throw the top edge off the trunk.
      const tangent = heights ? normalize([along[0], 0, along[2]]) : along;
      normal = heights ? normalize(cross(tangent, [0, 1, 0])) : normalize(sub(normal, scale(tangent, dot(normal, tangent))));
      const binormal = cross(tangent, normal);
      if (i > 0) v += Math.hypot(...sub(points[i], points[i - 1])) / tile;
      const height = heights ? heights[i] : radii[i];
      for (let j = 0; j <= sides; j++) {
        const angle = (j / sides) * Math.PI * 2;
        const up = scale(binormal, Math.sin(angle));
        // A wedge: full width at the foot, a third of it at the top edge.
        const rising = heights ? (up[1] / Math.max(1e-6, Math.hypot(...binormal)) + 1) / 2 : 0;
        const width = radii[i] * (1 - 0.65 * rising);
        const across = scale(normal, Math.cos(angle));
        const p = add(points[i], add(scale(across, width), scale(up, height)));
        // Its normal leans towards the flat sides: the ellipse's gradient, not the radial direction.
        const out = heights ? normalize(add(scale(across, 1 / width), scale(up, 1 / height))) : add(across, up);
        this.positions.push(p[0], p[1], p[2]);
        this.normals.push(out[0], out[1], out[2]);
        this.uvs.push((j / sides) * around, v);
        this.axes.push(tangent[0], tangent[1], tangent[2]);
      }
      if (i > 0) {
        const a0 = base + (i - 1) * ring;
        const b0 = base + i * ring;
        // Clockwise seen from outside - Babylon's front faces - so the bark's back faces, the
        // inside of a limb, can be culled.
        for (let j = 0; j < sides; j++) {
          this.indices.push(a0 + j, b0 + j, a0 + j + 1, a0 + j + 1, b0 + j, b0 + j + 1);
        }
      }
    }

    // The apex: a short cone off the last ring, rather than an open end.
    const last = points.length - 1;
    const tipDirection = normalize(sub(points[last], points[last - 1]));
    const apex = add(points[last], scale(tipDirection, radii[last] * (blunt ? 0.35 : 2)));
    const apexIndex = this.positions.length / 3;
    this.positions.push(apex[0], apex[1], apex[2]);
    this.normals.push(tipDirection[0], tipDirection[1], tipDirection[2]);
    this.uvs.push(around * 0.5, v + (radii[last] * 2) / tile);
    this.axes.push(tipDirection[0], tipDirection[1], tipDirection[2]);
    const lastRing = base + last * ring;
    for (let j = 0; j < sides; j++) this.indices.push(lastRing + j, apexIndex, lastRing + j + 1);
  }
}

class LeafBuilder {
  positions: number[] = [];
  normals: number[] = [];
  lie: number[] = [];
  flex: number[] = [];
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
    const lie = Math.abs(normalize(cross(u, v))[1]);
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
      this.lie.push(lie);
      this.flex.push(-1);
      // An atlas row runs down the picture, so the card's top (+v) is the cell's first row.
      const up = upright ? -b : b;
      this.uvs.push(cellU + (a > 0 ? 0.5 - inset : inset), cellV + (up > 0 ? 0.5 - inset : inset));
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * A ribbon along `points`, `width` across `side`, showing atlas cell `cell` as a tile repeated end
   * to end every `tile` metres down it - the cell's bottom towards the first point, its top towards
   * the last (mirrored with `mirror`) - each tile its own quad, so the repeats need no wrapping. Its
   * normals are its own face's, so it is shaded as a frond is (an underside, a gloss), and it bends
   * in the wind from its first point. It twists `twist` radians about its own line from end to end,
   * so it turns a face every way as it falls rather than hanging as one flat card. With `taper` it
   * narrows along its length to 1 - `taper` of its width at the end, the tile cropped in towards its
   * middle rather than squeezed, so what is painted keeps its size and the edges just run out.
   */
  ribbon(points: V3[], side: V3, width: number, tile: number, cell: number, mirror: boolean, twist = 0, taper = 0): void {
    const cellU = (cell % 2) * 0.5;
    const cellV = Math.floor(cell / 2) * 0.5;
    const inset = 0.004;
    const span = 0.5 - inset * 2;
    const lengths = [0];
    for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(...sub(points[i], points[i - 1])));
    const total = lengths[lengths.length - 1];
    if (total < 1e-3) return;
    // The point `d` metres along, and the way the line runs there.
    let k = 0;
    const at = (d: number): { p: V3; tangent: V3 } => {
      while (k < points.length - 2 && lengths[k + 1] < d) k++;
      while (k > 0 && lengths[k] > d) k--;
      const segment = Math.max(1e-6, lengths[k + 1] - lengths[k]);
      const f = Math.min(1, Math.max(0, (d - lengths[k]) / segment));
      return { p: add(scale(points[k], 1 - f), scale(points[k + 1], f)), tangent: normalize(sub(points[k + 1], points[k])) };
    };
    const tiles = Math.ceil(total / tile);
    for (let t = 0; t < tiles; t++) {
      const d0 = t * tile;
      const d1 = Math.min(total, d0 + tile);
      const base = this.positions.length / 3;
      for (const [d, row] of [[d0, 1], [d1, 1 - (d1 - d0) / tile]] as const) {
        const { p, tangent } = at(d);
        // Square to the line, turned by its share of the twist.
        const flat = normalize(sub(side, scale(tangent, dot(side, tangent))));
        const turned = rotate(flat, tangent, twist * (d / total));
        const n = normalize(cross(turned, tangent));
        const kept = 1 - taper * (d / total);
        for (const a of [-1, 1]) {
          const q = add(p, scale(turned, (a * width * kept) / 2));
          this.positions.push(q[0], q[1], q[2]);
          this.normals.push(n[0], n[1], n[2]);
          this.lie.push(Math.abs(n[1]));
          this.flex.push((d / total) * Math.min(1, total / 8));
          const across = 0.5 + (a * kept) / 2;
          this.uvs.push(cellU + inset + (mirror ? 1 - across : across) * span, cellV + inset + row * span);
        }
      }
      this.indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }
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
        // An upright card holds no snow of its own; a bush's top still whitens, by the crown's normal.
        this.lie.push(Math.max(0, n[1]));
        this.flex.push(-1);
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

  /**
   * One panel of a conifer's cone - one branch: a square card whose diagonal runs from the trunk
   * at `apex` out to the rim, `reach` out and `drop` down, facing `heading`, as wide across its
   * other diagonal as `breadth` x its length. `droop` bends its stem over: near level at the trunk,
   * falling ever faster to the tip, its height going as along^(1 + droop). `arch` folds its sides down from the stem, so the branch curves over rather
   * than lying flat. `tilt` lifts the outer end, the way a whole tier can tip off level.
   *
   * It shows the whole of atlas cell `cell`, whose spray is drawn along the cell's diagonal (see
   * treeTextures.ts's bakeConiferFoliage): the cell's top-left corner at the trunk, its bottom-right
   * at the tip, the other two corners out at the sides - mirrored across the stem with `mirror`.
   * The card is a 3x3 grid over the cell, each small square split along the stem's direction, so
   * the stem runs along triangle edges (the fold of the arch) and every triangle maps its piece of
   * the cell exactly.
   *
   * Normals are the cone's own - outward and up, by the cone's slope - tipped outwards on each side
   * by the arch and bent towards the crown's centre, so each tier is lit as a cone, each branch as
   * a curved spray, and the whole tree still shades as one mass.
   */
  conePanel(
    apex: V3,
    heading: number,
    reach: number,
    drop: number,
    droop: number,
    breadth: number,
    arch: number,
    tilt: number,
    cell: number,
    mirror: boolean,
    crownCentre: V3,
  ): void {
    const base = this.positions.length / 3;
    const cellU = (cell % 2) * 0.5;
    const cellV = Math.floor(cell / 2) * 0.5;
    const inset = 0.004;
    const out: V3 = [Math.cos(heading), 0, Math.sin(heading)];
    const sideways: V3 = [-Math.sin(heading), 0, Math.cos(heading)];
    const halfWidth = (reach * breadth) / 2;
    for (let iv = 0; iv <= 2; iv++) {
      for (let iu = 0; iu <= 2; iu++) {
        const u = iu / 2;
        const v = iv / 2;
        // Along the stem (the cell's diagonal, 0 at the trunk corner, 1 at the tip corner) and across
        // it (+1 at the top-right corner, -1 at the bottom-left).
        const along = (u + v) / 2;
        const across = (mirror ? v - u : u - v);
        const r = 0.15 + reach * along;
        // The stem bends over: level where it leaves the trunk, falling ever faster towards the tip,
        // which ends `drop` below the trunk end - its height falls as along^(1 + droop).
        const bent = -drop * Math.pow(along, 1 + droop);
        const y = bent + tilt * r - arch * halfWidth * across * across;
        const p = add(apex, add([out[0] * r, y, out[2] * r], scale(sideways, across * halfWidth)));
        this.positions.push(p[0], p[1], p[2]);
        const cone = normalize(add(scale(out, drop), [0, reach, 0]));
        const archTip = scale(sideways, across * arch * 0.8);
        const n = normalize(add(add(cone, archTip), scale(normalize(sub(p, crownCentre)), 0.6)));
        this.normals.push(n[0], n[1], n[2]);
        this.lie.push(Math.max(0, normalize(add(cone, archTip))[1]));
        this.flex.push(-1);
        this.uvs.push(cellU + inset + u * (0.5 - 2 * inset), cellV + inset + v * (0.5 - 2 * inset));
      }
    }
    // Each small square split along the stem's direction (top-left to bottom-right in the cell).
    for (let iv = 0; iv < 2; iv++) {
      for (let iu = 0; iu < 2; iu++) {
        const a = base + iv * 3 + iu;
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
  const limb = (points: V3[], radii: number[], sides: number, blunt = false, heights?: number[]): void => {
    if (far) wood.tube(thinned(points), thinned(radii), Math.max(3, Math.round(sides * 0.6)), bark.tile, blunt, heights && thinned(heights));
    else wood.tube(points, radii, sides, bark.tile, blunt, heights);
  };
  // Whether a limb is snapped off short, and to what share of its length. No draw at all for a kind
  // that never breaks, so its trees stay exactly as they were.
  const snapped = (): number => (branches.broken > 0 && rng() < branches.broken ? 0.3 + rng() * 0.4 : 1);

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
    const swell = (rise - trunk.bulgeAt) / 0.3;
    const bulge = 1 + trunk.bulge * Math.exp(-swell * swell);
    // On stilts, the trunk narrows towards the ground: the roots carry it.
    const stilted = roots.stilt === null ? 1 : 0.35 + 0.65 * smoothstep(-0.3, roots.stilt[1] * 0.9, y);
    return lerp(trunk.radius, trunk.topRadius, rise) * flare * bulge * stilted;
  };
  const trunkTs: number[] = [];
  for (let i = 0; i <= trunk.rings; i++) {
    // Rings bunched towards the base, where the flare needs them.
    trunkTs.push(Math.pow(i / trunk.rings, 1.4));
  }
  limb(trunkTs.map(trunkPoint), trunkTs.map(trunkRadius), trunk.sides);

  // --- roots ---
  const rootStart = trunk.flareHeight * 0.55;
  if (roots.buttress) {
    // Buttresses: planks on edge, running out from the trunk, their top edge sweeping down from
    // high on the trunk to the ground in a concave curve, their foot buried.
    const { height, thickness } = roots.buttress;
    for (let r = 0; r < roots.count; r++) {
      const heading = ((r + (rng() - 0.5) * 0.5) / roots.count) * Math.PI * 2;
      const out: V3 = [Math.cos(heading), 0, Math.sin(heading)];
      const curl = (rng() - 0.5) * 0.5;
      // A snaking run rather than a ruled line: a slow sideways wave along it.
      const wave = (rng() - 0.5) * 0.5;
      const wavePhase = rng() * Math.PI * 2;
      const length = between(roots.length);
      const tall = height * (0.7 + rng() * 0.3);
      const points: V3[] = [];
      const widths: number[] = [];
      const heights: number[] = [];
      for (let i = 0; i <= roots.rings; i++) {
        // Rings bunched towards the trunk, where the top edge curves fastest.
        const s = Math.pow(i / roots.rings, 1.7);
        const bent = rotate(out, [0, 1, 0], curl * s + wave * Math.sin(s * Math.PI * 2 + wavePhase) * s);
        // The top edge sweeps down from high on the trunk in a concave curve, running into the
        // ground just short of the end, so the tip dives under rather than stopping cut off.
        const top = tall * Math.pow(1 - s, 2.4) + 0.5 * (1 - s) - 0.35 * s;
        const bottom = -0.8 - roots.drop * s;
        // Starting inside the trunk, so its foot merges into the flare.
        const reach = trunk.radius * 0.35 + length * s;
        points.push([bent[0] * reach, (top + bottom) / 2, bent[2] * reach]);
        heights.push(Math.max(0.05, (top - bottom) / 2));
        widths.push((thickness / 2) * (1 - 0.65 * s));
      }
      limb(points, widths, roots.sides, false, heights);
    }
  }
  if (roots.stilt !== null && !roots.buttress) {
    // Stilts: from the trunk down to plunge into the ground - some near level at first and then
    // curving down, some diving steeply from the start - each from its own height, so they cross
    // and tangle. Each sets off from the trunk's own centre at its height, wherever the trunk's
    // lean and sway have taken it.
    for (let r = 0; r < roots.count; r++) {
      const heading = ((r + rng() * 0.8) / roots.count) * Math.PI * 2;
      const out: V3 = [Math.cos(heading), 0, Math.sin(heading)];
      const curl = (rng() - 0.5) * 0.8;
      const length = between(roots.length);
      const high = between(roots.stilt);
      // 1 a straight dive, 2 out level and then down.
      const arch = 1 + rng();
      const from = trunkPoint((high + buried) / (trunk.height + buried));
      const startRadius = trunk.radius * roots.radius;
      const points: V3[] = [];
      const radii: number[] = [];
      for (let i = 0; i <= roots.rings; i++) {
        const s = i / roots.rings;
        const bent = rotate(out, [0, 1, 0], curl * s);
        const y = high * (1 - Math.pow(s, arch)) - roots.drop * s * s;
        const reach = length * Math.pow(s, 0.5 + 0.25 * (2 - arch));
        points.push([from[0] + bent[0] * reach, y, from[2] + bent[2] * reach]);
        radii.push(startRadius * (1 - 0.35 * s));
      }
      limb(points, radii, roots.sides);
    }
  }
  for (let r = 0; r < (roots.buttress || roots.stilt !== null ? 0 : roots.count); r++) {
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
  // Where along the limbs a vine can hang from - no draws, so a tree without vines is unchanged.
  const perches: V3[] = [];
  // ...and which way the limb runs there, for a leafy whip to arch off it square.
  const perchLimbs: V3[] = [];
  const perchAlong: number[] = [];
  const branchCount = intBetween(branches.count);
  for (let b = 0; b < branchCount; b++) {
    const t = Math.min(0.97, branches.from + (1 - branches.from) * ((b + rng()) / branchCount));
    const heading = b * 2.39996 + (rng() - 0.5) * 0.6; // the golden angle, so no two line up
    const tilt = between(branches.angle) * DEG;
    const direction: V3 = [Math.sin(tilt) * Math.cos(heading), Math.cos(tilt), Math.sin(tilt) * Math.sin(heading)];
    const side = perpendicular(direction);
    const wander = (rng() - 0.5) * 0.3;
    const fullLength = between(branches.length);
    const kept = snapped();
    const length = fullLength * kept;
    const start = trunkPoint(t);
    const startRadius = trunkRadius(t) * branches.radius;

    const points: V3[] = [];
    const radii: number[] = [];
    // Crooked: a kink off the line at every ring, the kinks adding up - from a stream of the
    // branch's own, so a kind that grows straight is the same tree it always was.
    const crookRng = branches.crook > 0 ? mulberry32((seed ^ Math.imul(b + 1, 0x9e3779b1)) >>> 0) : null;
    let bent: V3 = [0, 0, 0];
    for (let i = 0; i <= branches.rings; i++) {
      // A snapped branch is the same branch ending short - still thick where it broke.
      const s = (i / branches.rings) * kept;
      // Straight out along its direction, curving back up towards the tip, with a slight sideways drift.
      const along = scale(direction, fullLength * s);
      const lift: V3 = [0, branches.arc * fullLength * s * s, 0];
      const drift = scale(side, wander * fullLength * s * s);
      if (crookRng && i > 0) {
        const kink: V3 = [crookRng() - 0.5, crookRng() - 0.5, crookRng() - 0.5];
        const across = sub(kink, scale(direction, dot(kink, direction)));
        bent = add(bent, scale(across, (2 * branches.crook * fullLength * kept) / branches.rings));
      }
      points.push(add(add(add(add(start, along), lift), drift), bent));
      radii.push(startRadius * (1 - 0.78 * s));
    }
    limb(points, radii, branches.sides, kept < 1);
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
      const reaching = normalize(add(add(scale(at.tangent, Math.cos(angle)), scale(away, Math.sin(angle))), [0, 0.35, 0]));
      // In a crown levelled into one layer, twigs spread out along it rather than up through it.
      const flatness = leaves ? leaves.level : 0;
      const twigDirection = flatness > 0 ? normalize([reaching[0], reaching[1] * (1 - flatness), reaching[2]]) : reaching;
      const twigKept = snapped();
      const twigLength = length * between(branches.twigs.length) * twigKept;
      const twigPoints: V3[] = [];
      const twigRadii: number[] = [];
      for (let i = 0; i <= branches.twigs.rings; i++) {
        const s = i / branches.twigs.rings;
        twigPoints.push(add(at.point, add(scale(twigDirection, twigLength * s), [0, twigLength * 0.15 * s * s, 0])));
        twigRadii.push(at.radius * 0.7 * (1 - 0.75 * s));
      }
      if (!far) wood.tube(twigPoints, twigRadii, branches.twigs.sides, bark.tile, twigKept < 1);
      clusterPoints.push(twigPoints[twigPoints.length - 1]);
    }

    // Leafy strands - a curtain - hang closer together, from more of the limb.
    if (spec.vines) for (const s of spec.vines.leaves ? [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] : [0.35, 0.55, 0.75, 0.92]) {
      const at = branchAt(s);
      perches.push(at.point);
      perchLimbs.push(at.tangent);
      perchAlong.push(s);
    }
    if (leaves) for (let a = 0; a < leaves.alongBranch; a++) clusterPoints.push(branchAt(0.55 + rng() * 0.35).point);
  }

  let foliageTop = trunk.height;
  // With moss in the atlas, the clusters keep to its top two cells and the leafy vines - the moss -
  // to its bottom two.
  const mossKinds = spec.foliage && "moss" in spec.foliage && spec.foliage.moss ? spec.foliage.moss.length : 0;
  const mossy = mossKinds > 0;
  if (leaves) {
    const top = trunkPoint(1);
    for (let a = 0; a < leaves.top; a++) {
      clusterPoints.push(add(top, [(rng() - 0.5) * leaves.spread * 2, leaves.size[0] * 0.25 + rng() * leaves.spread, (rng() - 0.5) * leaves.spread * 2]));
    }

    // --- leaf clusters ---
    // Pulled towards the height of the crown's highest quarter first, for a crown that is one flat
    // layer lying on top of its limbs - not through them, with their ends poking out above it.
    if (leaves.level > 0 && clusterPoints.length > 0) {
      const heights = clusterPoints.map((p) => p[1]).sort((a, b) => b - a);
      const highest = heights.slice(0, Math.max(1, Math.ceil(heights.length / 4)));
      const layerY = highest.reduce((sum, y) => sum + y, 0) / highest.length;
      for (const p of clusterPoints) p[1] = lerp(p[1], layerY, leaves.level);
    }
    const crownCentre = scale(clusterPoints.reduce<V3>((sum, p) => add(sum, p), [0, 0, 0]), 1 / Math.max(1, clusterPoints.length));
    const crownRadius = Math.max(1, ...clusterPoints.map((p) => Math.hypot(...sub(p, crownCentre))));
    // Squashed, every card is sheared flatter, so a crown of them is a layer rather than a ball.
    const flat = (v: V3): V3 => [v[0], v[1] * leaves.squash, v[2]];
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
        const offset: V3 = [(rng() - 0.5) * 2 * leaves.spread, (rng() - 0.5) * leaves.spread * leaves.squash, (rng() - 0.5) * 2 * leaves.spread];
        const centre = add(point, offset);
        leafBuilder.card(centre, flat(axis), flat(across), size, Math.floor(rng() * (mossy ? 2 : 4)), crownCentre, crownRadius);
        foliageTop = Math.max(foliageTop, centre[1] + size * 0.7 * leaves.squash);
      }
    }
  } else if (!spec.crown) {
    for (let i = 1; i < wood.positions.length; i += 3) foliageTop = Math.max(foliageTop, wood.positions[i]);
  }

  // --- vines ---
  // Lianas: hanging straight down from a limb, swaying a little as they go, stopping short of the
  // ground - or slung from one limb to another, sagging between. From a stream of their own, so
  // the rest of the tree is the same with them or without. Leafy strands - a willow's curtain - are
  // clothed in crossed strips of the leaf atlas down their length, kept on a distant tree too.
  if (spec.vines && perches.length > 0 && (!far || spec.vines.leaves)) {
    const vineRng = mulberry32((seed ^ 0x2f1a3c5) >>> 0);
    // Which of the atlas's two moss cells this tree's strands all show - its kind of moss.
    const mossCell = 2 + (mossKinds === 2 ? Math.floor(vineRng() * 2) : 0);
    let picked = 0;
    const pick = (): V3 => perches[(picked = Math.floor(vineRng() * perches.length))];
    const { vines } = spec;
    const vineCount = Math.floor(vines.count[0] + vineRng() * (vines.count[1] - vines.count[0] + 1));
    const rings = 10;
    for (let v = 0; v < vineCount; v++) {
      const from = pick();
      const points: V3[] = [];
      if (vines.leaves) {
        // A leafy whip: up and out from the limb in a short arch, then falling - a fountain, so the
        // whips cover the limbs they hang from.
        const length = Math.min(from[1] - 0.6, vines.length[0] + vineRng() * (vines.length[1] - vines.length[0]));
        if (length < 1) continue;
        // Off the limb to one side, square to it - ribs off a spine, seen from above - turning to
        // run on out away from the trunk towards the limb's end, so the end of a limb is a fan.
        const limb = perchLimbs[picked];
        const level = Math.hypot(limb[0], limb[2]);
        const along: V3 = level > 0.1 ? [limb[0] / level, 0, limb[2] / level] : [1, 0, 0];
        const square = scale(cross([0, 1, 0], along), vineRng() < 0.5 ? -1 : 1);
        const flat = Math.hypot(from[0], from[2]);
        const outward: V3 = flat > 0.1 ? [from[0] / flat, 0, from[2] / flat] : along;
        const toEnd = smoothstep(0.45, 1, perchAlong[picked]);
        const blended = add(scale(square, 1 - toEnd), scale(outward, toEnd));
        const away = rotate(Math.hypot(...blended) > 0.05 ? normalize(blended) : outward, [0, 1, 0], (vineRng() - 0.5) * 0.5);
        const rise = (0.6 + vineRng() * 1.2) * vines.leaves.arch;
        const reach = (1.5 + vineRng() * 2.5) * vines.leaves.arch;
        const archShare = 0.25;
        for (let i = 0; i <= rings; i++) {
          const s = i / rings;
          if (s <= archShare) {
            const u = s / archShare;
            points.push(add(add(from, scale(away, reach * Math.sin((u * Math.PI) / 2))), [0, rise * Math.sin(u * Math.PI), 0]));
          } else {
            const u = (s - archShare) / (1 - archShare);
            points.push(add(add(from, scale(away, reach * (1 + 0.12 * u))), [0, -length * u, 0]));
          }
        }
      } else if (vineRng() < vines.loops && perches.length > 1) {
        const to = pick();
        const span = Math.hypot(...sub(to, from));
        if (span < 1) continue;
        const sag = span * (0.25 + vineRng() * 0.5);
        for (let i = 0; i <= rings; i++) {
          const s = i / rings;
          const p = add(scale(from, 1 - s), scale(to, s));
          points.push([p[0], p[1] - sag * 4 * s * (1 - s), p[2]]);
        }
      } else {
        const length = Math.min(from[1] - 0.8, vines.length[0] + vineRng() * (vines.length[1] - vines.length[0]));
        if (length < 1) continue;
        const driftX = (vineRng() - 0.5) * 0.2;
        const driftZ = (vineRng() - 0.5) * 0.2;
        const phase = vineRng() * Math.PI * 2;
        for (let i = 0; i <= rings; i++) {
          const s = i / rings;
          const wiggle = Math.sin(s * 5 + phase) * 0.25 * s;
          points.push([from[0] + (driftX * length + wiggle) * s, from[1] - length * s, from[2] + (driftZ * length + wiggle * 0.7) * s]);
        }
      }
      // A leafy whip carries its own stem in its leaves; only a bare liana is wood.
      if (!far && !vines.leaves) wood.tube(points, points.map((_, i) => vines.radius * (1 - 0.3 * (i / rings))), 3, bark.tile);
      if (vines.leaves) {
        // One ribbon of the whip atlas along it, lying across the way it leans out - its face to the
        // outside of the tree, where it is seen from.
        const lean: V3 = [points[rings][0] - from[0], 0, points[rings][2] - from[2]];
        // Hanging straight down (no arch), it faces out from the trunk instead.
        const out = Math.hypot(...lean) > 0.05 ? normalize(lean) : Math.hypot(from[0], from[2]) > 0.05 ? normalize([from[0], 0, from[2]]) : ([1, 0, 0] as V3);
        const sideways = cross([0, 1, 0], out);
        const cell = mossy ? (mossKinds === 2 ? mossCell : 2 + Math.floor(vineRng() * 2)) : Math.floor(vineRng() * 4);
        const mirror = vineRng() < 0.5;
        // A distant tree: every other whip, wider to keep the curtain as full, its leaves tiled half
        // as often - a quarter of the quads. Every whip still draws its numbers, so the ones kept
        // hang exactly where the near tree's do.
        if (far && v % 2 === 1) continue;
        const width = vines.leaves.width * (far ? 1.4 : 1);
        const tile = vines.leaves.tile * (far ? 2 : 1);
        // Twisting a good part of half a turn as it falls, one way or the other - never hanging flat.
        const turn = vineRng();
        const twist = (turn < 0.5 ? -1 : 1) * (0.6 + 0.4 * ((turn * 2) % 1)) * Math.PI;
        leafBuilder.ribbon(points, sideways, width, tile, cell, mirror, twist, vines.leaves.taper);
      }
    }
  }

  // --- a frond crown ---
  // A fern's fronds, their root up in the trunk's tapering tip (the tube's apex runs two top radii
  // past its last ring), so they grow out of it rather than sit on a stump.
  if (spec.crown) {
    const crown = generateFronds(spec.crown, Math.floor(rng() * 0x7fffffff));
    const top = trunkPoint(1);
    const lift = top[1] + trunk.topRadius * 1.2;
    const base = leafBuilder.positions.length / 3;
    const p = crown.leaves.positions;
    for (let i = 0; i < p.length; i += 3) leafBuilder.positions.push(p[i] + top[0], p[i + 1] + lift, p[i + 2] + top[2]);
    leafBuilder.normals.push(...crown.leaves.normals);
    leafBuilder.lie.push(...crown.leaves.lie);
    leafBuilder.flex.push(...crown.leaves.flex);
    leafBuilder.uvs.push(...crown.leaves.uvs);
    for (const index of crown.leaves.indices) leafBuilder.indices.push(base + index);
    foliageTop = Math.max(foliageTop, lift + crown.height);
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
      lie: new Float32Array(leafBuilder.lie),
      flex: new Float32Array(leafBuilder.flex),
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
  if (spec.fronds) return generateFronds(spec.fronds, seed);
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
      lie: new Float32Array(builder.lie),
      flex: new Float32Array(builder.flex),
      uvs: new Float32Array(builder.uvs),
      indices: new Uint32Array(builder.indices),
    },
    height: top,
  };
}

/**
 * Generates one frond plant - a fern - from its Fronds: `count` fronds round one root at even turns
 * (jittered), each a strip of `segments` quads three vertices across. A frond sets off `angle` from
 * vertical and curls over by `curl` more at its tip, the curl growing along it, so the outer fronds
 * arch out and down; its midrib stands `fold` of its width above its edges, a shallow keel. It
 * shows one of the atlas's four single fronds, base to tip, mirrored at random. Deterministic from
 * `seed`.
 */
function generateFronds(spec: Fronds, seed: number): BushGeometry {
  const rng = mulberry32(seed);
  const between = ([lo, hi]: [number, number]): number => lo + rng() * (hi - lo);
  const positions: number[] = [];
  const normals: number[] = [];
  const lie: number[] = [];
  const flex: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const inset = 0.004;
  const span = 0.5 - inset * 2;
  let top = 0.2;
  const count = Math.floor(between([spec.count[0], spec.count[1] + 0.999]));
  const start = rng() * Math.PI * 2;
  for (let f = 0; f < count; f++) {
    const azimuth = start + ((f + (rng() - 0.5) * 0.6) / count) * Math.PI * 2;
    const out: V3 = [Math.cos(azimuth), 0, Math.sin(azimuth)];
    const side: V3 = [-Math.sin(azimuth), 0, Math.cos(azimuth)];
    const angle = between(spec.angle) * DEG;
    const curl = spec.curl * DEG * (0.7 + rng() * 0.6);
    const length = between(spec.length);
    const cell = Math.floor(rng() * 4);
    const mirror = rng() < 0.5;
    const cellU = (cell % 2) * 0.5;
    const cellV = Math.floor(cell / 2) * 0.5;
    const base = positions.length / 3;
    // Drawn last, so a frond with no stalk draws exactly what it always did.
    const stalkLength = spec.stalk ? between(spec.stalk.length) : 0;
    const total = stalkLength + length;
    // Each row across the strip: how far along the frond (metres) and which row of the cell it
    // shows, and its vertices across - where (metres from the middle), which column of the cell,
    // how high the keel lifts it, and how far its normal tips out to the side.
    type Column = { x: number; u: number; keel: number; tilt: number };
    const rows: { d: number; v: number; cols: Column[] }[] = [];
    const smoothstep01 = (t: number): number => smoothstep(0, 1, Math.min(1, Math.max(0, t)));
    if (!spec.stalk) {
      // A fern: three across, the keel down the middle.
      for (let s = 0; s <= spec.segments; s++) {
        const t = s / spec.segments;
        // Narrow where it leaves the root, full width from a fifth of the way along.
        const width = spec.width * Math.min(1, 0.35 + t * 3.25);
        rows.push({
          d: length * t,
          v: t,
          cols: [-1, 0, 1].map((a) => ({ x: (a * width) / 2, u: 0.5 + a * 0.5, keel: a === 0 ? spec.fold * width : 0, tilt: a * spec.fold * 1.5 })),
        });
      }
    } else {
      // A leaf on a stalk: five across - the blade's edges, the stem's edges and its middle - so the
      // stalk's round ridge runs on up the blade at its own width and height, dying away over the
      // blade's first fifth as the blade's own fold comes in. Three across could not carry a narrow
      // ridge onto a wide blade: its edges would jump. The stalk's rows put its outer columns on its
      // stem's edges; the blade's first row stands where the stalk ends, so the strip widens in no
      // length at all, where the atlas paints the stem on the blade at the stalk's own width.
      const stem = spec.stalk.width;
      const ridge = stem * 0.5;
      const stemU = stem / spec.width / 2;
      for (let s = 0; s <= 2; s++) {
        rows.push({
          d: (stalkLength * s) / 2,
          v: (FROND_STALK_SHARE * s) / 2,
          cols: [-1, -1, 0, 1, 1].map((a) => ({ x: (a * stem) / 2, u: 0.5 + a * FROND_STALK_HALF_WIDTH, keel: a === 0 ? ridge : 0, tilt: a * 0.75 })),
        });
      }
      for (let s = 0; s <= spec.segments; s++) {
        const t = s / spec.segments;
        const foldIn = smoothstep01(t / 0.2);
        const fold = spec.fold * spec.width * foldIn;
        const stemRidge = ridge * (1 - foldIn);
        rows.push({
          d: stalkLength + length * t,
          v: FROND_STALK_SHARE + (1 - FROND_STALK_SHARE) * t,
          cols: [
            { x: -spec.width / 2, u: 0, keel: 0, tilt: -spec.fold * 1.5 * foldIn },
            { x: -stem / 2, u: 0.5 - stemU, keel: fold * (1 - stem / spec.width), tilt: -(0.75 * (1 - foldIn) + spec.fold * 1.5 * foldIn) },
            { x: 0, u: 0.5, keel: fold + stemRidge, tilt: 0 },
            { x: stem / 2, u: 0.5 + stemU, keel: fold * (1 - stem / spec.width), tilt: 0.75 * (1 - foldIn) + spec.fold * 1.5 * foldIn },
            { x: spec.width / 2, u: 1, keel: 0, tilt: spec.fold * 1.5 * foldIn },
          ],
        });
      }
    }
    const columns = rows[0].cols.length;
    let point: V3 = [0, -0.05, 0];
    rows.forEach((row, r) => {
      const t = row.d / total;
      const heading = angle + curl * t * t;
      const along: V3 = add(scale(out, Math.sin(heading)), [0, Math.cos(heading), 0]);
      // The frond's own "up": its direction turned back a right angle, towards the sky.
      const facing: V3 = add(scale(out, -Math.cos(heading)), [0, Math.sin(heading), 0]);
      for (const col of row.cols) {
        const p = add(add(point, scale(side, col.x)), scale(facing, col.keel));
        positions.push(p[0], p[1], p[2]);
        // Tipped outwards either side of the keel, the way the fold turns the halves.
        const n = normalize(add(facing, scale(side, col.tilt)));
        normals.push(n[0], n[1], n[2]);
        lie.push(Math.abs(n[1]));
        // A long frond swings further at its tip than a short one: full at 8 m.
        flex.push(t * Math.min(1, total / 8));
        uvs.push(cellU + inset + (mirror ? 1 - col.u : col.u) * span, cellV + 0.5 - inset - row.v * span);
        top = Math.max(top, p[1]);
      }
      if (r < rows.length - 1) point = add(point, scale(along, rows[r + 1].d - row.d));
    });
    for (let s = 0; s < rows.length - 1; s++) {
      for (let a = 0; a < columns - 1; a++) {
        const i0 = base + s * columns + a;
        const i1 = base + (s + 1) * columns + a;
        indices.push(i0, i0 + 1, i1 + 1, i0, i1 + 1, i1);
      }
    }
  }
  return {
    leaves: { positions: new Float32Array(positions), normals: new Float32Array(normals), lie: new Float32Array(lie), flex: new Float32Array(flex), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) },
    height: top,
  };
}

/**
 * Generates one conifer from a ConiferTree description. Deterministic from `seed`. Each tier draws
 * from a stream of its own, so the far model - fewer panels round each cone - keeps every tier
 * exactly where the near one has it.
 */
export function generateConifer(spec: ConiferTree, seed: number, detail: TreeDetail = "near"): TreeGeometry {
  const rng = mulberry32(seed);
  const between = ([lo, hi]: [number, number]): number => lo + rng() * (hi - lo);
  const intBetween = ([lo, hi]: [number, number]): number => Math.floor(lo + rng() * (hi - lo + 1));
  const { trunk, roots, tiers, bark } = spec;
  const wood = new WoodBuilder();
  const leafBuilder = new LeafBuilder();
  const far = detail === "far";
  const limb = (points: V3[], radii: number[], sides: number): void => {
    if (far) wood.tube(thinned(points), thinned(radii), Math.max(3, Math.round(sides * 0.6)), bark.tile);
    else wood.tube(points, radii, sides, bark.tile);
  };

  // --- trunk ---
  // A sweep out at the foot that straightens up (the curve a slope or a neighbour leaves in a
  // young tree), a lean that grows with height, and a slow sway - all zero at the base.
  const sweepAngle = rng() * Math.PI * 2;
  const leanAngle = rng() * Math.PI * 2;
  const phase = rng() * Math.PI * 2;
  const buried = 0.5;
  const pointAt = (y: number): V3 => {
    const rise = Math.max(0, y) / trunk.height;
    const sweep = trunk.bend * (1 - Math.pow(1 - Math.min(1, rise), 3));
    const lean = trunk.lean * trunk.height * rise * rise;
    const sway = trunk.wobble * rise * Math.sin(rise * 5.5 + phase);
    return [
      Math.cos(sweepAngle) * sweep + Math.cos(leanAngle) * lean + Math.cos(phase) * sway,
      y,
      Math.sin(sweepAngle) * sweep + Math.sin(leanAngle) * lean + Math.sin(phase) * sway,
    ];
  };
  const radiusAt = (y: number): number => {
    const rise = Math.max(0, y) / trunk.height;
    const flare = 1 + (trunk.flare - 1) * (1 - smoothstep(0, trunk.flareHeight, y));
    return lerp(trunk.radius, trunk.topRadius, Math.pow(rise, 0.9)) * flare;
  };
  const trunkYs: number[] = [];
  for (let i = 0; i <= trunk.rings; i++) trunkYs.push(-buried + (trunk.height + buried) * Math.pow(i / trunk.rings, 1.25));
  limb(trunkYs.map(pointAt), trunkYs.map(radiusAt), trunk.sides);

  // --- roots ---
  // Conifer roots are shallow: they leave the trunk low and run out under the surface.
  const rootStart = trunk.flareHeight * 0.2;
  for (let r = 0; r < roots.count; r++) {
    const heading = ((r + rng() * 0.6) / roots.count) * Math.PI * 2;
    const length = between(roots.length);
    const points: V3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= roots.rings; i++) {
      const s = i / roots.rings;
      const reach = trunk.radius * 0.3 + length * s;
      points.push([Math.cos(heading) * reach, rootStart * Math.pow(1 - s, 2) - roots.drop * s * s, Math.sin(heading) * reach]);
      radii.push(trunk.radius * roots.radius * (1 - 0.8 * s));
    }
    limb(points, radii, roots.sides);
  }

  // --- tiers ---
  const tierCount = intBetween(tiers.count);
  const lowestApex = tiers.from * trunk.height + tiers.height[0];
  // The topmost tier's apex stands a little above the trunk's end: the leader.
  const topApex = trunk.height + tiers.height[1] * 0.3;
  const crownCentre = pointAt((lowestApex + topApex) / 2);
  const tierSeed = Math.floor(rng() * 0x7fffffff);
  let top = topApex;
  for (let i = 0; i < tierCount; i++) {
    const tierRng = mulberry32((tierSeed + Math.imul(i + 1, 0x9e3779b1)) >>> 0);
    const s = tierCount === 1 ? 1 : i / (tierCount - 1);
    const spacing = tierCount === 1 ? 0 : (topApex - lowestApex) / (tierCount - 1);
    const apexY = lerp(lowestApex, topApex, s) + (tierRng() - 0.5) * 0.35 * spacing;
    const drop = lerp(tiers.height[0], tiers.height[1], s) * (0.9 + tierRng() * 0.2);
    const radius = lerp(tiers.radius[0], tiers.radius[1], s) * (0.88 + tierRng() * 0.24);
    // Above the trunk's end, the apex carries on straight up from it.
    const apex = apexY <= trunk.height ? pointAt(apexY) : add(pointAt(trunk.height), [0, apexY - trunk.height, 0]);
    const tiltHeading = tierRng() * Math.PI * 2;
    const tiltAmount = tiers.tilt * tierRng();
    const turn = tierRng() * Math.PI * 2;
    const panels = far ? Math.max(4, Math.round(tiers.panels * 0.6)) : tiers.panels;
    // The far model's fewer branches are broader, so a tier covers the same ground.
    const breadth = tiers.breadth * (tiers.panels / panels);
    for (let j = 0; j < panels; j++) {
      const heading = turn + (j * Math.PI * 2) / panels + (tierRng() - 0.5) * 0.3 * ((Math.PI * 2) / panels);
      // Every branch its own: longer or shorter, bending over more or less, its tip lower or
      // higher, broader or narrower - by `variety`, so a tier's rim is ragged and no two alike.
      const vary = (amount: number): number => 1 + (tierRng() * 2 - 1) * tiers.variety * amount;
      const reach = radius * vary(1);
      const droop = tiers.droop * Math.max(0, vary(2));
      const branchDrop = drop * vary(0.7);
      const branchBreadth = breadth * vary(0.5);
      const tilt = tiltAmount * Math.cos(heading - tiltHeading);
      const cell = Math.floor(tierRng() * 4);
      const mirror = tierRng() < 0.5;
      leafBuilder.conePanel(apex, heading, reach, branchDrop, droop, Math.min(1.6, branchBreadth), tiers.arch, tilt, cell, mirror, crownCentre);
    }
    top = Math.max(top, apex[1]);
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
      lie: new Float32Array(leafBuilder.lie),
      flex: new Float32Array(leafBuilder.flex),
      uvs: new Float32Array(leafBuilder.uvs),
      indices: new Uint32Array(leafBuilder.indices),
    },
    height: top + 1,
  };
}
