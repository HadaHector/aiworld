import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";

/** One thing wrong with a pack: which file, where in it, and what. */
export interface ContentIssue {
  file: string;
  path: string;
  message: string;
}

/** Thrown when the packs cannot be turned into a world. Carries every problem found, not just the
 *  first, so a pack author can fix them all in one pass. */
export class ContentError extends Error {
  readonly issues: ContentIssue[];

  constructor(issues: ContentIssue[]) {
    super(`${issues.length} problem${issues.length === 1 ? "" : "s"} in the content packs:\n${issues.map(formatIssue).join("\n")}`);
    this.name = "ContentError";
    this.issues = issues;
  }
}

export function formatIssue(issue: ContentIssue): string {
  return issue.path ? `${issue.file} > ${issue.path}: ${issue.message}` : `${issue.file}: ${issue.message}`;
}

export type RawObject = Record<string, unknown>;

export function isObject(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

/**
 * Reads values out of one parsed pack file, checking each as it goes. A value that is missing or
 * wrong is reported with its path and replaced by a harmless placeholder, so reading carries on and
 * reports everything else wrong with the file too - the caller checks `issues` at the end.
 */
export class Reader {
  readonly issues: ContentIssue[];
  readonly file: string;

  constructor(issues: ContentIssue[], file: string) {
    this.issues = issues;
    this.file = file;
  }

  fail(path: string, message: string): void {
    this.issues.push({ file: this.file, path, message });
  }

  /** Reports any key not in `allowed` - almost always a typo, which would otherwise silently fall
   *  back to a default and leave the author wondering why their setting does nothing. */
  onlyKeys(obj: RawObject, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) this.fail(join(path, key), `unknown field (expected one of: ${allowed.join(", ")})`);
    }
  }

  object(value: unknown, path: string): RawObject {
    if (isObject(value)) return value;
    this.fail(path, `expected an object, got ${describe(value)}`);
    return {};
  }

  has(obj: RawObject, key: string): boolean {
    return obj[key] !== undefined;
  }

  number(obj: RawObject, key: string, path: string, options: { min?: number; max?: number; integer?: boolean } = {}): number {
    const value = obj[key];
    const at = join(path, key);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.fail(at, value === undefined ? "required number is missing" : `expected a number, got ${describe(value)}`);
      return 0;
    }
    if (options.integer && !Number.isInteger(value)) this.fail(at, `expected a whole number, got ${value}`);
    if (options.min !== undefined && value < options.min) this.fail(at, `must be at least ${options.min}, got ${value}`);
    if (options.max !== undefined && value > options.max) this.fail(at, `must be at most ${options.max}, got ${value}`);
    return value;
  }

  optionalNumber(obj: RawObject, key: string, path: string, fallback: number, options: { min?: number; max?: number; integer?: boolean } = {}): number {
    return obj[key] === undefined ? fallback : this.number(obj, key, path, options);
  }

  /** A [low, high] pair of numbers, low below high (or equal, with allowEqual). */
  range(obj: RawObject, key: string, path: string, options: { allowEqual?: boolean } = {}): [number, number] {
    const value = obj[key];
    const at = join(path, key);
    if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === "number" && Number.isFinite(v))) {
      this.fail(at, value === undefined ? "required [low, high] range is missing" : `expected [low, high], got ${describe(value)}`);
      return [0, 1];
    }
    const [low, high] = value as [number, number];
    if (options.allowEqual ? low > high : low >= high) this.fail(at, `the first value must be below the second, got [${low}, ${high}]`);
    return [low, high];
  }

  string(obj: RawObject, key: string, path: string): string {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
    this.fail(join(path, key), value === undefined ? "required text is missing" : `expected text, got ${describe(value)}`);
    return "";
  }

  optionalString(obj: RawObject, key: string, path: string): string | undefined {
    return obj[key] === undefined ? undefined : this.string(obj, key, path);
  }

  boolean(obj: RawObject, key: string, path: string, fallback: boolean): boolean {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    this.fail(join(path, key), `expected true or false, got ${describe(value)}`);
    return fallback;
  }

  oneOf<T extends string>(obj: RawObject, key: string, path: string, options: readonly T[]): T {
    const value = obj[key];
    if (typeof value === "string" && (options as readonly string[]).includes(value)) return value as T;
    this.fail(join(path, key), `expected one of ${options.map((o) => `"${o}"`).join(", ")}, got ${describe(value)}`);
    return options[0];
  }

  array(obj: RawObject, key: string, path: string): unknown[] {
    const value = obj[key];
    if (Array.isArray(value)) return value;
    this.fail(join(path, key), value === undefined ? "required list is missing" : `expected a list, got ${describe(value)}`);
    return [];
  }

  optionalArray(obj: RawObject, key: string, path: string): unknown[] {
    return obj[key] === undefined ? [] : this.array(obj, key, path);
  }

  stringList(obj: RawObject, key: string, path: string): string[] {
    return this.array(obj, key, path).map((item, i) => {
      if (typeof item === "string") return item;
      this.fail(join(join(path, key), i), `expected text, got ${describe(item)}`);
      return "";
    });
  }

  /** A colour, written either as "#rrggbb" (0-255 a channel, the way a colour picker gives it) or as
   *  [r, g, b] with 0-1 channels (linear, the way the pipelines compute with them). */
  color(obj: RawObject, key: string, path: string): ColorTuple {
    return this.colorValue(obj[key], join(path, key));
  }

  optionalColor(obj: RawObject, key: string, path: string): ColorTuple | undefined {
    return obj[key] === undefined ? undefined : this.color(obj, key, path);
  }

  colorValue(value: unknown, path: string): ColorTuple {
    if (typeof value === "string") {
      const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
      if (match) return [parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255];
    } else if (Array.isArray(value) && value.length === 3 && value.every((c) => typeof c === "number" && Number.isFinite(c))) {
      return [value[0], value[1], value[2]];
    }
    this.fail(path, `expected a colour ("#rrggbb" or [r, g, b] with 0-1 channels), got ${describe(value)}`);
    return [1, 0, 1];
  }
}

export function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

export { join as joinPath };
