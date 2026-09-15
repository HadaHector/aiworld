import { mulberry32, deriveSeed } from "../rng";
import type { CellPoint } from "./cellGrid";
import { START_CELL_SALT, GROWTH_SALT } from "./config";

function weightedPick(rng: () => number, candidates: number[], weights: number[]): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = rng() * total;

  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }

  return candidates[candidates.length - 1];
}

/** Picks a cell near (centerX, centerZ) to anchor the landmass close to world origin. */
export function pickStartCell(seed: number, points: CellPoint[], centerX: number, centerZ: number, spacing: number): number {
  const rng = mulberry32(deriveSeed(seed, START_CELL_SALT));
  const maxDistSq = (spacing * 1.5) ** 2;

  const candidates = points
    .map((p, index) => ({ index, distSq: (p.x - centerX) ** 2 + (p.z - centerZ) ** 2 }))
    .filter((c) => c.distSq <= maxDistSq)
    .map((c) => c.index);

  if (candidates.length === 0) {
    // Fallback: closest point to center, guaranteed to exist for any non-empty point set.
    let closest = 0;
    let closestDistSq = Infinity;
    points.forEach((p, index) => {
      const distSq = (p.x - centerX) ** 2 + (p.z - centerZ) ** 2;
      if (distSq < closestDistSq) {
        closestDistSq = distSq;
        closest = index;
      }
    });
    return closest;
  }

  return candidates[Math.floor(rng() * candidates.length)];
}

/**
 * Frontier-based randomized BFS, weighted toward candidates touching more already-selected
 * neighbors — biases growth toward compact, believable blobs while staying genuinely randomized.
 */
export function growLandmass(seed: number, adjacency: number[][], startIndex: number, targetCount: number): Set<number> {
  const rng = mulberry32(deriveSeed(seed, GROWTH_SALT));
  const selected = new Set<number>([startIndex]);
  const frontier = new Set<number>(adjacency[startIndex]);

  while (selected.size < targetCount && frontier.size > 0) {
    const candidates = [...frontier];
    const weights = candidates.map((c) => {
      const sharedSelectedNeighbors = adjacency[c].filter((n) => selected.has(n)).length;
      return 1 + sharedSelectedNeighbors * sharedSelectedNeighbors;
    });

    const picked = weightedPick(rng, candidates, weights);
    selected.add(picked);
    frontier.delete(picked);

    for (const n of adjacency[picked]) {
      if (!selected.has(n)) frontier.add(n);
    }
  }

  return selected;
}
