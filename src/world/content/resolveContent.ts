import JSON5 from "json5";
import type { BiomeDayNight, BiomeDefinition, BorderType, BoundaryHillStyle } from "../biomes/biomeTypes";
import type { MaterialDef, MaterialLayer } from "../materials/materialTypes";
import type { GrassKindDef } from "../foliage/grassConfig";
import {
  FOLIAGE_BUILDERS,
  TREE_CROWN_BUILDERS,
  type BranchingTree,
  type PrimitiveTree,
  type TreeCrown,
  type TreeKindDef,
  type TreeRules,
} from "../foliage/foliageConfig";
import type { Voice } from "../naming/nameGenerator";
import {
  WALL_TEXTURE_BUILDERS,
  type HouseVariant,
  type SettlementStyle,
  type SettlementTier,
  type SettlementTierDef,
} from "../settlements/settlementConfig";
import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";
import { coolNightTone, deriveNightIntensity } from "../lighting/dayNightMath";
import { ContentError, isObject, joinPath, Reader, type ContentIssue, type RawObject } from "./contentReader";
import { expandGenerators, FAILED_GENERATOR } from "./generators";
import { readPipeline } from "./pipelineReader";
import type { WorldContent } from "./worldContent";
import type { TextureDef } from "../materials/textureGen";

/** One pack as found on disk: its folder name and every .json5 file in it, by path inside it. */
export interface PackSource {
  id: string;
  files: { path: string; text: string }[];
}

/** The folders a pack's content lives in, one kind of definition each. A definition's id is its
 *  file name, and a pack with a higher priority replaces a lower one's definition of the same id. */
const CONTENT_FOLDERS = ["biomes", "materials", "layers", "grass", "trees", "voices", "borderHills", "settlements"] as const;
type ContentFolder = (typeof CONTENT_FOLDERS)[number];

/** Instances are tagged with kind * 16 + scale (foliage/grassScatter.ts), which leaves room for 16. */
const MAX_GRASS_KINDS = 16;

const BORDER_TYPES: readonly BorderType[] = ["smooth", "mountain", "river", "cliff", "wall"];
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface Entry {
  id: string;
  /** "pack/folder/id.json5" - what problems are reported against. */
  file: string;
  data: unknown;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseFile(file: string, text: string, issues: ContentIssue[]): unknown {
  try {
    return JSON5.parse(text);
  } catch (error) {
    const e = error as { lineNumber?: number; columnNumber?: number; message?: string };
    const where = e.lineNumber !== undefined ? `line ${e.lineNumber}, column ${e.columnNumber}` : "";
    issues.push({ file, path: where, message: (e.message ?? String(error)).replace(/^JSON5: /, "").replace(/ at \d+:\d+$/, "") });
    return undefined;
  }
}

/**
 * Turns the packs into one WorldContent: parses every file, lets higher-priority packs replace
 * definitions by id, applies patches, expands generators, and checks every field and every
 * reference between definitions. Throws a ContentError listing every problem found.
 */
export function resolveContent(packs: PackSource[]): WorldContent {
  const issues: ContentIssue[] = [];

  // --- pack order ---
  const ordered = packs
    .map((pack) => {
      const manifestFile = pack.files.find((f) => f.path === "pack.json5");
      const file = `${pack.id}/pack.json5`;
      if (!manifestFile) {
        issues.push({ file, path: "", message: "every pack needs a pack.json5" });
        return { pack, priority: 0 };
      }
      const reader = new Reader(issues, file);
      const manifest = reader.object(parseFile(file, manifestFile.text, issues) ?? {}, "");
      reader.onlyKeys(manifest, "", ["name", "description", "priority"]);
      reader.optionalString(manifest, "name", "");
      return { pack, priority: reader.optionalNumber(manifest, "priority", "", 0) };
    })
    .sort((a, b) => a.priority - b.priority || compareIds(a.pack.id, b.pack.id))
    .map(({ pack }) => pack);

  // --- collect definitions, later packs replacing earlier ones ---
  const entries = new Map<ContentFolder, Map<string, Entry>>(CONTENT_FOLDERS.map((folder) => [folder, new Map()]));
  const defaultsLayers: { file: string; data: unknown }[] = [];
  const patches: { file: string; data: unknown }[] = [];

  for (const pack of ordered) {
    for (const { path, text } of pack.files) {
      if (path === "pack.json5") continue;
      const file = `${pack.id}/${path}`;
      const parts = path.split("/");
      const data = parseFile(file, text, issues);
      if (data === undefined) continue;

      if (parts.length === 1 && path === "defaults.json5") {
        defaultsLayers.push({ file, data });
        continue;
      }
      if (parts.length === 2 && parts[0] === "patches") {
        patches.push({ file, data });
        continue;
      }
      const folder = parts[0] as ContentFolder;
      if (parts.length !== 2 || !CONTENT_FOLDERS.includes(folder)) {
        issues.push({ file, path: "", message: `not a place content is read from (expected ${[...CONTENT_FOLDERS, "patches"].map((f) => `${f}/`).join(", ")} or defaults.json5)` });
        continue;
      }
      const id = parts[1].replace(/\.json5$/, "");
      if (!ID_PATTERN.test(id)) {
        issues.push({ file, path: "", message: "file names (which are ids) may only use letters, digits, - and _" });
        continue;
      }
      entries.get(folder)!.set(id, { id, file, data });
    }
  }

  // --- patches: append to lists in another definition ---
  for (const patch of patches) {
    const reader = new Reader(issues, patch.file);
    const obj = reader.object(patch.data, "");
    reader.onlyKeys(obj, "", ["target", "append"]);
    const target = reader.string(obj, "target", "");
    const [folder, id] = target.split("/");
    const entry = entries.get(folder as ContentFolder)?.get(id ?? "");
    if (!entry) {
      if (target) reader.fail("target", `no definition "${target}" (expected folder/id, e.g. "materials/grass")`);
      continue;
    }
    const append = reader.object(obj.append, "append");
    entry.data = appendLists(entry.data, append, reader, "append");
  }

  // --- defaults, merged one section deep so a pack can override a single setting ---
  const defaultsRaw: RawObject = {};
  const defaultsFileOf: Record<string, string> = {};
  for (const layer of defaultsLayers) {
    const reader = new Reader(issues, layer.file);
    const obj = reader.object(layer.data, "");
    for (const [key, value] of Object.entries(obj)) {
      defaultsRaw[key] = isObject(value) && isObject(defaultsRaw[key]) ? { ...(defaultsRaw[key] as RawObject), ...value } : value;
      defaultsFileOf[key] = layer.file;
    }
  }
  const defaults = readDefaults(defaultsRaw, new Reader(issues, defaultsLayers.at(-1)?.file ?? "defaults.json5"));

  // --- read every definition, in id order ---
  function readAll<T>(folder: ContentFolder, read: (entry: Entry, obj: RawObject, reader: Reader) => T): T[] {
    return [...entries.get(folder)!.values()]
      .sort((a, b) => compareIds(a.id, b.id))
      .map((entry) => {
        const reader = new Reader(issues, entry.file);
        const expanded = expandGenerators(entry.data, reader);
        return read(entry, reader.object(expanded, ""), reader);
      });
  }

  const materials = readAll("materials", (e, o, r) => readMaterial(e.id, o, r));
  const layers = readAll("layers", (e, o, r) => ({ file: e.file, ...readUniversalLayer(e.id, o, r) }));
  const grassKinds = readAll("grass", (e, o, r) => readGrassKind(e.id, o, r));
  const treeKinds = readAll("trees", (e, o, r) => readTreeKind(e.id, o, r, defaults));
  const voiceList = readAll("voices", (e, o, r) => ({ id: e.id, voice: readVoice(o, r) }));
  const boundaryHillStyles = readAll("borderHills", (e, o, r) => readBoundaryHillStyle(e.id, o, r));
  const settlementStyles = readAll("settlements", (e, o, r) => readSettlementStyle(e.id, o, r));
  const styleById = new Map(settlementStyles.map((style) => [style.id, style]));
  const biomeReads = readAll("biomes", (e, o, r) => ({ file: e.file, biome: readBiome(e.id, o, r, defaults, styleById) }));
  const biomes = biomeReads.map((b) => b.biome);

  // --- references between definitions ---
  const materialIds = new Set(materials.map((m) => m.id));
  const grassKindIds = new Set(grassKinds.map((k) => k.id));
  const treeKindIds = new Set(treeKinds.map((k) => k.id));
  const voices: Record<string, Voice> = {};
  for (const { id, voice } of voiceList) voices[id] = voice;

  const checkMaterial = (file: string, path: string, id: string): void => {
    if (id && !materialIds.has(id)) issues.push({ file, path, message: `no material "${id}" (known: ${[...materialIds].join(", ")})` });
  };

  for (const material of materials) {
    material.grass.forEach((spec, i) => {
      if (!grassKindIds.has(spec.kind)) {
        issues.push({ file: entries.get("materials")!.get(material.id)!.file, path: `grass[${i}].kind`, message: `no grass kind "${spec.kind}" (known: ${[...grassKindIds].join(", ")})` });
      }
    });
  }
  const roadLayers = layers.filter((l) => l.roadSurface);
  for (const layer of layers) checkMaterial(layer.file, "material", layer.layer.materialId);
  for (const { file, biome } of biomeReads) {
    checkMaterial(file, "ground.base", biome.baseMaterialId);
    checkMaterial(file, "ground.road", biome.roadMaterialId);
    biome.materialLayers.forEach((layer, i) => checkMaterial(file, `ground.layers[${i}].material`, layer.materialId));
    if (biome.voiceId && !voices[biome.voiceId]) {
      issues.push({ file, path: "voice", message: `no voice "${biome.voiceId}" (known: ${Object.keys(voices).join(", ")})` });
    }
    for (const output of Object.keys(biome.outputs.foliage?.outputs ?? {})) {
      if (!treeKindIds.has(output)) issues.push({ file, path: "trees.outputs", message: `"${output}" is not a tree kind (known: ${[...treeKindIds].join(", ")})` });
    }
  }
  const defaultsFile = defaultsFileOf.defaultMaterial ?? "defaults.json5";
  checkMaterial(defaultsFile, "defaultMaterial", defaults.defaultMaterialId);

  // --- things there must be some of ---
  const need = (count: number, what: string, folder: string): void => {
    if (count === 0) issues.push({ file: "(all packs)", path: "", message: `no ${what} defined - add at least one to a pack's ${folder}/ folder` });
  };
  need(biomes.length, "biomes", "biomes");
  need(voiceList.length, "voices", "voices");
  need(boundaryHillStyles.length, "border hill styles", "borderHills");
  if (roadLayers.length !== 1) {
    issues.push({
      file: roadLayers[1]?.file ?? "(all packs)",
      path: "",
      message: `exactly one layer must be the road surface (roadSurface: true), found ${roadLayers.length}`,
    });
  }
  if (grassKinds.length > MAX_GRASS_KINDS) {
    issues.push({ file: "(all packs)", path: "", message: `${grassKinds.length} grass kinds defined; at most ${MAX_GRASS_KINDS} fit` });
  }

  if (issues.length > 0) throw new ContentError(issues);

  return {
    biomes,
    materials,
    defaultMaterialId: defaults.defaultMaterialId,
    universalLayers: layers.filter((l) => !l.roadSurface).map((l) => l.layer),
    roadLayer: roadLayers[0].layer,
    grassKinds,
    treeKinds,
    voices,
    boundaryHillStyles,
    settlementStyles,
  };
}

/** A patch's `append`: each key names a list in the target (a dotted path reaches into nested
 *  objects) and its items are added to the end of it. */
function appendLists(target: unknown, append: RawObject, reader: Reader, path: string): unknown {
  const result: RawObject = isObject(target) ? { ...target } : {};
  for (const [key, items] of Object.entries(append)) {
    const at = joinPath(path, key);
    if (!Array.isArray(items)) {
      reader.fail(at, "expected a list of items to append");
      continue;
    }
    const [head, ...rest] = key.split(".");
    if (rest.length > 0) {
      result[head] = appendLists(result[head], { [rest.join(".")]: items }, reader, path);
      continue;
    }
    const existing = result[head] ?? [];
    if (!Array.isArray(existing)) {
      reader.fail(at, "the target's field is not a list");
      continue;
    }
    result[head] = [...existing, ...items];
  }
  return result;
}

interface Defaults {
  defaultMaterialId: string;
  fogStart: number;
  light: { ambientDay: ColorTuple; ambientDayIntensity: number; sunHorizon: ColorTuple; sunZenith: ColorTuple; sunIntensity: number };
  /** One object shared by every biome that sets no rules of its own - see treeScatter's
   *  survivalFade, which skips blending when every zone in range shares one. */
  treeRules: TreeRules;
  treeScale: [number, number];
}

function readDefaults(obj: RawObject, reader: Reader): Defaults {
  reader.onlyKeys(obj, "", ["defaultMaterial", "sky", "light", "treeRules", "treeScale"]);
  const treeRules = reader.object(obj.treeRules ?? {}, "treeRules");
  reader.onlyKeys(treeRules, "treeRules", ["shore", "line", "slope"]);
  const sky = reader.object(obj.sky ?? {}, "sky");
  reader.onlyKeys(sky, "sky", ["fogStart"]);
  const light = reader.object(obj.light ?? {}, "light");
  reader.onlyKeys(light, "light", ["ambientDay", "ambientDayIntensity", "sunHorizon", "sunZenith", "sunIntensity"]);
  return {
    defaultMaterialId: reader.string(obj, "defaultMaterial", ""),
    fogStart: reader.number(sky, "fogStart", "sky", { min: 0, max: 1 }),
    light: {
      ambientDay: reader.color(light, "ambientDay", "light"),
      ambientDayIntensity: reader.number(light, "ambientDayIntensity", "light", { min: 0 }),
      sunHorizon: reader.color(light, "sunHorizon", "light"),
      sunZenith: reader.color(light, "sunZenith", "light"),
      sunIntensity: reader.number(light, "sunIntensity", "light", { min: 0 }),
    },
    treeRules: {
      shore: reader.range(treeRules, "shore", "treeRules"),
      line: reader.range(treeRules, "line", "treeRules"),
      slope: reader.range(treeRules, "slope", "treeRules"),
    },
    treeScale: reader.range(obj, "treeScale", "", { allowEqual: true }),
  };
}

function readLayer(obj: RawObject, reader: Reader, path: string, id: string): MaterialLayer {
  return { id, materialId: reader.string(obj, "material", path), weight: readPipeline(obj.weight, reader, joinPath(path, "weight")) };
}

function readUniversalLayer(id: string, obj: RawObject, reader: Reader): { layer: MaterialLayer; roadSurface: boolean } {
  reader.onlyKeys(obj, "", ["material", "weight", "roadSurface"]);
  return { layer: readLayer(obj, reader, "", id), roadSurface: reader.boolean(obj, "roadSurface", "", false) };
}

function readMaterial(id: string, obj: RawObject, reader: Reader): MaterialDef {
  reader.onlyKeys(obj, "", ["name", "texture", "grass", "clearsGrass"]);
  return {
    id,
    name: reader.string(obj, "name", ""),
    texture: readTexture(obj.texture, reader, "texture"),
    grass: reader.optionalArray(obj, "grass", "").map((raw, i) => {
      const path = `grass[${i}]`;
      const spec = reader.object(raw, path);
      reader.onlyKeys(spec, path, ["kind", "density", "color"]);
      return { kind: reader.string(spec, "kind", path), density: reader.number(spec, "density", path, { min: 0 }), color: reader.color(spec, "color", path) };
    }),
    clearsGrass: reader.optionalNumber(obj, "clearsGrass", "", 0, { min: 0 }),
  };
}

/** A baked texture: a graph with a colour `diffuse` output and optional `roughness` and `height`,
 *  and how strongly its height reads as bumps. Materials and bark both use it. */
function readTexture(raw: unknown, reader: Reader, path: string): TextureDef {
  const failed = raw === FAILED_GENERATOR;
  const texture = failed ? { bumpStrength: 0, pipeline: FAILED_GENERATOR } : reader.object(raw, path);
  reader.onlyKeys(texture, path, ["bumpStrength", "pipeline"]);
  return {
    bumpStrength: reader.number(texture, "bumpStrength", path, { min: 0 }),
    pipeline: readPipeline(texture.pipeline, reader, `${path}.pipeline`, { texture: true, requiredOutputs: ["diffuse"] }),
  };
}

function readGrassKind(id: string, obj: RawObject, reader: Reader): GrassKindDef {
  reader.onlyKeys(obj, "", ["width", "height", "sway", "fadeStart", "fadeEnd", "cluster", "blades"]);
  const blades = reader.object(obj.blades, "blades");
  reader.onlyKeys(blades, "blades", ["count", "minHeight", "maxHeight", "baseWidth", "lean", "fan", "seedHeads", "flowerHeads"]);
  const def: GrassKindDef = {
    id,
    width: reader.number(obj, "width", "", { min: 0 }),
    height: reader.number(obj, "height", "", { min: 0 }),
    sway: reader.number(obj, "sway", "", { min: 0 }),
    fadeStart: reader.number(obj, "fadeStart", "", { min: 0 }),
    fadeEnd: reader.number(obj, "fadeEnd", "", { min: 0 }),
    blades: {
      count: reader.number(blades, "count", "blades", { min: 1, integer: true }),
      minHeight: reader.number(blades, "minHeight", "blades", { min: 0, max: 1 }),
      maxHeight: reader.number(blades, "maxHeight", "blades", { min: 0, max: 1 }),
      baseWidth: reader.number(blades, "baseWidth", "blades", { min: 0 }),
      lean: reader.number(blades, "lean", "blades"),
      fan: reader.boolean(blades, "fan", "blades", false),
      seedHeads: reader.boolean(blades, "seedHeads", "blades", false),
    },
  };
  if (def.fadeEnd < def.fadeStart) reader.fail("fadeEnd", "must not be closer than fadeStart");
  if (obj.cluster !== undefined) {
    const cluster = reader.object(obj.cluster, "cluster");
    reader.onlyKeys(cluster, "cluster", ["scale", "coverage"]);
    def.cluster = { scale: reader.number(cluster, "scale", "cluster", { min: 0 }), coverage: reader.number(cluster, "coverage", "cluster", { min: 0, max: 1 }) };
  }
  if (blades.flowerHeads !== undefined) {
    const heads = reader.object(blades.flowerHeads, "blades.flowerHeads");
    reader.onlyKeys(heads, "blades.flowerHeads", ["count", "radius", "colors"]);
    const colors = reader.array(heads, "colors", "blades.flowerHeads").map((c, i) => reader.colorValue(c, `blades.flowerHeads.colors[${i}]`));
    if (colors.length === 0) reader.fail("blades.flowerHeads.colors", "a flowering kind needs at least one petal colour");
    def.blades.flowerHeads = {
      count: reader.number(heads, "count", "blades.flowerHeads", { min: 0, integer: true }),
      radius: reader.number(heads, "radius", "blades.flowerHeads", { min: 0 }),
      colors,
    };
  }
  return def;
}

function readTreeKind(id: string, obj: RawObject, reader: Reader, defaults: Defaults): TreeKindDef {
  const model = obj.model === undefined ? "primitive" : reader.oneOf(obj, "model", "", ["primitive", "branching"] as const);
  const common = ["model", "tint", "scale"];
  const tint = reader.array(obj, "tint", "").map((c, i) => reader.colorValue(c, `tint[${i}]`));
  if (tint.length !== 2) reader.fail("tint", "expected two colours: [darkest, lightest]");
  return {
    id,
    shape: model === "branching" ? readBranchingTree(obj, reader, common) : readPrimitiveTree(obj, reader, common),
    tint: [tint[0] ?? [1, 1, 1], tint[1] ?? [1, 1, 1]],
    scale: obj.scale === undefined ? defaults.treeScale : reader.range(obj, "scale", "", { allowEqual: true }),
  };
}

function readPrimitiveTree(obj: RawObject, reader: Reader, common: string[]): PrimitiveTree {
  reader.onlyKeys(obj, "", [...common, "trunk", "crown"]);
  const trunk = reader.object(obj.trunk, "trunk");
  reader.onlyKeys(trunk, "trunk", ["height", "diameterBottom", "diameterTop", "sides", "color"]);
  const crown = reader.object(obj.crown, "crown");
  const builder = reader.oneOf(crown, "builder", "crown", TREE_CROWN_BUILDERS);
  let readCrown: TreeCrown;
  if (builder === "sphereCrown") {
    reader.onlyKeys(crown, "crown", ["builder", "centreY", "radius", "heightRatio"]);
    readCrown = {
      builder,
      centreY: reader.number(crown, "centreY", "crown"),
      radius: reader.number(crown, "radius", "crown", { min: 0 }),
      heightRatio: reader.number(crown, "heightRatio", "crown", { min: 0 }),
    };
  } else if (builder === "tieredCones") {
    reader.onlyKeys(crown, "crown", ["builder", "sides", "tiers"]);
    readCrown = {
      builder,
      sides: reader.number(crown, "sides", "crown", { min: 3, integer: true }),
      tiers: reader.array(crown, "tiers", "crown").map((raw, i) => {
        const path = `crown.tiers[${i}]`;
        const tier = reader.object(raw, path);
        reader.onlyKeys(tier, path, ["diameter", "height", "baseY"]);
        return { diameter: reader.number(tier, "diameter", path, { min: 0 }), height: reader.number(tier, "height", path, { min: 0 }), baseY: reader.number(tier, "baseY", path) };
      }),
    };
  } else {
    reader.onlyKeys(crown, "crown", ["builder", "count", "length", "width", "thickness", "reach", "droop", "y"]);
    readCrown = {
      builder,
      count: reader.number(crown, "count", "crown", { min: 1, integer: true }),
      length: reader.number(crown, "length", "crown", { min: 0 }),
      width: reader.number(crown, "width", "crown", { min: 0 }),
      thickness: reader.number(crown, "thickness", "crown", { min: 0 }),
      reach: reader.number(crown, "reach", "crown"),
      droop: reader.number(crown, "droop", "crown"),
      y: reader.number(crown, "y", "crown"),
    };
  }
  return {
    model: "primitive",
    trunk: {
      height: reader.number(trunk, "height", "trunk", { min: 0 }),
      diameterBottom: reader.number(trunk, "diameterBottom", "trunk", { min: 0 }),
      diameterTop: reader.number(trunk, "diameterTop", "trunk", { min: 0 }),
      sides: reader.number(trunk, "sides", "trunk", { min: 3, integer: true }),
      color: reader.color(trunk, "color", "trunk"),
    },
    crown: readCrown,
  };
}

function readBranchingTree(obj: RawObject, reader: Reader, common: string[]): BranchingTree {
  reader.onlyKeys(obj, "", [...common, "variants", "trunk", "roots", "branches", "leaves", "bark", "foliage"]);
  const section = (key: string, keys: string[]): RawObject => {
    const value = reader.object(obj[key], key);
    reader.onlyKeys(value, key, keys);
    return value;
  };
  const trunk = section("trunk", ["height", "radius", "topRadius", "lean", "wobble", "flare", "flareHeight", "sides", "rings"]);
  const roots = section("roots", ["count", "length", "radius", "drop", "sides", "rings"]);
  const branches = section("branches", ["count", "from", "length", "radius", "angle", "arc", "sides", "rings", "twigs"]);
  const twigs = reader.object(branches.twigs, "branches.twigs");
  reader.onlyKeys(twigs, "branches.twigs", ["count", "length", "angle", "sides", "rings"]);
  const leaves = section("leaves", ["size", "cards", "alongBranch", "top", "spread"]);
  const bark = section("bark", ["tile", "texture"]);
  const foliage = section("foliage", ["builder", "dark", "light", "leaves", "leafLength", "leafWidth"]);
  const sides = (o: RawObject, path: string): number => reader.number(o, "sides", path, { min: 3, max: 16, integer: true });
  const rings = (o: RawObject, path: string): number => reader.number(o, "rings", path, { min: 1, max: 16, integer: true });
  const count = (o: RawObject, key: string, path: string): [number, number] => {
    const range = reader.range(o, key, path, { allowEqual: true });
    if (!Number.isInteger(range[0]) || !Number.isInteger(range[1])) reader.fail(`${path}.${key}`, "counts must be whole numbers");
    return range;
  };
  return {
    model: "branching",
    variants: reader.number(obj, "variants", "", { min: 1, max: 16, integer: true }),
    trunk: {
      height: reader.number(trunk, "height", "trunk", { min: 1 }),
      radius: reader.number(trunk, "radius", "trunk", { min: 0.05 }),
      topRadius: reader.number(trunk, "topRadius", "trunk", { min: 0.01 }),
      lean: reader.number(trunk, "lean", "trunk"),
      wobble: reader.number(trunk, "wobble", "trunk", { min: 0 }),
      flare: reader.number(trunk, "flare", "trunk", { min: 1 }),
      flareHeight: reader.number(trunk, "flareHeight", "trunk", { min: 0.01 }),
      sides: sides(trunk, "trunk"),
      rings: rings(trunk, "trunk"),
    },
    roots: {
      count: reader.number(roots, "count", "roots", { min: 0, integer: true }),
      length: reader.range(roots, "length", "roots", { allowEqual: true }),
      radius: reader.number(roots, "radius", "roots", { min: 0 }),
      drop: reader.number(roots, "drop", "roots", { min: 0 }),
      sides: sides(roots, "roots"),
      rings: rings(roots, "roots"),
    },
    branches: {
      count: count(branches, "count", "branches"),
      from: reader.number(branches, "from", "branches", { min: 0, max: 1 }),
      length: reader.range(branches, "length", "branches", { allowEqual: true }),
      radius: reader.number(branches, "radius", "branches", { min: 0 }),
      angle: reader.range(branches, "angle", "branches", { allowEqual: true }),
      arc: reader.number(branches, "arc", "branches"),
      sides: sides(branches, "branches"),
      rings: rings(branches, "branches"),
      twigs: {
        count: count(twigs, "count", "branches.twigs"),
        length: reader.range(twigs, "length", "branches.twigs", { allowEqual: true }),
        angle: reader.range(twigs, "angle", "branches.twigs", { allowEqual: true }),
        sides: sides(twigs, "branches.twigs"),
        rings: rings(twigs, "branches.twigs"),
      },
    },
    leaves: {
      size: reader.range(leaves, "size", "leaves", { allowEqual: true }),
      cards: reader.number(leaves, "cards", "leaves", { min: 1, max: 8, integer: true }),
      alongBranch: reader.number(leaves, "alongBranch", "leaves", { min: 0, integer: true }),
      top: reader.number(leaves, "top", "leaves", { min: 0, integer: true }),
      spread: reader.number(leaves, "spread", "leaves", { min: 0 }),
    },
    bark: {
      tile: reader.number(bark, "tile", "bark", { min: 0.1 }),
      texture: readTexture(bark.texture, reader, "bark.texture"),
    },
    foliage: {
      builder: reader.oneOf(foliage, "builder", "foliage", FOLIAGE_BUILDERS),
      dark: reader.color(foliage, "dark", "foliage"),
      light: reader.color(foliage, "light", "foliage"),
      leaves: reader.number(foliage, "leaves", "foliage", { min: 1, integer: true }),
      leafLength: reader.number(foliage, "leafLength", "foliage", { min: 0.01, max: 1 }),
      leafWidth: reader.number(foliage, "leafWidth", "foliage", { min: 0.01, max: 1 }),
    },
  };
}

function readVoice(obj: RawObject, reader: Reader): Voice {
  reader.onlyKeys(obj, "", ["onsets", "nuclei", "codas", "finals", "features", "qualities", "codaChance", "thirdSyllableChance"]);
  const nonEmpty = (key: string): string[] => {
    const list = reader.stringList(obj, key, "");
    if (list.length === 0) reader.fail(key, "needs at least one entry");
    return list;
  };
  return {
    onsets: nonEmpty("onsets"),
    nuclei: nonEmpty("nuclei"),
    codas: reader.stringList(obj, "codas", ""),
    finals: nonEmpty("finals"),
    features: nonEmpty("features"),
    qualities: nonEmpty("qualities"),
    codaChance: reader.number(obj, "codaChance", "", { min: 0, max: 1 }),
    thirdSyllableChance: reader.number(obj, "thirdSyllableChance", "", { min: 0, max: 1 }),
  };
}

function readBoundaryHillStyle(id: string, obj: RawObject, reader: Reader): BoundaryHillStyle {
  reader.onlyKeys(obj, "", ["name", "height"]);
  return { id, name: reader.string(obj, "name", ""), heightPipeline: readPipeline(obj.height, reader, "height") };
}

function readBiome(id: string, obj: RawObject, reader: Reader, defaults: Defaults, styles: Map<string, SettlementStyle>): BiomeDefinition {
  reader.onlyKeys(obj, "", [
    "name",
    "voice",
    "spawnWeight",
    "lakeChance",
    "borderType",
    "height",
    "trees",
    "treeRules",
    "settlement",
    "ground",
    "sky",
    "light",
  ]);

  let settlementStyle: SettlementStyle | null = null;
  const styleId = reader.optionalString(obj, "settlement", "");
  if (styleId) {
    settlementStyle = styles.get(styleId) ?? null;
    if (!settlementStyle) reader.fail("settlement", `no settlement style "${styleId}" (known: ${[...styles.keys()].join(", ")})`);
  }

  const ground = reader.object(obj.ground, "ground");
  reader.onlyKeys(ground, "ground", ["base", "road", "layers"]);
  const materialLayers = reader.optionalArray(ground, "layers", "ground").map((raw, i) => {
    const path = `ground.layers[${i}]`;
    const layer = reader.object(raw, path);
    reader.onlyKeys(layer, path, ["id", "material", "weight"]);
    return readLayer(layer, reader, path, reader.optionalString(layer, "id", path) ?? `${id}-${i}`);
  });

  const sky = reader.object(obj.sky, "sky");
  reader.onlyKeys(sky, "sky", ["horizon", "zenith", "cloud", "fogStart"]);

  const light = reader.object(obj.light, "light");
  reader.onlyKeys(light, "light", [
    "sunPeak",
    "moonPeak",
    "ambientDay",
    "ambientDayIntensity",
    "sunHorizon",
    "sunZenith",
    "sunIntensity",
    "ambientNight",
    "ambientNightIntensity",
    "moonColor",
    "moonIntensity",
  ]);

  return {
    id,
    name: reader.string(obj, "name", ""),
    voiceId: reader.string(obj, "voice", ""),
    outputs: {
      height: readPipeline(obj.height, reader, "height"),
      foliage: obj.trees === undefined ? undefined : readPipeline(obj.trees, reader, "trees"),
    },
    borderType: obj.borderType === undefined ? "mountain" : reader.oneOf(obj, "borderType", "", BORDER_TYPES),
    spawnWeight: reader.number(obj, "spawnWeight", "", { min: 0 }),
    lakeChance: reader.optionalNumber(obj, "lakeChance", "", 0, { min: 0, max: 1 }),
    baseMaterialId: reader.string(ground, "base", "ground"),
    roadMaterialId: reader.string(ground, "road", "ground"),
    materialLayers,
    treeRules: readTreeRules(obj, reader, defaults.treeRules),
    settlementStyle,
    atmosphere: {
      horizon: reader.color(sky, "horizon", "sky"),
      zenith: reader.color(sky, "zenith", "sky"),
      cloud: reader.color(sky, "cloud", "sky"),
      fogStartFraction: reader.optionalNumber(sky, "fogStart", "sky", defaults.fogStart, { min: 0, max: 1 }),
    },
    dayNight: readDayNight(light, reader, defaults),
  };
}

const TIERS: readonly SettlementTier[] = ["hamlet", "village", "town"];

function readSettlementStyle(id: string, obj: RawObject, reader: Reader): SettlementStyle {
  reader.onlyKeys(obj, "", ["tiers", "houses", "look"]);

  const tiersRaw = reader.object(obj.tiers, "tiers");
  reader.onlyKeys(tiersRaw, "tiers", TIERS);
  const tiers = {} as Record<SettlementTier, SettlementTierDef>;
  for (const tier of TIERS) {
    const path = `tiers.${tier}`;
    const t = reader.object(tiersRaw[tier], path);
    reader.onlyKeys(t, path, ["radius", "sideStreetChance", "sideStreetLength", "plotFill", "squareRadius"]);
    tiers[tier] = {
      radius: reader.number(t, "radius", path, { min: 10 }),
      sideStreetChance: reader.number(t, "sideStreetChance", path, { min: 0, max: 1 }),
      sideStreetLength: reader.range(t, "sideStreetLength", path, { allowEqual: true }),
      plotFill: reader.number(t, "plotFill", path, { min: 0, max: 1 }),
      squareRadius: reader.number(t, "squareRadius", path, { min: 0 }),
    };
  }

  const houses = reader.object(obj.houses, "houses");
  reader.onlyKeys(houses, "houses", ["variants", "roofPitch", "roofOverhang", "setback", "gap"]);
  const variants: HouseVariant[] = reader.array(houses, "variants", "houses").map((raw, i) => {
    const path = `houses.variants[${i}]`;
    const v = reader.object(raw, path);
    reader.onlyKeys(v, path, ["width", "depth", "wallHeight", "weight"]);
    return {
      width: reader.range(v, "width", path, { allowEqual: true }),
      depth: reader.range(v, "depth", path, { allowEqual: true }),
      wallHeight: reader.range(v, "wallHeight", path, { allowEqual: true }),
      weight: reader.number(v, "weight", path, { min: 0 }),
    };
  });
  if (variants.length === 0) reader.fail("houses.variants", "needs at least one house variant");
  const pitch = reader.range(houses, "roofPitch", "houses", { allowEqual: true });

  const look = reader.object(obj.look, "look");
  reader.onlyKeys(look, "look", ["wallTexture", "wallTints", "roofTints", "door", "window"]);
  const texture = reader.object(look.wallTexture, "look.wallTexture");
  reader.onlyKeys(texture, "look.wallTexture", ["builder", "boards", "color"]);
  const colors = (key: string): [number, number, number][] => {
    const list = reader.array(look, key, "look").map((c, i) => reader.colorValue(c, `look.${key}[${i}]`));
    if (list.length === 0) reader.fail(`look.${key}`, "needs at least one colour");
    return list;
  };

  return {
    id,
    tiers,
    houses: {
      variants,
      // Written in degrees, the way anyone thinks about a roof.
      roofPitch: [(pitch[0] * Math.PI) / 180, (pitch[1] * Math.PI) / 180],
      roofOverhang: reader.number(houses, "roofOverhang", "houses", { min: 0 }),
      setback: reader.range(houses, "setback", "houses", { allowEqual: true }),
      gap: reader.range(houses, "gap", "houses", { allowEqual: true }),
    },
    look: {
      wallTexture: {
        builder: reader.oneOf(texture, "builder", "look.wallTexture", WALL_TEXTURE_BUILDERS),
        boards: reader.number(texture, "boards", "look.wallTexture", { min: 1, integer: true }),
        color: reader.color(texture, "color", "look.wallTexture"),
      },
      wallTints: colors("wallTints"),
      roofTints: colors("roofTints"),
      door: reader.color(look, "door", "look"),
      window: reader.color(look, "window", "look"),
    },
  };
}

/** A biome's own tree rules, each range falling back to the defaults' - and the defaults' very
 *  object when it sets none, so zones without rules of their own are known to share them. */
function readTreeRules(obj: RawObject, reader: Reader, defaults: TreeRules): TreeRules {
  if (obj.treeRules === undefined) return defaults;
  const rules = reader.object(obj.treeRules, "treeRules");
  reader.onlyKeys(rules, "treeRules", ["shore", "line", "slope"]);
  return {
    shore: rules.shore === undefined ? defaults.shore : reader.range(rules, "shore", "treeRules"),
    line: rules.line === undefined ? defaults.line : reader.range(rules, "line", "treeRules"),
    slope: rules.slope === undefined ? defaults.slope : reader.range(rules, "slope", "treeRules"),
  };
}

/**
 * A zone states its peak sun and moon elevations and whatever day colours it wants different from
 * the defaults; night is derived from those by one shared rule (see lighting/dayNightMath.ts) - a
 * cooler, dimmer version of the day - unless the zone overrides it outright.
 */
function readDayNight(light: RawObject, reader: Reader, defaults: Defaults): BiomeDayNight {
  const ambientDay = reader.optionalColor(light, "ambientDay", "light") ?? defaults.light.ambientDay;
  const ambientDayIntensity = reader.optionalNumber(light, "ambientDayIntensity", "light", defaults.light.ambientDayIntensity, { min: 0 });
  const sunZenithColor = reader.optionalColor(light, "sunZenith", "light") ?? defaults.light.sunZenith;
  const sunIntensity = reader.optionalNumber(light, "sunIntensity", "light", defaults.light.sunIntensity, { min: 0 });
  return {
    sunPeakElevation: reader.number(light, "sunPeak", "light", { min: 0, max: 90 }),
    moonPeakElevation: reader.number(light, "moonPeak", "light", { min: 0, max: 90 }),
    ambientDay,
    ambientDayIntensity,
    sunHorizonColor: reader.optionalColor(light, "sunHorizon", "light") ?? defaults.light.sunHorizon,
    sunZenithColor,
    sunIntensity,
    ambientNight: reader.optionalColor(light, "ambientNight", "light") ?? coolNightTone(ambientDay),
    ambientNightIntensity: reader.optionalNumber(light, "ambientNightIntensity", "light", deriveNightIntensity(ambientDayIntensity), { min: 0 }),
    // The moon's colour derives from the sun's zenith colour (its full-strength daylight hue), not
    // its horizon one - moonlight has no moonrise/moonset colour shift in this model.
    moonColor: reader.optionalColor(light, "moonColor", "light") ?? coolNightTone(sunZenithColor),
    moonIntensity: reader.optionalNumber(light, "moonIntensity", "light", deriveNightIntensity(sunIntensity), { min: 0 }),
  };
}
