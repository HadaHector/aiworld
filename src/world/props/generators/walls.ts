import type { Vec3 } from "../../buildings/buildingGeometry";
import type { Paint } from "../../buildings/buildingTypes";
import type { LineRun, PropContext, PropGenerator } from "../propGenerator";
import { ORIGIN, moved } from "../propShapes";

/**
 * Line props: walls and fences, laid along a run of ground (see LineRun) rather than set down whole -
 * round a compound's yard, broken at its gates. Each follows the ground: a fence's posts stand
 * plumb and its rails run with the slope; a drystone wall's courses rise and fall with it, its foot
 * sunk into it so it never stands on air over a dip.
 */

/** How far a wall's foot or a post is sunk into the ground. */
const SINK = 0.3;

/** A run turning by more than this (radians) at a point has a corner there - a post, a pier. */
const CORNER = 0.25;

/** The workbench's sample: a straight run this long on level ground, free at both ends. */
const SAMPLE_LENGTH = 8;

function sampleRun(): LineRun {
  const points: Vec3[] = [];
  for (let x = -SAMPLE_LENGTH / 2; x <= SAMPLE_LENGTH / 2 + 1e-6; x += 1) points.push([x, 0, 0]);
  return { points, ends: ["free", "free"], breach: false };
}

/** Where a run is `s` metres along it (measured flat), and its ground there. */
export interface Walker {
  /** Its whole length, flat. */
  length: number;
  /**
   * Where along it to stand its posts (or its points): its ends and every corner - wherever it
   * turns by more than CORNER - and between them evenly, no further apart than `step`. So a post
   * stands in every corner and no rail or wall face cuts across one.
   */
  stations(step: number): number[];
  at(s: number): Vec3;
  /** Its flat direction there. */
  dir(s: number): [number, number];
}

export function walk(points: Vec3[]): Walker {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][2] - points[i - 1][2]));
  const segment = (s: number): number => {
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < s) i++;
    return i;
  };
  const total = lengths[lengths.length - 1];
  return {
    length: total,
    stations(step) {
      const corners = [0];
      for (let i = 1; i + 1 < points.length; i++) {
        const ax = points[i][0] - points[i - 1][0], az = points[i][2] - points[i - 1][2];
        const bx = points[i + 1][0] - points[i][0], bz = points[i + 1][2] - points[i][2];
        const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
        if (turn > CORNER && lengths[i] - corners[corners.length - 1] > 0.3 && total - lengths[i] > 0.3) corners.push(lengths[i]);
      }
      corners.push(total);
      const out = [0];
      for (let c = 1; c < corners.length; c++) {
        const span = corners[c] - corners[c - 1];
        const n = Math.max(1, Math.round(span / step));
        for (let k = 1; k <= n; k++) out.push(corners[c - 1] + (span * k) / n);
      }
      return out;
    },
    at(s) {
      const i = segment(s);
      const a = points[i - 1];
      const b = points[i];
      const t = Math.max(0, Math.min(1, (s - lengths[i - 1]) / Math.max(1e-6, lengths[i] - lengths[i - 1])));
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    },
    dir(s) {
      const i = segment(s);
      const dx = points[i][0] - points[i - 1][0];
      const dz = points[i][2] - points[i - 1][2];
      const l = Math.hypot(dx, dz) || 1;
      return [dx / l, dz / l];
    },
  };
}

/**
 * A split-rail fence: posts every few metres, plumb, sunk into the ground, two or three rails nailed
 * along one face of them following the slope from post to post. Its far model keeps the posts and
 * two rails. In the way bay by bay; a breach is its rails down - one lying in the grass, one hanging
 * from a post - and nothing in the way.
 */
export const railFence: PropGenerator = {
  doc: "A split-rail fence - plumb posts, rails along the slope - laid along a run of ground.",
  params: {
    height: { kind: "range", default: [1.1, 1.3], min: 0.4, doc: "the top rail's height" },
    spacing: { kind: "range", default: [2.2, 2.8], min: 0.8, doc: "between its posts" },
    rails: { kind: "count", default: [2, 3], min: 1, doc: "how many rails a bay has" },
    missing: { kind: "chance", default: 0.04, doc: "how likely a rail is gone" },
  },
  parts: ["posts", "rails"],
  build(ctx) {
    railFence.line!(ctx, sampleRun());
  },
  line(ctx, run) {
    const { shape, rng } = ctx;
    const posts = ctx.paint("posts");
    const rails = ctx.paint("rails");
    const h = ctx.range("height");
    const path = walk(run.points);
    if (path.length < 0.2) return;
    if (run.breach) {
      fallenRails(ctx, path, h, rails);
      return;
    }
    const stations = path.stations(ctx.range("spacing"));
    const bays = stations.length - 1;
    const railCount = ctx.far ? 2 : ctx.count("rails");
    const railYs = Array.from({ length: railCount }, (_, k) => (railCount === 1 ? h : h * (0.4 + (0.6 * k) / (railCount - 1))));
    const post = 0.14;
    // Its rails nailed to one face of the posts, the same face all along.
    const face = post / 2 + 0.05;
    stations.forEach((s, k) => {
      const end = (k === 0 && run.ends[0] !== "join") || (k === bays && run.ends[1] !== "join");
      // A joined end's post is the next stretch's first.
      if (k === bays && run.ends[1] === "join") return;
      const [x, y, z] = path.at(s);
      const top = h + 0.12;
      const width = end ? post * 1.3 : post;
      shape.box(moved(ORIGIN, [x, y + (top - SINK) / 2, z]), [width / 2, (top + SINK) / 2, width / 2], posts, { bottom: false, taper: [1, 0.85] });
    });
    for (let k = 0; k < bays; k++) {
      const a = path.at(stations[k]);
      const b = path.at(stations[k + 1]);
      const [dx, dz] = path.dir((stations[k] + stations[k + 1]) / 2);
      const nx = -dz * face;
      const nz = dx * face;
      // Past the posts a little either way, as split rails are.
      const over = 0.12;
      for (const y of railYs) {
        if (!ctx.far && rng() < ctx.number("missing")) continue;
        const from: Vec3 = [a[0] - dx * over + nx, a[1] + y, a[2] - dz * over + nz];
        const to: Vec3 = [b[0] + dx * over + nx, b[1] + y, b[2] + dz * over + nz];
        shape.beam(ORIGIN, from, to, 0.09, 0.13, rails);
      }
      // In the way from the ground to its top rail, a hand either side of its posts.
      const t = 0.1;
      const hull: Vec3[] = [];
      for (const p of [a, b]) {
        for (const side of [-1, 1]) {
          for (const y of [p[1] - 0.1, p[1] + h + 0.1]) hull.push([p[0] - dz * t * side, y, p[2] + dx * t * side]);
        }
      }
      shape.solid(hull);
    }
  },
};

/** A fence's breach: its rails down - one lying along it in the grass, one end still on the post it
 *  hung from, the other in the grass. */
function fallenRails(ctx: PropContext, path: Walker, h: number, rails: Paint): void {
  const { shape, rng } = ctx;
  const a = path.at(0);
  const b = path.at(path.length);
  const [dx, dz] = path.dir(path.length / 2);
  const off = (rng() - 0.5) * 0.8;
  shape.beam(ORIGIN, [a[0] + 0.3 * dx - dz * off, a[1] + 0.05, a[2] + 0.3 * dz + dx * off], [b[0] - 0.2 * dx - dz * (off + 0.3), b[1] + 0.05, b[2] - 0.2 * dz + dx * (off + 0.3)], 0.09, 0.13, rails);
  if (ctx.far) return;
  const from = rng() < 0.5 ? a : b;
  const to = path.at(path.length * (0.45 + rng() * 0.2));
  shape.beam(ORIGIN, [from[0], from[1] + h * 0.9, from[2]], [to[0] - dz * 0.4, to[1] + 0.06, to[2] + dx * 0.4], 0.09, 0.13, rails);
}

/**
 * A drystone wall: field stones laid without mortar, battered - wider at its foot than its top -
 * its foot sunk into the ground and its courses rising and falling with it, smoothed; a cope of
 * stones set on edge along its top; through-stones showing their ends here and there on its faces.
 * The stones are its texture, not its geometry, but for the cope and the through-stones - left out
 * of its far model, its top raised to stand as tall. Where it falls into a breach it steps down to
 * half its height, and in the breach is a low bank of rubble with stones spilled about it: walked
 * over, not in the way.
 */
export const drystoneWall: PropGenerator = {
  doc: "A drystone wall - battered, coped with stones on edge - laid along a run of ground.",
  params: {
    height: { kind: "range", default: [1.15, 1.35], min: 0.4, doc: "its height to the cope's foot" },
    base: { kind: "range", default: [0.75, 0.85], min: 0.2, doc: "its thickness at its foot" },
    top: { kind: "range", default: [0.42, 0.5], min: 0.1, doc: "its thickness at its top" },
    cope: { kind: "range", default: [0.24, 0.32], min: 0, doc: "how tall its cope stones stand" },
    throughStones: { kind: "number", default: 0.3, min: 0, doc: "through-stones showing, per metre of each face" },
  },
  parts: ["face", "cope"],
  build(ctx) {
    drystoneWall.line!(ctx, sampleRun());
  },
  line(ctx, run) {
    const { shape, rng } = ctx;
    const face = ctx.paint("face");
    const copePaint = ctx.paint("cope");
    const path = walk(run.points);
    if (path.length < 0.2) return;
    if (run.breach) {
      const n = Math.max(2, Math.ceil(path.length / 1.2));
      const points = Array.from({ length: n + 1 }, (_, k) => path.at((path.length * k) / n));
      body(ctx, points, () => 0.38, 1.5, 0.4, face, ["free", "free"], false);
      if (ctx.far) return;
      // Stones spilled from it, either side.
      const spilled = 2 + Math.floor(rng() * 4);
      for (let k = 0; k < spilled; k++) {
        const s = rng() * path.length;
        const [x, y, z] = path.at(s);
        const [dx, dz] = path.dir(s);
        const side = rng() < 0.5 ? -1 : 1;
        const out = 0.9 + rng() * 0.9;
        const size = 0.18 + rng() * 0.16;
        const turn = rng() * Math.PI;
        shape.box(
          { origin: [x - dz * side * out, y + size * 0.4, z + dx * side * out], x: [Math.cos(turn), 0, Math.sin(turn)], y: [0, 1, 0], z: [-Math.sin(turn), 0, Math.cos(turn)] },
          [size * 1.3, size * 0.7, size],
          face,
          { bottom: false },
        );
      }
      return;
    }
    const h = ctx.range("height");
    const base = ctx.range("base");
    const top = Math.min(base, ctx.range("top"));
    const cope = ctx.range("cope");
    // Its points at its corners and about a metre and a half apart between, its top smoothed over
    // the ground's bumps.
    const stations = path.stations(1.5);
    const n = stations.length - 1;
    const points = stations.map((s) => path.at(s));
    // Stepping down into a breach over its last metre and a half.
    const fall = (s: number): number => {
      let f = 1;
      if (run.ends[0] === "broken") f = Math.min(f, 0.45 + 0.55 * Math.min(1, s / 1.6));
      if (run.ends[1] === "broken") f = Math.min(f, 0.45 + 0.55 * Math.min(1, (path.length - s) / 1.6));
      return f;
    };
    const smooth = points.map((p, k) => {
      const prev = points[Math.max(0, k - 1)][1];
      const next = points[Math.min(points.length - 1, k + 1)][1];
      return (prev + 2 * p[1] + next) / 4;
    });
    const coped = !ctx.far;
    const heightAt = (k: number): number => smooth[k] - points[k][1] + (h + (coped ? 0 : cope * 0.8)) * fall(stations[k]);
    body(ctx, points, heightAt, base, top, face, run.ends, true);
    if (!coped) return;
    // Its top, between its points.
    const topAt = (s: number): number => {
      let k = 0;
      while (k < n - 1 && stations[k + 1] < s) k++;
      const t = Math.max(0, Math.min(1, (s - stations[k]) / Math.max(1e-6, stations[k + 1] - stations[k])));
      return (points[k][1] + heightAt(k)) * (1 - t) + (points[k + 1][1] + heightAt(k + 1)) * t;
    };
    // The cope: stones on edge along its top, each a little different, leaning a little.
    let s = 0;
    while (s < path.length - 0.1) {
      const length = Math.min(path.length - s, 0.24 + rng() * 0.12);
      const mid = s + length / 2;
      if (fall(mid) < 0.98) {
        s += length;
        continue;
      }
      const [x, , z] = path.at(mid);
      const wallTop = topAt(mid);
      const [dx, dz] = path.dir(mid);
      const tall = cope * (0.85 + rng() * 0.3);
      const lean = (rng() - 0.5) * 0.3;
      const frame = { origin: [x, wallTop + tall / 2 - 0.04, z] as Vec3, x: [dx * Math.cos(lean), Math.sin(lean), dz * Math.cos(lean)] as Vec3, y: [-dx * Math.sin(lean), Math.cos(lean), -dz * Math.sin(lean)] as Vec3, z: [-dz, 0, dx] as Vec3 };
      shape.box(frame, [length * 0.46, tall / 2, top / 2 + 0.03 + rng() * 0.03], copePaint, { bottom: false });
      s += length;
    }
    // Through-stones: their ends standing out of either face, a third to a half of the way up.
    const count = Math.round(path.length * ctx.number("throughStones"));
    for (let k = 0; k < count; k++) {
      const at = 0.4 + rng() * (path.length - 0.8);
      const [x, y, z] = path.at(at);
      const [dx, dz] = path.dir(at);
      const up = (0.35 + rng() * 0.2) * h * fall(at);
      const half = base / 2 - (base / 2 - top / 2) * (up / h);
      const side = rng() < 0.5 ? -1 : 1;
      const proud = 0.08 + rng() * 0.06;
      shape.box({ origin: [x - dz * side * (half + proud / 2 - 0.05), y + up, z + dx * side * (half + proud / 2 - 0.05)], x: [dx, 0, dz], y: [0, 1, 0], z: [-dz * side, 0, dx * side] }, [0.13 + rng() * 0.06, 0.08 + rng() * 0.04, proud / 2 + 0.05], face);
    }
  },
};

/**
 * A battered wall's body along `points` (on the ground): its two faces from SINK under the ground up
 * to `heightAt(k)` above each point, `base` thick at the ground and `top` at its top, mitred at each
 * bend; its top; a face across each end that is not joined to the next stretch; and, `collide`, in
 * the way segment by segment. Textured by distance along it and height, so its stones run on round
 * its bends unbroken.
 */
function body(ctx: PropContext, points: Vec3[], heightAt: (k: number) => number, base: number, top: number, paint: Paint, ends: LineRun["ends"], collide: boolean): void {
  const b = ctx.shape.b;
  const n = points.length;
  if (n < 2) return;
  // Each point's flat direction along (between its neighbours) and across, and how far a miter
  // reaches out at a bend.
  const along: [number, number][] = points.map((_, k) => {
    const p = points[Math.max(0, k - 1)];
    const q = points[Math.min(n - 1, k + 1)];
    const dx = q[0] - p[0];
    const dz = q[2] - p[2];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  });
  const miter = points.map((_, k) => {
    if (k === 0 || k === n - 1) return 1;
    const a = points[k - 1];
    const c = points[k + 1];
    const p = points[k];
    const ux = p[0] - a[0], uz = p[2] - a[2];
    const vx = c[0] - p[0], vz = c[2] - p[2];
    const cos = (ux * vx + uz * vz) / ((Math.hypot(ux, uz) * Math.hypot(vx, vz)) || 1);
    return 1 / Math.max(0.5, Math.cos(Math.acos(Math.max(-1, Math.min(1, cos))) / 2));
  });
  const distance = [0];
  for (let k = 1; k < n; k++) distance.push(distance[k - 1] + Math.hypot(points[k][0] - points[k - 1][0], points[k][2] - points[k - 1][2]));
  // A corner: side -1 (left) or 1, at the foot (0) or the top (1).
  const corner = (k: number, side: number, up: 0 | 1): Vec3 => {
    const [dx, dz] = along[k];
    const half = (up ? top : base) / 2 * miter[k];
    const y = points[k][1] + (up ? heightAt(k) : -SINK);
    return [points[k][0] - dz * half * side, y, points[k][2] + dx * half * side];
  };
  const batter = (base - top) / 2;
  for (let k = 0; k + 1 < n; k++) {
    for (const side of [-1, 1]) {
      const normals = [k, k + 1].map((j): Vec3 => {
        const [dx, dz] = along[j];
        const h = heightAt(j) + SINK;
        const l = Math.hypot(1, batter / h);
        return [(-dz * side) / l, batter / h / l, (dx * side) / l];
      });
      const tangent = (j: number): Vec3 => [along[j][0] * -side, 0, along[j][1] * -side];
      const u = (j: number): number => distance[j] * -side;
      b.raw(
        [corner(k, side, 0), corner(k + 1, side, 0), corner(k + 1, side, 1), corner(k, side, 1)],
        [normals[0], normals[1], normals[1], normals[0]],
        [tangent(k), tangent(k + 1), tangent(k + 1), tangent(k)],
        [[u(k), corner(k, side, 0)[1]], [u(k + 1), corner(k + 1, side, 0)[1]], [u(k + 1), corner(k + 1, side, 1)[1]], [u(k), corner(k, side, 1)[1]]],
        paint,
      );
    }
    // Its top.
    const up: Vec3 = [0, 1, 0];
    const t = (j: number): Vec3 => [along[j][0], 0, along[j][1]];
    b.raw(
      [corner(k, -1, 1), corner(k + 1, -1, 1), corner(k + 1, 1, 1), corner(k, 1, 1)],
      [up, up, up, up],
      [t(k), t(k + 1), t(k + 1), t(k)],
      [[distance[k], -top / 2], [distance[k + 1], -top / 2], [distance[k + 1], top / 2], [distance[k], top / 2]],
      paint,
    );
    if (collide && ctx.shape.colliders) ctx.shape.solid([corner(k, -1, 0), corner(k, 1, 0), corner(k, -1, 1), corner(k, 1, 1), corner(k + 1, -1, 0), corner(k + 1, 1, 0), corner(k + 1, -1, 1), corner(k + 1, 1, 1)]);
  }
  // Its ends, where it stops rather than running on.
  for (const [end, k, sign] of [[ends[0], 0, -1], [ends[1], n - 1, 1]] as const) {
    if (end === "join") continue;
    const [dx, dz] = along[k];
    const normal: Vec3 = [dx * sign, 0, dz * sign];
    const tangent: Vec3 = [-dz * sign, 0, dx * sign];
    const corners = [corner(k, -1, 0), corner(k, 1, 0), corner(k, 1, 1), corner(k, -1, 1)];
    const across = (c: Vec3): number => (c[0] - points[k][0]) * tangent[0] + (c[2] - points[k][2]) * tangent[2];
    b.raw(corners, corners.map(() => normal), corners.map(() => tangent), corners.map((c): [number, number] => [across(c), c[1]]), paint);
  }
}
