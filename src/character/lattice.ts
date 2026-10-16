import type { LatticeDef } from "./raceDef";
import type { Vec } from "./skeleton";

export interface Lattice {
  /** Where a point of the undeformed body goes. */
  apply: (p: Vec) => Vec;
  /** The control points as they end up, for drawing: [x][y][z]. */
  points: () => Vec[][][];
}

function binomial(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** The n+1 Bernstein weights of degree n at s (0..1). */
function bernstein(n: number, s: number): number[] {
  const w: number[] = [];
  for (let i = 0; i <= n; i++) w.push(binomial(n, i) * s ** i * (1 - s) ** (n - i));
  return w;
}

/**
 * A free-form deformation over a box (Sederberg and Parry): every point inside moves by a blend of
 * how far the control points round it were moved, with Bernstein weights, so the result is smooth
 * across the whole box whatever bones and patches it crosses. An unmoved lattice changes nothing.
 * Points outside the box are clamped to its edge for weighting.
 */
export function createLattice(def: LatticeDef, min: Vec, max: Vec): Lattice {
  const [nx, ny, nz] = def.divisions;
  const moves = new Map<string, Vec>();
  const key = (i: number, j: number, k: number): string => `${i},${j},${k}`;
  const addMove = (i: number, j: number, k: number, by: Vec): void => {
    const at = key(i, j, k);
    const had = moves.get(at) ?? [0, 0, 0];
    moves.set(at, [had[0] + by[0], had[1] + by[1], had[2] + by[2]]);
  };
  for (const move of def.moves) {
    const [i, j, k] = move.at;
    addMove(i, j, k, move.by);
    const mirrorI = nx - 1 - i;
    if (def.mirror && mirrorI !== i) addMove(mirrorI, j, k, [-move.by[0], move.by[1], move.by[2]]);
  }
  const moved = [...moves].map(([at, by]) => ({ at: at.split(",").map(Number) as Vec, by }));
  const local = (p: Vec, axis: number): number => Math.min(1, Math.max(0, (p[axis] - min[axis]) / Math.max(1e-9, max[axis] - min[axis])));

  return {
    apply(p) {
      if (moved.length === 0) return p;
      const wx = bernstein(nx - 1, local(p, 0));
      const wy = bernstein(ny - 1, local(p, 1));
      const wz = bernstein(nz - 1, local(p, 2));
      const out: Vec = [p[0], p[1], p[2]];
      for (const { at, by } of moved) {
        const w = wx[at[0]] * wy[at[1]] * wz[at[2]];
        out[0] += by[0] * w;
        out[1] += by[1] * w;
        out[2] += by[2] * w;
      }
      return out;
    },
    points() {
      const grid: Vec[][][] = [];
      for (let i = 0; i < nx; i++) {
        grid.push([]);
        for (let j = 0; j < ny; j++) {
          grid[i].push([]);
          for (let k = 0; k < nz; k++) {
            const by = moves.get(key(i, j, k)) ?? [0, 0, 0];
            const at = (n: number, axis: number, index: number): number => min[axis] + ((max[axis] - min[axis]) * index) / (n - 1);
            grid[i][j].push([at(nx, 0, i) + by[0], at(ny, 1, j) + by[1], at(nz, 2, k) + by[2]]);
          }
        }
      }
      return grid;
    },
  };
}
