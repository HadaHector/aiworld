import type { Scene } from "@babylonjs/core";
import { takeCollisionStats, type CollisionStats } from "../world/collision/index";
import type { WorldCollision } from "../world/worldCollision";
import type { StatsPanel } from "./statsPanel";

const REFRESH_MS = 500;

/** One refresh window's worth of the collision counters, and the worst single frame in it. */
export interface CollisionProfile {
  frames: number;
  /** Per frame, averaged over the window. */
  perFrame: CollisionStats;
  /** The worst frame's player update, motor and chunk-collision time, ms. */
  worstPlayerMs: number;
  worstMotorMs: number;
  worstChunkMs: number;
  /** Chunks with their collision in, and the shapes they hold. */
  chunks: number;
  shapes: number;
}

export interface CollisionPanel {
  /** Time spent on the player's update this frame, collision or not (main.ts measures it). */
  addPlayerMs: (ms: number) => void;
  /** The last window's numbers - for the console. */
  readonly last: CollisionProfile | null;
}

/**
 * A simple profiler for the collision system, a section of the stats panel: every half second, what it cost per frame - the
 * player's update and its motor within it, the queries asked and the pair tests and GJK runs they
 * took - and what building chunks' collision cost as they streamed in. Counters come from
 * world/collision/stats.ts.
 */
export function createCollisionPanel(scene: Scene, collision: WorldCollision, stats: StatsPanel): CollisionPanel {
  const container = document.createElement("div");
  container.style.cssText = `
    font-family: ui-monospace, Consolas, monospace; font-size: 11px;
    white-space: pre; font-variant-numeric: tabular-nums; line-height: 1.45;
  `;
  container.textContent = "collision -";
  stats.addSection("Collision", container);

  let sums: CollisionStats | null = null;
  let frames = 0;
  let playerMs = 0;
  let worstPlayerMs = 0;
  let worstMotorMs = 0;
  let worstChunkMs = 0;
  let windowStart = performance.now();
  let last: CollisionProfile | null = null;

  scene.onAfterRenderObservable.add(() => {
    const frame = takeCollisionStats();
    if (sums === null) sums = { ...frame };
    else for (const key of Object.keys(frame) as (keyof CollisionStats)[]) sums[key] += frame[key];
    frames++;
    worstPlayerMs = Math.max(worstPlayerMs, playerMs);
    worstMotorMs = Math.max(worstMotorMs, frame.motorMs);
    worstChunkMs = Math.max(worstChunkMs, frame.chunkMs);
    playerMs = 0;

    const now = performance.now();
    if (now - windowStart < REFRESH_MS || sums === null) return;
    const seconds = (now - windowStart) / 1000;
    const totals: CollisionStats = sums;
    const perFrame = { ...totals };
    for (const key of Object.keys(perFrame) as (keyof CollisionStats)[]) perFrame[key] /= frames;
    last = { frames, perFrame, worstPlayerMs, worstMotorMs, worstChunkMs, chunks: collision.chunkCount, shapes: collision.shapeCount };
    if (container.style.display !== "none") container.textContent = describe(last, totals, seconds);
    sums = null;
    frames = 0;
    worstPlayerMs = worstMotorMs = worstChunkMs = 0;
    windowStart = now;
  });

  return {
    addPlayerMs(ms) {
      playerMs += ms;
    },
    get last() {
      return last;
    },
  };
}

function describe(p: CollisionProfile, totals: CollisionStats, seconds: number): string {
  const f = p.perFrame;
  const ms = (n: number): string => n.toFixed(2).padStart(5);
  const n = (v: number): string => (v >= 100 ? v.toFixed(0) : v.toFixed(1)).padStart(5);
  const gjkIterations = f.gjkCalls > 0 ? f.gjkIterations / f.gjkCalls : 0;
  const chunkEach = totals.chunksBuilt > 0 ? totals.chunkMs / totals.chunksBuilt : 0;
  const batchEach = totals.batchesAdded > 0 ? totals.batchMs / totals.batchesAdded : 0;
  return [
    `collision · ${p.chunks} chunks · ${p.shapes.toLocaleString()} shapes`,
    `player  ${ms(f.motorMs)} ms motor (worst ${ms(p.worstMotorMs)})  · ${ms(p.worstPlayerMs)} worst whole update`,
    `queries ${n(f.sweeps)} sweeps · ${n(f.overlaps)} overlaps · ${n(f.rays)} rays          a frame`,
    `tests   ${n(f.pairs)} pairs  · ${n(f.advances)} advances · ${n(f.gjkCalls)} GJK (${gjkIterations.toFixed(1)} it)  a frame`,
    totals.chunksBuilt > 0
      ? `chunks  ${(totals.chunksBuilt / seconds).toFixed(1)}/s built · ${ms(chunkEach)} ms each (batch ${ms(batchEach)}) · worst frame ${ms(p.worstChunkMs)}`
      : `chunks  none built lately`,
  ].join("\n");
}
