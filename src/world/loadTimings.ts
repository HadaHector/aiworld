// How long each step of shaping the world took, and how many terrain samples it asked for - for
// seeing where a slow start goes. Logged to the console as each step ends (see timed).

export interface LoadTiming {
  step: string;
  ms: number;
  /** Terrain samples taken during the step. */
  samples: number;
}

export const loadTimings: LoadTiming[] = [];

/** Bumped by every terrain sample (terrainSampler.ts). */
export const sampleCounter = { count: 0 };

/** Runs a step of the world's shaping, timing it. */
export function timed<T>(step: string, run: () => T): T {
  const started = performance.now();
  const samplesBefore = sampleCounter.count;
  const result = run();
  const timing = { step, ms: performance.now() - started, samples: sampleCounter.count - samplesBefore };
  loadTimings.push(timing);
  console.info(`[shaping] ${step}: ${(timing.ms / 1000).toFixed(2)} s, ${timing.samples.toLocaleString()} terrain samples`);
  return result;
}
