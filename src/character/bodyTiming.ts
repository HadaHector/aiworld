/**
 * Where the time goes when a body is made (dev tool): `__bodyTiming.report()` in the console sums
 * what each stage cost, per body and in all, since `__bodyTiming.reset()`.
 */
interface Stage {
  ms: number;
  count: number;
}
const stages = new Map<string, Stage>();
let bodies = 0;
let latencies: number[] = [];

export function timed<T>(stage: string, work: () => T): T {
  const started = performance.now();
  try {
    return work();
  } finally {
    addTime(stage, performance.now() - started);
  }
}

export function addTime(stage: string, ms: number): void {
  const found = stages.get(stage) ?? { ms: 0, count: 0 };
  found.ms += ms;
  found.count++;
  stages.set(stage, found);
}

/** A body finished, `ms` after its entity asked for it. */
export function bodyDone(ms: number): void {
  bodies++;
  latencies.push(ms);
}

/** What the body caches report, once bodyCache.ts has said how. */
let cacheStats: () => unknown = () => null;
export function registerCacheStats(read: () => unknown): void {
  cacheStats = read;
}

const api = {
  cache: (): unknown => cacheStats(),
  reset(): void {
    stages.clear();
    bodies = 0;
    latencies = [];
  },
  report(): { bodies: number; latency: { mean: number; max: number }; stages: Record<string, { totalMs: number; calls: number; perBodyMs: number }> } {
    const out: Record<string, { totalMs: number; calls: number; perBodyMs: number }> = {};
    for (const [name, s] of [...stages].sort()) out[name] = { totalMs: +s.ms.toFixed(1), calls: s.count, perBodyMs: +(s.ms / Math.max(1, bodies)).toFixed(2) };
    const mean = latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length);
    return { bodies, latency: { mean: +mean.toFixed(0), max: +Math.max(0, ...latencies).toFixed(0) }, stages: out };
  },
};
(globalThis as unknown as { __bodyTiming: typeof api }).__bodyTiming = api;
