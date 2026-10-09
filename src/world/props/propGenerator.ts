import { ModelBuilder, roll, rollInt, pick } from "../buildings/buildingGeometry";
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
  /** A setting's raw [lo, hi], for a generator that rolls it more than once (a size per log). */
  bounds(name: string): [number, number];
}

/**
 * A prop generator: the settings it takes (each with its default, if it has one), the parts it is
 * painted by, and how it builds - its model standing on y 0, its front toward +z.
 */
export interface PropGenerator {
  doc: string;
  params: Record<string, PropParam>;
  parts: string[];
  build(ctx: PropContext): void;
}

/** A prop's model: built from its seed and variant, the same every time - `far`: coarser, its
 *  small pieces left out, and no colliders. */
export function generateProp(def: PropDef, seed: number, variant: number, far = false): BuildingModel {
  const generator = PROP_GENERATORS[def.generator];
  let hash = 0;
  for (let i = 0; i < def.id.length; i++) hash = (Math.imul(hash, 31) + def.id.charCodeAt(i)) | 0;
  const rng = mulberry32(deriveSeed(deriveSeed(seed, hash), variant));
  const b = new ModelBuilder();
  const colliders = def.collide && !far ? new ColliderBuilder() : null;
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
    bounds: (name) => s[name] as [number, number],
  };
  generator.build(ctx);
  const model = b.finish({ x: 0, z: Math.max(Math.abs(b.minZ), Math.abs(b.maxZ)) });
  if (colliders) model.colliders = colliders.finish();
  return model;
}
