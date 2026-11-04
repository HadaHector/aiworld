import { Reader, type ContentIssue } from "../../world/content/contentReader";
import type { ColorTuple } from "../../world/terrain/pipeline/pipelineTypes";

/** `rules/water.json5` (WATER.md): how a body meets water, and how the camera sees from under it. */
export interface WaterRules {
  /** Walking pace's share while swimming. */
  swimSpeed: number;
  /** How deep (metres, from the surface down to the feet) it must be to wade, to swim, and for the
   *  head to be under. */
  wadeDepth: number;
  swimDepth: number;
  headDepth: number;
  /** A swimmer floats with its feet this far under the surface (the head and shoulders out). */
  floatDepth: number;
  /** Metres a second a swimmer rises or dives. */
  verticalSpeed: number;
  /** The view from under the surface: the tint the world is seen through, and how far it is seen. */
  look: { tint: ColorTuple; density: number; surfaceTint: number };
}

interface Entry {
  file: string;
  data: unknown;
}

export function readWaterRules(entry: Entry | undefined, issues: ContentIssue[]): WaterRules {
  const reader = new Reader(issues, entry?.file ?? "rules/water.json5");
  const obj = entry ? reader.object(entry.data, "") : {};
  reader.onlyKeys(obj, "", ["swimSpeed", "wadeDepth", "swimDepth", "headDepth", "floatDepth", "verticalSpeed", "look"]);
  const look = obj.look === undefined ? {} : reader.object(obj.look, "look");
  reader.onlyKeys(look, "look", ["tint", "density", "surfaceTint"]);
  const tint = Array.isArray(look.tint) && look.tint.length === 3 && look.tint.every((n) => typeof n === "number") ? (look.tint as ColorTuple) : ([0.05, 0.26, 0.32] as ColorTuple);
  return {
    swimSpeed: reader.optionalNumber(obj, "swimSpeed", "", 0.6, { min: 0.05 }),
    wadeDepth: reader.optionalNumber(obj, "wadeDepth", "", 0.35, { min: 0 }),
    swimDepth: reader.optionalNumber(obj, "swimDepth", "", 1.2, { min: 0 }),
    headDepth: reader.optionalNumber(obj, "headDepth", "", 1.7, { min: 0 }),
    floatDepth: reader.optionalNumber(obj, "floatDepth", "", 1.35, { min: 0 }),
    verticalSpeed: reader.optionalNumber(obj, "verticalSpeed", "", 3.5, { min: 0 }),
    look: {
      tint,
      density: reader.optionalNumber(look, "density", "look", 0.045, { min: 0 }),
      surfaceTint: reader.optionalNumber(look, "surfaceTint", "look", 0.6, { min: 0, max: 1 }),
    },
  };
}
