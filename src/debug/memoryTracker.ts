/**
 * Where the memory goes: the big buffers on the CPU side, by what made them (see memoryPanel.ts for
 * the GPU side and the page). Two ways in:
 *
 * - `installBufferTracking()` wraps the typed array and ArrayBuffer constructors, so every buffer
 *   of MIN_TRACKED_BYTES or more that is allocated after it - by our code or Babylon's - is counted
 *   under the file and function that asked for it. It costs a little on every typed array made, so
 *   the page only installs it with `?memory` in the URL, before anything else is loaded.
 * - `trackBuffers(kind, ...)` counts buffers that arrive some other way - from a worker, by
 *   structured clone, which no constructor sees. Always on: it is a handful of calls.
 *
 * Buffers are held weakly and counted when a report is asked for, so what has been collected - or
 * transferred to a worker, which empties it here - drops out by itself. Pure: no Babylon, no DOM.
 */

/** Smaller buffers are not worth a stack trace each: noise tables, vectors, a chunk's index list. */
export const MIN_TRACKED_BYTES = 64 * 1024;

const TYPED_ARRAYS = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
] as const;

/** One kind's live buffers of one type, held weakly - keyed by both. */
const groups = new Map<string, { kind: string; type: string; refs: Set<WeakRef<ArrayBufferLike>> }>();
let installed = false;

function add(kind: string, type: string, buffer: ArrayBufferLike): void {
  const key = `${kind}|${type}`;
  let group = groups.get(key);
  if (!group) groups.set(key, (group = { kind, type, refs: new Set() }));
  group.refs.add(new WeakRef(buffer));
  // Pruned now and then even when nobody looks, so the weak refs themselves do not pile up.
  if (group.refs.size % 4096 === 0) prune(group.refs);
}

function prune(refs: Set<WeakRef<ArrayBufferLike>>): void {
  for (const ref of refs) {
    const buffer = ref.deref();
    if (!buffer || buffer.byteLength === 0) refs.delete(ref);
  }
}

/** Counts buffers that came from elsewhere - a worker's result - under `kind`. Views count their
 *  whole underlying buffer, once. */
export function trackBuffers(kind: string, ...buffers: (ArrayBufferView | ArrayBufferLike | null | undefined)[]): void {
  const seen = new Set<ArrayBufferLike>();
  for (const item of buffers) {
    if (!item) continue;
    const buffer = ArrayBuffer.isView(item) ? item.buffer : item;
    if (seen.has(buffer) || buffer.byteLength < MIN_TRACKED_BYTES / 16) continue;
    seen.add(buffer);
    add(kind, item.constructor.name, buffer);
  }
}

/** Every typed array among an object's own values - a worker's result, say. */
export function typedArraysOf(value: object): ArrayBufferView[] {
  return Object.values(value).filter((v): v is ArrayBufferView => ArrayBuffer.isView(v));
}

/** "treeField.ts createTreeField" for the first stack frame outside this file - what made it. */
function callerOf(stack: string | undefined): string {
  const lines = (stack ?? "").split("\n").slice(1);
  for (const line of lines) {
    if (line.includes("memoryTracker")) continue;
    const match = /at (?:new )?([^\s(]+)? ?\(?(.*?):\d+:\d+\)?$/.exec(line.trim());
    if (!match) continue;
    const [, fn, location] = match;
    if (location.includes("node_modules") || location.includes("/deps/")) return `babylon${fn ? ` ${fn.replace(/^.*\./, "")}` : ""}`;
    const file = location.replace(/[?#].*$/, "").replace(/^.*\//, "");
    return fn && !fn.includes("/") ? `${file} ${fn.replace(/^Object\./, "")}` : file;
  }
  return "unknown";
}

/** Whether a typed array's constructor arguments make it allocate storage of its own, rather than
 *  view an existing buffer. */
function allocates(args: unknown[]): boolean {
  const first = args[0];
  return !(first instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && first instanceof SharedArrayBuffer));
}

/**
 * Wraps the constructors (see the file's comment). Call once, before anything allocates; returns
 * whether it is on. Instances are the real typed arrays, so `instanceof` and everything else behave
 * as before - only `x.constructor === Float32Array` would see the difference.
 */
export function installBufferTracking(): boolean {
  if (installed) return true;
  if (typeof Proxy === "undefined" || typeof WeakRef === "undefined") return false;
  const scope = globalThis as unknown as Record<string, unknown>;
  for (const name of TYPED_ARRAYS) {
    const original = scope[name] as (new (...args: unknown[]) => ArrayBufferView) | undefined;
    if (!original) continue;
    const wrapped: object = new Proxy(original, {
      construct(target, args, newTarget) {
        const made = Reflect.construct(target, args, newTarget === wrapped ? target : newTarget) as ArrayBufferView;
        if (made.byteLength >= MIN_TRACKED_BYTES && allocates(args)) add(callerOf(new Error().stack), name, made.buffer);
        return made;
      },
    });
    scope[name] = wrapped;
  }
  const originalBuffer = ArrayBuffer;
  const wrappedBuffer: object = new Proxy(originalBuffer, {
    construct(target, args, newTarget) {
      const made = Reflect.construct(target, args, newTarget === wrappedBuffer ? target : newTarget) as ArrayBuffer;
      if (made.byteLength >= MIN_TRACKED_BYTES) add(callerOf(new Error().stack), "ArrayBuffer", made);
      return made;
    },
  });
  scope.ArrayBuffer = wrappedBuffer;
  installed = true;
  return true;
}

/** Whether the constructors are wrapped - if not, only `trackBuffers`'s kinds are counted. */
export function bufferTrackingInstalled(): boolean {
  return installed;
}

export interface BufferRow {
  kind: string;
  /** The buffers' types, e.g. "Float32Array". */
  type: string;
  count: number;
  bytes: number;
}

/** Every kind with live buffers in it, biggest first. */
export function bufferReport(): BufferRow[] {
  const rows: BufferRow[] = [];
  for (const [key, group] of groups) {
    prune(group.refs);
    let bytes = 0;
    for (const ref of group.refs) bytes += ref.deref()?.byteLength ?? 0;
    if (group.refs.size === 0) {
      groups.delete(key);
      continue;
    }
    rows.push({ kind: group.kind, type: group.type, count: group.refs.size, bytes });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}
