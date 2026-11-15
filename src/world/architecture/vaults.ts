// Vaults (GEOMETRY.md, 10: the ceiling, flat or subdivided): a barrel vault's section - the arc it
// is built on, from one springing line over to the other - and the arches (ribs) that follow it.
// Pure geometry: across (s, from the vault's middle) and up (y, from its springing).

/** One arc of a section: about (cs, cy), radius r, from angle a0 to a1 (0 is +s, going up over). */
interface Arc {
  cs: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
  /** The length of the section before it. */
  start: number;
}

/** A barrel vault's section: its arc sampled from +half over to -half, and what lies on it. */
export interface BarrelProfile {
  half: number;
  rise: number;
  /** Points along it, [s, y], from the springing at +half to the one at -half; and how far along
   *  the arc each lies. */
  points: [number, number][];
  lengths: number[];
  /** Its inward normal (towards the room) at a point on or near it, [s, y], and how far along the
   *  arc that point lies (a rib's soffit, under it, by the arc's own). */
  normalAt(s: number, y: number): [number, number];
  lengthAt(s: number, y: number): number;
  /** How far under the arc a point lies (along its normal; negative over it). */
  depthAt(s: number, y: number): number;
}

/** How far apart, about, the points along a section are (its facets' width). */
const FACET = 1.25;

/**
 * A barrel's section over a span 2·half across, rising `rise`: a half circle where it rises half its
 * width; flatter, a basket-handle (three-centred) arch - its haunches turning tighter, upright where
 * it springs from the walls, its crown flatter; flatter still than a three-centred arch can be, a
 * segment of a circle.
 */
export function barrelProfile(half: number, rise: number, facet = FACET): BarrelProfile {
  const arcs: Arc[] = [];
  const push = (cs: number, cy: number, r: number, a0: number, a1: number): void => {
    const last = arcs[arcs.length - 1];
    arcs.push({ cs, cy, r, a0, a1, start: last ? last.start + last.r * (last.a1 - last.a0) : 0 });
  };
  if (rise >= half - 1e-6) push(0, 0, half, 0, Math.PI);
  else {
    // Haunches turning through 60 degrees each, the crown the rest between.
    const turn = Math.PI / 3;
    const d = (half - rise) / (Math.sin(turn) + Math.cos(turn) - 1);
    const r1 = half - d * Math.cos(turn), r2 = rise + d * Math.sin(turn);
    if (r1 > 0.15 * half) {
      push(half - r1, 0, r1, 0, turn);
      push(0, rise - r2, r2, turn, Math.PI - turn);
      push(-(half - r1), 0, r1, Math.PI - turn, Math.PI);
    } else {
      const r = (half * half + rise * rise) / (2 * rise);
      const a = Math.acos(half / r);
      push(0, rise - r, r, a, Math.PI - a);
    }
  }
  const points: [number, number][] = [], lengths: number[] = [];
  for (const arc of arcs) {
    const n = Math.max(1, Math.ceil((arc.r * (arc.a1 - arc.a0)) / facet));
    for (let k = points.length === 0 ? 0 : 1; k <= n; k++) {
      const a = arc.a0 + ((arc.a1 - arc.a0) * k) / n;
      points.push([arc.cs + arc.r * Math.cos(a), arc.cy + arc.r * Math.sin(a)]);
      lengths.push(arc.start + arc.r * (a - arc.a0));
    }
  }
  /** The arc a point lies on (by its angle about each arc's centre), and that angle. */
  const on = (s: number, y: number): { arc: Arc; a: number } => {
    let best: { arc: Arc; a: number; off: number } | null = null;
    for (const arc of arcs) {
      const a = Math.atan2(y - arc.cy, s - arc.cs);
      const off = Math.max(arc.a0 - a, a - arc.a1, 0);
      if (!best || off < best.off) best = { arc, a, off };
    }
    return { arc: best!.arc, a: Math.min(best!.arc.a1, Math.max(best!.arc.a0, best!.a)) };
  };
  return {
    half,
    rise,
    points,
    lengths,
    normalAt: (s, y) => {
      const { a } = on(s, y);
      return [-Math.cos(a), -Math.sin(a)];
    },
    lengthAt: (s, y) => {
      const { arc, a } = on(s, y);
      return arc.start + arc.r * (a - arc.a0);
    },
    depthAt: (s, y) => {
      const { arc } = on(s, y);
      return arc.r - Math.hypot(s - arc.cs, y - arc.cy);
    },
  };
}

/**
 * An arch under a barrel along its section (a rib following the vault round): a convex piece per
 * facet, each from a little into the vault's stone down `depth` under it, `width` along the vault -
 * `point` placing (along, across, up) in the builder's frame. Its feet are level, at the springing.
 */
export function barrelArch<T>(profile: BarrelProfile, point: (a: number, s: number, y: number) => T, at: number, width: number, depth: number): T[][] {
  const pieces: T[][] = [];
  const { points } = profile;
  const edge = (k: number): [[number, number], [number, number]] => {
    const [s, y] = points[k];
    const [ns, ny] = profile.normalAt(s, y);
    return [[s - ns * 0.1, y - ny * 0.1], [s + ns * depth, y + ny * depth]];
  };
  for (let k = 0; k + 1 < points.length; k++) {
    const [o0, i0] = edge(k), [o1, i1] = edge(k + 1);
    const ring = [o0, i0, i1, o1];
    pieces.push([...ring.map(([s, y]) => point(at - width / 2, s, y)), ...ring.map(([s, y]) => point(at + width / 2, s, y))]);
  }
  return pieces;
}
