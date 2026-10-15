import { ModelBuilder, roll, rollInt, pick, type Vec3 } from "../buildings/buildingGeometry";
import { ColliderBuilder } from "../buildings/buildingColliders";
import type { BuildingModel, Paint } from "../buildings/buildingTypes";
import { deriveSeed, mulberry32 } from "../rng";
import { Shaper } from "./propShapes";
import type { PropDef, PropParam, PropSettings } from "./propTypes";
import { PROP_GENERATORS } from "./generators/index";

/**
 * What a prop generator builds with: the shapes (laid into the model and, where the prop is in the
 * way, its colliders), its rolls, its parts' paints, and its settings read as rolled.
 */
export interface PropContext {
  shape: Shaper;
  rng: () => number;
  far: boolean;
  /** A part's paint - the same tint every time it is asked for in one prop. */
  paint(part: string): Paint;
  /** A `range` setting, rolled; a `count`, rolled; a `chance`, tried; a `number`. */
  range(name: string): number;
  count(name: string): number;
  chance(name: string): boolean;
  number(name: string): number;
  /** A `choice` setting: one of its names, picked. */
  choice(name: string): string;
  /** A setting's raw [lo, hi], for a generator that rolls it more than once (a size per log). */
  bounds(name: string): [number, number];
  /** The prop's light (its `light`), burning at `at` - nothing if it gives none, or in the far
   *  model. */
  light(at: Vec3): void;
}

/**
 * A prop generator: the settings it takes (each with its default, if it has one), the parts it is
 * painted by, and how it builds - its model standing on y 0, its front toward +z.
 *
 * A line prop (a wall, a fence) also builds `line`: itself along a run of ground (see LineRun),
 * not set down whole but laid along it. Its `build` is a short straight run of it, for the
 * workbench.
 */
export interface PropGenerator {
  doc: string;
  params: Record<string, PropParam>;
  parts: string[];
  build(ctx: PropContext): void;
  line?(ctx: PropContext, run: LineRun): void;
}

/**
 * A stretch of a line prop: its points along the ground, x, y (the ground's height there) and z, in
 * the model's space, at most a metre or two apart; and how each end is finished - `free` (an end of
 * its own, at a gap or a gate: a pier, an end post), `join` (it carries on into the next stretch: no
 * end), `broken` (falling away into a breach) - and whether it is one: `breach`, what is left of it
 * where it fell (rubble, rails down) - walked over.
 */
export interface LineRun {
  points: Vec3[];
  ends: [LineEnd, LineEnd];
  breach: boolean;
  /** For a line prop that is not set on the ground but carries something (a bridge, its points its
   *  deck): how wide it is, and how low (in the model's space) what it stands on lies - its piers'
   *  feet. */
  width?: number;
  base?: number;
}

export type LineEnd = "free" | "join" | "broken";

/** A prop's model: built from its seed and variant, the same every time - `far`: coarser, its
 *  small pieces left out, and no colliders. */
export function generateProp(def: PropDef, seed: number, variant: number, far = false): BuildingModel {
  return generate(def, seed, variant, far, false);
}

/** Whether a prop is laid along a line (a wall, a fence) rather than set down whole. */
export function isLineProp(def: PropDef): boolean {
  return PROP_GENERATORS[def.generator]?.line !== undefined;
}

/** A line prop's model along one stretch of its run (see LineRun) - the same every time for the same
 *  seed, variant and run. */
export function generateLine(def: PropDef, seed: number, variant: number, run: LineRun, far = false): BuildingModel {
  return generate(def, seed, variant, far, false, run);
}

/** How far a prop reaches either side of its middle and how tall it is - worked out as its model is,
 *  every roll the same, with no geometry kept: what a layout needs to set it down. And how far it
 *  reaches each way on its own - `bounds`, [minX, maxX, minZ, maxZ] - for one that reaches further
 *  forward than back (a fireplace's hearth stone), to stand its real back against a wall. */
export function measureProp(def: PropDef, seed: number, variant: number): { halfWidth: number; halfDepth: number; height: number; bounds: [number, number, number, number] } {
  const { halfWidth, halfDepth, height, bounds } = generate(def, seed, variant, false, true);
  return { halfWidth, halfDepth, height, bounds: bounds! };
}

function generate(def: PropDef, seed: number, variant: number, far: boolean, measure: boolean, run?: LineRun): BuildingModel & { bounds?: [number, number, number, number] } {
  const generator = PROP_GENERATORS[def.generator];
  let hash = 0;
  for (let i = 0; i < def.id.length; i++) hash = (Math.imul(hash, 31) + def.id.charCodeAt(i)) | 0;
  const rng = mulberry32(deriveSeed(deriveSeed(seed, hash), variant));
  const b = new ModelBuilder(measure);
  const colliders = def.collide && !far && !measure ? new ColliderBuilder() : null;
  const paints = new Map<string, Paint>();
  const s: PropSettings = def.settings;
  const ctx: PropContext = {
    shape: new Shaper(b, colliders, far),
    rng,
    far,
    paint(part) {
      let paint = paints.get(part);
      if (!paint) {
        const spec = def.parts[part];
        paint = { material: spec.material, tint: pick(spec.tints, rng) };
        paints.set(part, paint);
      }
      return paint;
    },
    range: (name) => roll(s[name] as [number, number], rng),
    count: (name) => rollInt(s[name] as [number, number], rng),
    chance: (name) => rng() < (s[name] as number),
    number: (name) => s[name] as number,
    choice: (name) => pick(s[name] as string[], rng),
    bounds: (name) => s[name] as [number, number],
    light(at) {
      if (def.light && !far && !measure) b.lights.push({ position: at, ...def.light, sky: false, facing: null });
    },
  };
  if (run) generator.line!(ctx, run);
  else generator.build(ctx);
  const model = b.finish({ x: 0, z: Math.max(Math.abs(b.minZ), Math.abs(b.maxZ)) });
  if (colliders) model.colliders = colliders.finish();
  return measure ? { ...model, bounds: [b.minX, b.maxX, b.minZ, b.maxZ] } : model;
}
