import { isObject, joinPath, type RawObject, type Reader } from "./contentReader";

/**
 * Rolls a biome file for one area, so no two forests are quite the same forest.
 *
 * A biome may write, anywhere a value goes:
 *  - `{ range: [min, max] }` - a number between the two (`integer: true` for a whole one);
 *  - `{ between: [colourA, colourB] }` - a colour on the line between the two;
 *  - `{ oneOf: [a, b, ...] }` - one of the options, each as likely; `null` among them leaves the
 *    field out altogether (an area with no settlements, say);
 *  - `chance: p` on any object - it is kept with probability p and dropped otherwise, taken out of
 *    the list it is in or the field that holds it (a layer, a bush, a whole `bushes` block);
 *  - `{ param: name, to: [a, b] }` - one of the biome's own `params`, mapped from 0-1 onto a to b
 *    (numbers or colours); without `to`, the param itself.
 *
 * A biome's top-level `params` - `{ snow: { range: [0, 1] } }` - are rolled first, once for the
 * area, and are not part of the rolled biome: they are there so that several values can follow one
 * roll. Snow on the ground and snow on the trees read the same `snow`, so a lightly snowed area is
 * light on both, instead of a white wood over bare ground.
 *
 * Rolling runs on the file as written, before its generators expand, so a generator's parameters
 * roll like anything else; the rolled file is then read exactly as an unrolled one would be. An
 * option may itself hold rolls - they are rolled after it is picked.
 */
export interface Roller {
  /** A number in [min, max]. */
  number(min: number, max: number, integer: boolean): number;
  /** An option out of `count`. */
  pick(count: number): number;
  /** Whether a `chance: p` object is kept. */
  keep(chance: number): boolean;
  /** How far between two colours, 0-1. */
  mix(): number;
}

/** An area's roll. */
export function randomRoller(random: () => number): Roller {
  return {
    number: (min, max, integer) => (integer ? min + Math.floor(random() * (max - min + 1)) : min + random() * (max - min)),
    pick: (count) => Math.min(count - 1, Math.floor(random() * count)),
    keep: (chance) => random() < chance,
    mix: () => random(),
  };
}

/** A biome as it is when not rolled for an area - the middle of every range, the first option, and
 *  everything with a chance kept. What the workbench shows, and what a biome's name and spawn
 *  weight are read from. */
export const MIDDLE_ROLLER: Roller = {
  number: (min, max, integer) => (integer ? Math.round((min + max) / 2) : (min + max) / 2),
  pick: () => 0,
  keep: () => true,
  mix: () => 0.5,
};

/**
 * One of the rolls a biome is checked with when the packs load: `plan` 0 takes every range's low
 * end and keeps every chance, 1 the high ends and drops them, and so on alternately, while option
 * `plan` of every oneOf is picked (wrapping) - so between them every option and every extreme is
 * read at least once, and a roll that could break the biome is reported at load, not in some area.
 */
export function checkRoller(plan: number): Roller {
  const low = plan % 2 === 0;
  return {
    number: (min, max) => (low ? min : max),
    pick: (count) => plan % count,
    keep: () => low,
    mix: () => (low ? 0 : 1),
  };
}

/** How many check rolls reach every option of `value`'s largest oneOf, and both extremes. */
export function checkPlans(value: unknown): number {
  let most = 2;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (isObject(node)) {
      if (Array.isArray(node.oneOf)) most = Math.max(most, node.oneOf.length);
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return most;
}

/** Said with a check roll's problems, so an author knows which roll broke. */
export function describeCheckPlan(plan: number): string {
  return `rolled with ranges at their ${plan % 2 === 0 ? "low" : "high"} ends, chance entries ${plan % 2 === 0 ? "kept" : "dropped"}, and option ${plan + 1} of each oneOf`;
}

/** Marks a value `roll` found should be left out of whatever holds it. */
const DROPPED = Symbol("dropped");

/** `value` rolled; malformed rolls are reported to `reader` and left out. */
export function rollValue(value: unknown, roller: Roller, reader: Reader, path = ""): unknown {
  let params: Params = new Map();
  let body = value;
  if (isObject(value) && "params" in value) {
    const { params: source, ...rest } = value;
    params = rollParams(source, roller, reader, joinPath(path, "params"));
    body = rest;
  }
  const rolled = roll(body, roller, reader, path, params);
  return rolled === DROPPED ? undefined : rolled;
}

/** A biome's params, rolled for the area. */
type Params = Map<string, number>;

function rollParams(source: unknown, roller: Roller, reader: Reader, path: string): Params {
  const params: Params = new Map();
  if (!isObject(source)) {
    reader.fail(path, "expected { name: value, ... }");
    return params;
  }
  for (const [name, spec] of Object.entries(source)) {
    const value = roll(spec, roller, reader, joinPath(path, name), params);
    if (typeof value === "number" && Number.isFinite(value)) params.set(name, value);
    else if (value !== DROPPED) reader.fail(joinPath(path, name), "expected a number (or a roll of one)");
  }
  return params;
}

function roll(value: unknown, roller: Roller, reader: Reader, path: string, params: Params): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => roll(item, roller, reader, joinPath(path, i), params)).filter((item) => item !== DROPPED);
  }
  if (!isObject(value)) return value;

  if ("param" in value) return readParam(value, params, reader, path);
  if ("range" in value) return rollRange(value, roller, reader, path);
  if ("between" in value) return rollBetween(value, roller, reader, path);
  if ("oneOf" in value) {
    if (Object.keys(value).length !== 1 || !Array.isArray(value.oneOf) || value.oneOf.length === 0) {
      reader.fail(path, "expected { oneOf: [option, option, ...] } and nothing else");
      return DROPPED;
    }
    const index = roller.pick(value.oneOf.length);
    const option = value.oneOf[index];
    return option === null ? DROPPED : roll(option, roller, reader, joinPath(joinPath(path, "oneOf"), index), params);
  }

  let source: RawObject = value;
  if ("chance" in value) {
    const chance = value.chance;
    if (typeof chance !== "number" || !(chance >= 0 && chance <= 1)) {
      reader.fail(joinPath(path, "chance"), "expected a chance from 0 to 1");
    } else if (!roller.keep(chance)) {
      return DROPPED;
    }
    const { chance: _, ...rest } = value;
    source = rest;
  }

  const result: RawObject = {};
  for (const [key, child] of Object.entries(source)) {
    const rolled = roll(child, roller, reader, joinPath(path, key), params);
    if (rolled !== DROPPED) result[key] = rolled;
  }
  return result;
}

function readParam(value: RawObject, params: Params, reader: Reader, path: string): unknown {
  const extra = Object.keys(value).filter((key) => key !== "param" && key !== "to");
  const name = value.param;
  const known = typeof name === "string" ? params.get(name) : undefined;
  if (extra.length > 0 || known === undefined) {
    reader.fail(path, `expected { param: name, to?: [a, b] } naming one of the biome's params (${[...params.keys()].join(", ") || "it has none"})`);
    return DROPPED;
  }
  if (value.to === undefined) return known;
  const to = value.to;
  if (Array.isArray(to) && to.length === 2 && to.every((end) => typeof end === "number" && Number.isFinite(end))) {
    return to[0] + (to[1] - to[0]) * known;
  }
  const colours = Array.isArray(to) && to.length === 2 ? to.map(parseColour) : null;
  if (!colours || colours.some((colour) => colour === null)) {
    reader.fail(joinPath(path, "to"), 'expected [a, b]: two numbers or two colours ("#rrggbb" or [r, g, b])');
    return DROPPED;
  }
  const [a, b] = colours as [number, number, number][];
  return a.map((channel, i) => channel + (b[i] - channel) * known);
}

function rollRange(value: RawObject, roller: Roller, reader: Reader, path: string): unknown {
  const extra = Object.keys(value).filter((key) => key !== "range" && key !== "integer");
  const range = value.range;
  const integer = value.integer === true;
  if (
    extra.length > 0 ||
    (value.integer !== undefined && typeof value.integer !== "boolean") ||
    !Array.isArray(range) ||
    range.length !== 2 ||
    !range.every((bound) => typeof bound === "number" && Number.isFinite(bound)) ||
    range[0] > range[1] ||
    (integer && !range.every(Number.isInteger))
  ) {
    reader.fail(path, "expected { range: [min, max] } (min ≤ max, whole numbers with integer: true)");
    return DROPPED;
  }
  return roller.number(range[0], range[1], integer);
}

function rollBetween(value: RawObject, roller: Roller, reader: Reader, path: string): unknown {
  const pair = value.between;
  const colours = Object.keys(value).length === 1 && Array.isArray(pair) && pair.length === 2 ? pair.map(parseColour) : null;
  if (!colours || colours.some((colour) => colour === null)) {
    reader.fail(path, 'expected { between: [colour, colour] } ("#rrggbb" or [r, g, b])');
    return DROPPED;
  }
  const [a, b] = colours as [number, number, number][];
  const t = roller.mix();
  return a.map((channel, i) => channel + (b[i] - channel) * t);
}

function parseColour(value: unknown): [number, number, number] | null {
  if (typeof value === "string") {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
    return match ? [parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255] : null;
  }
  if (Array.isArray(value) && value.length === 3 && value.every((c) => typeof c === "number" && Number.isFinite(c))) {
    return [value[0], value[1], value[2]];
  }
  return null;
}
