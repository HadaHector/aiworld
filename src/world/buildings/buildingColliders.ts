import type { Vec3 } from "./buildingGeometry";

/**
 * What a building puts in the way, in its own space (see COLLISION.md): boxes - level, square to
 * its axes - and a few convex pieces where a box will not do, a roof or a stair's slope. Coarse on
 * purpose: a wall is a box, a window or a door shut in it is the wall, and the small things - frames,
 * beams, leaves of open doors - are not there at all.
 */
export interface BuildingCollision {
  /** x0, y0, z0, x1, y1, z1 for each box. */
  boxes: Float32Array;
  /** Each piece's points, x, y, z in turn - the piece is their hull. */
  hulls: Float32Array[];
}

export class ColliderBuilder {
  private boxes: number[] = [];
  private hulls: Float32Array[] = [];

  /** A box between two corners, given either way round; a flat one is left out. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const [xl, xh] = x0 < x1 ? [x0, x1] : [x1, x0];
    const [yl, yh] = y0 < y1 ? [y0, y1] : [y1, y0];
    const [zl, zh] = z0 < z1 ? [z0, z1] : [z1, z0];
    if (xh - xl < 1e-3 || yh - yl < 1e-3 || zh - zl < 1e-3) return;
    this.boxes.push(xl, yl, zl, xh, yh, zh);
  }

  /** A convex piece: the hull of these points. */
  hull(points: Vec3[]): void {
    this.hulls.push(new Float32Array(points.flat()));
  }

  finish(): BuildingCollision {
    return { boxes: new Float32Array(this.boxes), hulls: this.hulls };
  }
}

/**
 * A wall as boxes: from `c0` to `c1` across it, `a0` to `a1` along it (x for a wall along x, else
 * z), `y0` to `y1` up - less the holes through it.
 */
export function wallBoxes(
  colliders: ColliderBuilder,
  alongX: boolean,
  c0: number,
  c1: number,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  holes: readonly { a0: number; a1: number; y0: number; y1: number }[],
): void {
  const piece = (p0: number, p1: number, q0: number, q1: number): void => {
    if (p1 - p0 < 1e-3 || q1 - q0 < 1e-3) return;
    if (alongX) colliders.box(p0, q0, c0, p1, q1, c1);
    else colliders.box(c0, q0, p0, c1, q1, p1);
  };
  let from = a0;
  for (const hole of [...holes].sort((p, q) => p.a0 - q.a0)) {
    const h0 = Math.max(a0, hole.a0);
    const h1 = Math.min(a1, hole.a1);
    if (h1 <= h0) continue;
    piece(from, h0, y0, y1);
    piece(h0, h1, y0, Math.max(y0, hole.y0));
    piece(h0, h1, Math.min(y1, hole.y1), y1);
    from = h1;
  }
  piece(from, a1, y0, y1);
}
