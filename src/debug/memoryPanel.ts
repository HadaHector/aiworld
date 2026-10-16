import type { Engine, Scene } from "@babylonjs/core";
import { bufferReport, bufferTrackingInstalled, type BufferRow } from "./memoryTracker";
import type { StatsPanel } from "./statsPanel";

const REFRESH_MS = 1000;
/** Rows shown per table; the rest are summed into one. */
const ROWS = 14;

/** One group of like things - textures, meshes' vertex data - with how many and how big. */
export interface MemoryRow {
  kind: string;
  type: string;
  count: number;
  bytes: number;
}

export interface MemoryReport {
  /** The page's JS heap (Chrome only): used, what it has taken, and the most it may. */
  heap: { used: number; total: number; limit: number } | null;
  /** Estimated from what Babylon has uploaded: textures, vertex and index data, thin instances. */
  gpu: MemoryRow[];
  /** Big CPU-side buffers by what made them (see memoryTracker.ts). */
  buffers: BufferRow[];
  /** Whether `buffers` covers every big allocation (`?memory`), or only the tracked kinds. */
  allBuffers: boolean;
}

/** A name with its numbers taken out, so "terrainChunk_12_-3_L0" and its kin share a row. */
const familyOf = (name: string): string => name.replace(/-?\d+(\.\d+)?/g, "#").replace(/#(_#)+/g, "#") || "(unnamed)";

/** Bytes a texel takes: channels by format, bytes a channel by type - Babylon's constants. */
function texelBytes(format: number, type: number): number {
  const channels: Record<number, number> = { 0: 1, 1: 1, 2: 2, 4: 3, 5: 4, 6: 1, 7: 2 };
  const depth: Record<number, number> = { 13: 4, 14: 4, 15: 2, 16: 4, 17: 4, 18: 4 };
  if (depth[format]) return depth[format];
  const channelBytes = type === 1 ? 4 : type === 2 ? 2 : 1;
  return (channels[format] ?? 4) * channelBytes;
}

/** Adds `bytes` to a row of `rows`, made if new. */
function count(rows: Map<string, MemoryRow>, kind: string, type: string, bytes: number): void {
  const key = `${type}|${kind}`;
  const row = rows.get(key) ?? { kind, type, count: 0, bytes: 0 };
  row.count++;
  row.bytes += bytes;
  rows.set(key, row);
}

/** What is on the GPU, as near as Babylon lets us tell (render buffers and driver overhead not). */
function gpuReport(engine: Engine, scene: Scene): MemoryRow[] {
  const rows = new Map<string, MemoryRow>();

  // Textures: every one the engine has, named by whichever of the scene's textures uses it.
  const names = new Map<unknown, string>();
  for (const texture of scene.textures) {
    const internal = texture.getInternalTexture();
    if (internal && !names.has(internal)) names.set(internal, texture.name);
  }
  for (const texture of engine.getLoadedTexturesCache()) {
    const layers = texture.is2DArray || texture.is3D ? Math.max(1, texture.depth) : texture.isCube ? 6 : 1;
    const mips = texture.generateMipMaps ? 4 / 3 : 1;
    const bytes = texture.width * texture.height * layers * texelBytes(texture.format, texture.type) * mips * Math.max(1, texture.samples);
    const name = names.get(texture) ?? (texture.url ? texture.url.replace(/^.*\//, "") : `source ${texture.source}`);
    count(rows, familyOf(name), texture.is2DArray ? "texture array" : texture.isCube ? "cube texture" : "texture", bytes);
  }

  // Vertex and index data, once per buffer - geometries can share them.
  const seen = new Set<unknown>();
  const sizeOf = (buffer: { capacity?: number } | null | undefined, fallback: number): number => {
    if (!buffer || seen.has(buffer)) return 0;
    seen.add(buffer);
    return buffer.capacity ?? fallback;
  };
  for (const geometry of scene.geometries) {
    const name = familyOf(geometry.meshes[0]?.name ?? geometry.id);
    let vertexBytes = 0;
    for (const vertexBuffer of Object.values(geometry.getVertexBuffers() ?? {})) {
      const data = vertexBuffer.getData();
      const fallback = !data ? 0 : Array.isArray(data) ? data.length * 4 : data.byteLength;
      vertexBytes += sizeOf(vertexBuffer.getBuffer() as { capacity?: number } | null, fallback);
    }
    if (vertexBytes > 0) count(rows, name, "vertices", vertexBytes);
    const indices = geometry.getIndices(false, true);
    const indexBytes = sizeOf(geometry.getIndexBuffer() as { capacity?: number } | null, (indices?.length ?? 0) * 4);
    if (indexBytes > 0) count(rows, name, "indices", indexBytes);
  }

  // Thin instances: their matrices, and any per-instance data of our own (tints, sway).
  for (const mesh of scene.meshes) {
    const thin = mesh as unknown as {
      _thinInstanceDataStorage?: { matrixData?: Float32Array | null };
      _userThinInstanceBuffersStorage?: { data: Record<string, Float32Array> };
    };
    let bytes = thin._thinInstanceDataStorage?.matrixData?.byteLength ?? 0;
    for (const data of Object.values(thin._userThinInstanceBuffersStorage?.data ?? {})) bytes += data.byteLength;
    if (bytes > 0) count(rows, familyOf(mesh.name), "thin instances", bytes);
  }
  return [...rows.values()].sort((a, b) => b.bytes - a.bytes);
}

/** Everything the panel shows, at once - also what `__aiworld.memory()` returns. */
export function memoryReport(engine: Engine, scene: Scene): MemoryReport {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return {
    heap: memory ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit } : null,
    gpu: gpuReport(engine, scene),
    buffers: bufferReport(),
    allBuffers: bufferTrackingInstalled(),
  };
}

const mb = (bytes: number): string => (bytes / 1024 ** 2).toFixed(1).padStart(8);

/** A table of rows - kind, type, count, MB - the biggest first, the rest summed, and a total. */
function table(title: string, rows: readonly MemoryRow[]): string {
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  const shown = rows.slice(0, ROWS);
  const rest = rows.slice(ROWS);
  const line = (kind: string, type: string, n: number | string, bytes: number): string =>
    `${kind.slice(0, 44).padEnd(44)} ${type.slice(0, 15).padEnd(15)} ${String(n).padStart(6)} ${mb(bytes)} MB`;
  const lines = [`${title.padEnd(60)} ${"count".padStart(6)} ${"size".padStart(11)}`];
  for (const row of shown) lines.push(line(row.kind, row.type, row.count, row.bytes));
  if (rest.length > 0) lines.push(line(`(${rest.length} more)`, "", rest.reduce((n, r) => n + r.count, 0), rest.reduce((n, r) => n + r.bytes, 0)));
  lines.push(line("total", "", rows.reduce((n, r) => n + r.count, 0), total));
  return lines.join("\n");
}

/** The report as text, for the panel and the console. */
export function describeMemory(report: MemoryReport): string {
  const heap = report.heap;
  const parts = [
    heap
      ? [
          `JS heap ${mb(heap.used).trim()} MB used · ${mb(heap.total).trim()} MB taken · limit ${mb(heap.limit).trim()} MB`,
          "(this page's thread, garbage not yet collected included; workers not counted. The CPU",
          " buffers below are part of it; the rest is ordinary objects.)",
        ].join("\n")
      : "JS heap: not reported by this browser",
    "",
    table("GPU, estimated", report.gpu),
    "",
    table(report.allBuffers ? "CPU buffers ≥ 64 KB, by what made them" : "CPU buffers, tracked kinds only (?memory in the URL for all)", report.buffers),
  ];
  return parts.join("\n");
}

/**
 * A section of the stats panel: where the memory goes - the JS heap, what is on the GPU by texture
 * and mesh family, and the big CPU buffers by what made them (memoryTracker.ts). Refreshed once a
 * second while it is open; walking the scene's geometries costs a few ms.
 */
export function createMemoryPanel(engine: Engine, scene: Scene, stats: StatsPanel): void {
  const container = document.createElement("div");
  container.style.cssText = `
    font-family: ui-monospace, Consolas, monospace; font-size: 11px;
    white-space: pre; font-variant-numeric: tabular-nums; line-height: 1.35;
    max-height: 70vh; overflow: auto;
  `;
  container.textContent = "memory -";
  let shown = false;
  let lastRefresh = 0;
  stats.addSection("Memory", container, (on) => {
    shown = on;
    lastRefresh = 0;
  });
  scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    if (!shown || now - lastRefresh < REFRESH_MS) return;
    lastRefresh = now;
    container.textContent = describeMemory(memoryReport(engine, scene));
  });
}
