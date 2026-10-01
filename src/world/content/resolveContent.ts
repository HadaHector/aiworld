import JSON5 from "json5";
import type { BiomeDayNight, BiomeDefinition, BorderType, BoundaryHillStyle, TreeTintPart, TreeTintRuleDef } from "../biomes/biomeTypes";
import type { MaterialDef, MaterialDetail, MaterialLayer } from "../materials/materialTypes";
import { FLOWER_SHAPES, type GrassKindDef } from "../foliage/grassConfig";
import {
  BUSH_FOLIAGE_BUILDERS,
  CONIFER_FOLIAGE_BUILDERS,
  FOLIAGE_BUILDERS,
  TREE_CROWN_BUILDERS,
  type BoulderShape,
  type BranchingTree,
  type BushShape,
  type BushBed,
  type ConiferTree,
  type BushTexture,
  type FoliageTexture,
  type Fronds,
  type OldTrees,
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
import { checkPlans, checkRoller, describeCheckPlan, MIDDLE_ROLLER, randomRoller, rollValue, type Roller } from "./biomeRolls";
import { deriveSeed, mulberry32 } from "../rng";
import { AREA_ROLL_SALT } from "../cells/config";
import type { WorldContent } from "./worldContent";
import type { TextureDef } from "../materials/textureGen";
import { adjustMatrix, chainMatrix, NO_ADJUST, type ColorAdjust } from "../materials/colorAdjust";

/** One pack as found on disk: its folder name and every .json5 file in it, by path inside it. */
export interface PackSource {
  id: string;
  files: { path: string; text: string }[];
}

/** The folders a pack's content lives in, one kind of definition each. A definition's id is its
 *  file name, and a pack with a higher priority replaces a lower one's definition of the same id. */
const CONTENT_FOLDERS = ["biomes", "materials", "layers", "grass", "trees", "bushes", "rocks", "voices", "borderHills", "settlements"] as const;
type ContentFolder = (typeof CONTENT_FOLDERS)[number];

/** How many grass kinds the packs may define between them: each is a layer of the blade atlas and
 *  an entry in the grass shader's per-kind uniform arrays (four vectors a kind, plus its petal
 *  colours), which must stay inside the 256 vertex uniform vectors WebGL2 guarantees. */
const MAX_GRASS_KINDS = 32;

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

  const materialReads = readAll("materials", (e, o, r) => ({ file: e.file, ...readMaterial(e.id, o, r, defaults) }));
  const materials = materialReads.map((read) => read.def);
  const layers = readAll("layers", (e, o, r) => ({ file: e.file, ...readUniversalLayer(e.id, o, r) }));
  const grassKinds = readAll("grass", (e, o, r) => readGrassKind(e.id, o, r));
  const treeKinds = readAll("trees", (e, o, r) => readTreeKind(e.id, o, r, defaults));
  const bushKinds = readAll("bushes", (e, o, r) => readBushKind(e.id, o, r, defaults));
  const rockReads = readAll("rocks", (e, o, r) => ({ file: e.file, ...readRockKind(e.id, o, r, defaults) }));
  const rockKinds = rockReads.map((read) => read.def);
  const voiceList = readAll("voices", (e, o, r) => ({ id: e.id, voice: readVoice(o, r) }));
  const boundaryHillStyles = readAll("borderHills", (e, o, r) => readBoundaryHillStyle(e.id, o, r));
  const settlementStyles = readAll("settlements", (e, o, r) => readSettlementStyle(e.id, o, r));
  const styleById = new Map(settlementStyles.map((style) => [style.id, style]));
  // A biome is read as its middle roll here (see biomeRolls.ts) - what its name, spawn weight and the
  // workbench go by - and rolled again for every area of the world it is given to (rollAreaBiome).
  const biomeReads = [...entries.get("biomes")!.values()]
    .sort((a, b) => compareIds(a.id, b.id))
    .map((entry) => {
      const reader = new Reader(issues, entry.file);
      const source = reader.object(entry.data, "");
      for (const key of UNROLLED_BIOME_KEYS) {
        if (isObject(source[key])) reader.fail(key, "cannot be rolled - it is what picks the biome for an area, before the area rolls it");
      }
      return { file: entry.file, source, biome: readRolledBiome(entry.id, source, MIDDLE_ROLLER, reader, defaults, styleById, entry.id) };
    });
  const biomes = biomeReads.map((b) => b.biome);

  // --- references between definitions ---
  const materialIds = new Set(materials.map((m) => m.id));
  const grassKindIds = new Set(grassKinds.map((k) => k.id));
  const treeKindIds = new Set(treeKinds.map((k) => k.id));
  const bushKindIds = new Set(bushKinds.map((k) => k.id));
  const rockKindIds = new Set(rockKinds.map((k) => k.id));
  for (const id of bushKindIds) {
    if (treeKindIds.has(id)) {
      issues.push({ file: entries.get("bushes")!.get(id)!.file, path: "", message: `a tree kind is already called "${id}" - trees, bushes and rocks share one set of names` });
    }
  }
  for (const id of rockKindIds) {
    if (treeKindIds.has(id) || bushKindIds.has(id)) {
      issues.push({ file: entries.get("rocks")!.get(id)!.file, path: "", message: `a tree or bush kind is already called "${id}" - trees, bushes and rocks share one set of names` });
    }
  }
  const plantKindIds = [...treeKindIds, ...bushKindIds, ...rockKindIds];
  const voices: Record<string, Voice> = {};
  for (const { id, voice } of voiceList) voices[id] = voice;

  const checkMaterial = (file: string, path: string, id: string): void => {
    if (id && !materialIds.has(id)) issues.push({ file, path, message: `no material "${id}" (known: ${[...materialIds].join(", ")})` });
  };

  // One level only: a borrowed texture is always some material's own, so every material drawing it
  // shares one bake, seeded and cached under that material's id.
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const borrows = new Set(materialReads.filter((read) => read.textureFrom !== undefined).map((read) => read.def.id));
  for (const { file, def, textureFrom } of materialReads) {
    if (textureFrom === undefined) continue;
    const source = materialById.get(textureFrom);
    if (!source) {
      issues.push({ file, path: "textureFrom", message: `no material "${textureFrom}" (known: ${[...materialIds].join(", ")})` });
    } else if (borrows.has(textureFrom)) {
      issues.push({ file, path: "textureFrom", message: `"${textureFrom}" borrows its texture itself - name the material that has it` });
    } else {
      def.textureId = source.id;
      def.texture = source.texture;
    }
  }

  // A stone drawn from a material: its texture (the borrowed one, if the material borrows), baked
  // under the texture's own id so it is the very bake the ground uses, and its recolouring before
  // the kind's own.
  for (const { file, def, stoneMaterial, stoneAdjust } of rockReads) {
    if (stoneMaterial === undefined || def.shape.model !== "boulder") continue;
    const source = materialById.get(stoneMaterial);
    if (!source) {
      issues.push({ file, path: "stone.material", message: `no material "${stoneMaterial}" (known: ${[...materialIds].join(", ")})` });
      continue;
    }
    def.shape.stone.texture = source.texture;
    def.shape.stone.material = source.textureId;
    def.shape.stone.adjust = chainMatrix([source.adjust, stoneAdjust]);
  }

  for (const material of materials) {
    material.grass.forEach((spec, i) => {
      if (!grassKindIds.has(spec.kind)) {
        issues.push({ file: entries.get("materials")!.get(material.id)!.file, path: `grass[${i}].kind`, message: `no grass kind "${spec.kind}" (known: ${[...grassKindIds].join(", ")})` });
      }
    });
  }
  const roadLayers = layers.filter((l) => l.roadSurface);
  for (const layer of layers) checkMaterial(layer.file, "material", layer.layer.materialId);
  const families = new Set(materials.flatMap((m) => (m.family ? [m.family] : [])));
  const checkBiome = (file: string, biome: BiomeDefinition, report: (issue: ContentIssue) => void): void => {
    const material = (path: string, id: string): void => {
      if (id && !materialIds.has(id)) report({ file, path, message: `no material "${id}" (known: ${[...materialIds].join(", ")})` });
    };
    material("ground.base", biome.baseMaterialId);
    material("ground.road", biome.roadMaterialId);
    biome.materialLayers.forEach((layer, i) => material(`ground.layers[${i}].material`, layer.materialId));
    biome.treeTints.forEach((rule, i) => {
      for (const kind of rule.kinds ?? []) {
        if (!plantKindIds.includes(kind)) {
          report({ file, path: `treeTints[${i}].kinds`, message: `no tree, bush or rock kind "${kind}" (known: ${plantKindIds.join(", ")})` });
        }
      }
    });
    biome.groundTints.forEach((tint, i) => {
      if (tint.family && !families.has(tint.family)) {
        report({ file, path: `ground.tints[${i}].family`, message: `no material is of family "${tint.family}" (known: ${[...families].join(", ") || "none"})` });
      }
    });
    biome.groundGrass.forEach(({ family, spec }, i) => {
      if (!families.has(family)) report({ file, path: `ground.grass[${i}].family`, message: `no material is of family "${family}" (known: ${[...families].join(", ") || "none"})` });
      if (!grassKindIds.has(spec.kind)) report({ file, path: `ground.grass[${i}].kind`, message: `no grass kind "${spec.kind}" (known: ${[...grassKindIds].join(", ")})` });
    });
    if (biome.voiceId && !voices[biome.voiceId]) {
      report({ file, path: "voice", message: `no voice "${biome.voiceId}" (known: ${Object.keys(voices).join(", ")})` });
    }
    for (const output of Object.keys(biome.outputs.foliage?.outputs ?? {})) {
      if (!treeKindIds.has(output)) report({ file, path: "trees.outputs", message: `"${output}" is not a tree kind (known: ${[...treeKindIds].join(", ")})` });
    }
    for (const output of Object.keys(biome.outputs.bushes?.outputs ?? {})) {
      if (!bushKindIds.has(output)) report({ file, path: "bushes.outputs", message: `"${output}" is not a bush kind (known: ${[...bushKindIds].join(", ")})` });
    }
    for (const output of Object.keys(biome.outputs.rocks?.outputs ?? {})) {
      if (!rockKindIds.has(output)) report({ file, path: "rocks.outputs", message: `"${output}" is not a rock kind (known: ${[...rockKindIds].join(", ") || "none"})` });
    }
  };
  for (const { file, source, biome } of biomeReads) {
    // What reading the middle roll already reported for this file counts as reported too.
    const reported = new Set(issues.filter((issue) => issue.file === file).map((issue) => `${issue.path}\n${issue.message}`));
    const report = (issue: ContentIssue): void => {
      reported.add(`${issue.path}\n${issue.message}`);
      issues.push(issue);
    };
    checkBiome(file, biome, report);
    // Then its extreme rolls, so a range that breaks the biome at one end, or an option naming
    // something that does not exist, is found now rather than in whichever area rolls it. Only
    // what the middle roll did not already report.
    if (!hasRolls(source)) continue;
    for (let plan = 0; plan < checkPlans(source); plan++) {
      const planIssues: ContentIssue[] = [];
      const rolled = readRolledBiome(biome.id, source, checkRoller(plan), new Reader(planIssues, file), defaults, styleById, biome.id);
      checkBiome(file, rolled, (issue) => planIssues.push(issue));
      for (const issue of planIssues) {
        if (reported.has(`${issue.path}\n${issue.message}`)) continue;
        report(issue);
        issue.message += ` (${describeCheckPlan(plan)})`;
      }
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
    biomeSources: Object.fromEntries(biomeReads.map(({ file, source, biome }) => [biome.id, { file, data: source, rolls: hasRolls(source) }])),
    biomeDefaults: defaults,
    materials,
    defaultMaterialId: defaults.defaultMaterialId,
    universalLayers: layers.filter((l) => !l.roadSurface).map((l) => l.layer),
    roadLayer: roadLayers[0].layer,
    grassKinds,
    treeKinds,
    bushKinds,
    rockKinds,
    oldTrees: defaults.oldTrees,
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

/** The packs' merged defaults.json5 - kept with the content, since an area's roll of a biome is read
 *  against them (rollAreaBiome). */
export interface Defaults {
  defaultMaterialId: string;
  fogStart: number;
  fogEnd: number;
  light: { ambientDay: ColorTuple; ambientDayIntensity: number; sunHorizon: ColorTuple; sunZenith: ColorTuple; sunIntensity: number };
  /** One object shared by every biome that sets no rules of its own - see treeScatter's
   *  survivalFade, which skips blending when every zone in range shares one. */
  treeRules: TreeRules;
  treeScale: [number, number];
  materialDetail: MaterialDetail;
  oldTrees: OldTrees;
}

function readDefaults(obj: RawObject, reader: Reader): Defaults {
  reader.onlyKeys(obj, "", ["defaultMaterial", "sky", "light", "treeRules", "treeScale", "materialDetail", "oldTrees"]);
  const oldTrees = reader.object(obj.oldTrees, "oldTrees");
  reader.onlyKeys(oldTrees, "oldTrees", ["share", "size"]);
  const treeRules = reader.object(obj.treeRules ?? {}, "treeRules");
  reader.onlyKeys(treeRules, "treeRules", ["shore", "line", "slope"]);
  const sky = reader.object(obj.sky ?? {}, "sky");
  reader.onlyKeys(sky, "sky", ["fogStart", "fogEnd"]);
  const light = reader.object(obj.light ?? {}, "light");
  reader.onlyKeys(light, "light", ["ambientDay", "ambientDayIntensity", "sunHorizon", "sunZenith", "sunIntensity"]);
  return {
    defaultMaterialId: reader.string(obj, "defaultMaterial", ""),
    fogStart: reader.number(sky, "fogStart", "sky", { min: 0, max: 1 }),
    fogEnd: reader.number(sky, "fogEnd", "sky", { min: 0.05, max: 1 }),
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
    materialDetail: readMaterialDetail(reader.object(obj.materialDetail, "materialDetail"), reader, "materialDetail"),
    oldTrees: {
      share: reader.number(oldTrees, "share", "oldTrees", { min: 0, max: 1 }),
      size: reader.range(oldTrees, "size", "oldTrees", { allowEqual: true }),
    },
  };
}

function readMaterialDetail(obj: RawObject, reader: Reader, path: string, fallback?: MaterialDetail): MaterialDetail {
  reader.onlyKeys(obj, path, ["scale", "strength"]);
  return {
    scale: fallback && obj.scale === undefined ? fallback.scale : reader.number(obj, "scale", path, { min: 1, max: 64 }),
    strength: fallback && obj.strength === undefined ? fallback.strength : reader.number(obj, "strength", path, { min: 0, max: 2 }),
  };
}

function readLayer(obj: RawObject, reader: Reader, path: string, id: string): MaterialLayer {
  return { id, materialId: reader.string(obj, "material", path), weight: readPipeline(obj.weight, reader, joinPath(path, "weight")) };
}

function readUniversalLayer(id: string, obj: RawObject, reader: Reader): { layer: MaterialLayer; roadSurface: boolean } {
  reader.onlyKeys(obj, "", ["material", "weight", "roadSurface"]);
  return { layer: readLayer(obj, reader, "", id), roadSurface: reader.boolean(obj, "roadSurface", "", false) };
}

/**
 * A material and, if it borrows another's texture (`textureFrom`), whose - resolved once every
 * material is read, since the one it names may be in any file of any pack. Until then its `texture`
 * is an empty stand-in.
 */
function readMaterial(id: string, obj: RawObject, reader: Reader, defaults: Defaults): { def: MaterialDef; textureFrom?: string } {
  reader.onlyKeys(obj, "", ["name", "family", "texture", "textureFrom", "adjust", "grass", "clearsGrass", "detail", "uvScale", "floats"]);
  const textureFrom = reader.optionalString(obj, "textureFrom", "");
  if (textureFrom !== undefined && reader.has(obj, "texture")) reader.fail("textureFrom", "a material has its own texture or borrows one with textureFrom, not both");
  if (textureFrom === undefined && !reader.has(obj, "texture")) reader.fail("texture", "expected a texture, or textureFrom naming the material whose texture this one draws");
  const def: MaterialDef = {
    id,
    name: reader.string(obj, "name", ""),
    textureId: id,
    texture: textureFrom === undefined ? readTexture(obj.texture, reader, "texture") : { bumpStrength: 0, pipeline: { noises: [], steps: [] } },
    adjust: obj.adjust === undefined ? NO_ADJUST : readColorAdjust(reader.object(obj.adjust, "adjust"), reader, "adjust"),
    family: reader.optionalString(obj, "family", ""),
    grass: reader.optionalArray(obj, "grass", "").map((raw, i) => {
      const path = `grass[${i}]`;
      const spec = reader.object(raw, path);
      reader.onlyKeys(spec, path, ["kind", "density", "color"]);
      return { kind: reader.string(spec, "kind", path), density: reader.number(spec, "density", path, { min: 0 }), color: reader.color(spec, "color", path) };
    }),
    clearsGrass: reader.optionalNumber(obj, "clearsGrass", "", 0, { min: 0 }),
    uvScale: reader.optionalNumber(obj, "uvScale", "", 1, { min: 0.125, max: 8 }),
    floats: reader.boolean(obj, "floats", "", false),
    detail: obj.detail === undefined ? defaults.materialDetail : readMaterialDetail(reader.object(obj.detail, "detail"), reader, "detail", defaults.materialDetail),
  };
  return { def, textureFrom };
}

/**
 * A biome's `treeTints`: a list of rules `{ kinds?, leaves?, bark?, stone?, snow? }`, each part a
 * colour adjustment plus an optional `spread`, and `snow` how much snow lies on them (0-1) - or a
 * single rule on its own, for every kind.
 */
function readTreeTints(obj: RawObject, reader: Reader): TreeTintRuleDef[] {
  if (obj.treeTints === undefined) return [];
  const rules = Array.isArray(obj.treeTints) ? obj.treeTints : [obj.treeTints];
  return rules.map((raw, i) => {
    const path = Array.isArray(obj.treeTints) ? `treeTints[${i}]` : "treeTints";
    const rule = reader.object(raw, path);
    reader.onlyKeys(rule, path, ["kinds", "leaves", "bark", "stone", "snow"]);
    const part = (key: "leaves" | "bark" | "stone"): TreeTintPart => {
      const at = joinPath(path, key);
      if (rule[key] === undefined) return { adjust: NO_ADJUST, spread: { hue: 0, saturation: 0, value: 0 } };
      const { spread, ...adjust } = reader.object(rule[key], at);
      let spreadRead = { hue: 0, saturation: 0, value: 0 };
      if (spread !== undefined) {
        const s = reader.object(spread, joinPath(at, "spread"));
        reader.onlyKeys(s, joinPath(at, "spread"), ["hue", "saturation", "value"]);
        spreadRead = {
          hue: reader.optionalNumber(s, "hue", joinPath(at, "spread"), 0, { min: 0, max: 180 }),
          saturation: reader.optionalNumber(s, "saturation", joinPath(at, "spread"), 0, { min: 0, max: 1 }),
          value: reader.optionalNumber(s, "value", joinPath(at, "spread"), 0, { min: 0, max: 1 }),
        };
      }
      return { adjust: readColorAdjust(adjust, reader, at), spread: spreadRead };
    };
    return { kinds: rule.kinds === undefined ? null : reader.stringList(rule, "kinds", path), leaves: part("leaves"), bark: part("bark"), stone: part("stone"), snow: reader.optionalNumber(rule, "snow", path, 0, { min: 0, max: 1 }) };
  });
}

/** See colorAdjust.ts. Every key optional; left out, it changes nothing. */
function readColorAdjust(obj: RawObject, reader: Reader, path: string): ColorAdjust {
  reader.onlyKeys(obj, path, ["hue", "saturation", "value", "tint"]);
  return {
    hue: reader.optionalNumber(obj, "hue", path, NO_ADJUST.hue, { min: -180, max: 180 }),
    saturation: reader.optionalNumber(obj, "saturation", path, NO_ADJUST.saturation, { min: 0, max: 4 }),
    value: reader.optionalNumber(obj, "value", path, NO_ADJUST.value, { min: 0, max: 4 }),
    tint: reader.optionalColor(obj, "tint", path) ?? NO_ADJUST.tint,
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
  reader.onlyKeys(obj, "", ["width", "height", "sway", "fadeStart", "fadeEnd", "cluster", "wades", "blades"]);
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
  if (obj.wades !== undefined) def.wades = reader.number(obj, "wades", "", { min: 0 });
  if (obj.cluster !== undefined) {
    const cluster = reader.object(obj.cluster, "cluster");
    reader.onlyKeys(cluster, "cluster", ["scale", "coverage"]);
    def.cluster = { scale: reader.number(cluster, "scale", "cluster", { min: 0 }), coverage: reader.number(cluster, "coverage", "cluster", { min: 0, max: 1 }) };
  }
  if (blades.flowerHeads !== undefined) {
    const heads = reader.object(blades.flowerHeads, "blades.flowerHeads");
    reader.onlyKeys(heads, "blades.flowerHeads", ["count", "radius", "colors", "shape", "petals", "eye"]);
    const colors = reader.array(heads, "colors", "blades.flowerHeads").map((c, i) => reader.colorValue(c, `blades.flowerHeads.colors[${i}]`));
    if (colors.length === 0) reader.fail("blades.flowerHeads.colors", "a flowering kind needs at least one petal colour");
    def.blades.flowerHeads = {
      count: reader.number(heads, "count", "blades.flowerHeads", { min: 0, integer: true }),
      radius: reader.number(heads, "radius", "blades.flowerHeads", { min: 0 }),
      colors,
      shape: heads.shape === undefined ? "flower" : reader.oneOf(heads, "shape", "blades.flowerHeads", FLOWER_SHAPES),
      ...(heads.petals !== undefined ? { petals: reader.number(heads, "petals", "blades.flowerHeads", { min: 1, max: 40, integer: true }) } : {}),
      ...(heads.eye !== undefined ? { eye: reader.color(heads, "eye", "blades.flowerHeads") } : {}),
    };
  }
  return def;
}

const KIND_COMMON_KEYS = ["model", "tint", "scale", "growsOld"];

function readTreeKind(id: string, obj: RawObject, reader: Reader, defaults: Defaults): TreeKindDef {
  const model = obj.model === undefined ? "primitive" : reader.oneOf(obj, "model", "", ["primitive", "branching", "conifer"] as const);
  // Only a tree can stand in the water.
  const common = [...KIND_COMMON_KEYS, "wetFeet"];
  const shape =
    model === "branching"
      ? readBranchingTree(obj, reader, common)
      : model === "conifer"
        ? readConiferTree(obj, reader, common)
        : readPrimitiveTree(obj, reader, common);
  return { id, shape, ...readKindLook(obj, reader, defaults), growsOld: reader.boolean(obj, "growsOld", "", false), wetFeet: reader.boolean(obj, "wetFeet", "", false) };
}

/**
 * A rock kind: a boulder, with the look every kind has (tint pair, scale, growsOld). Its stone is a
 * texture graph of its own, or a material's - filled in once the materials are read.
 */
function readRockKind(id: string, obj: RawObject, reader: Reader, defaults: Defaults): { def: TreeKindDef; stoneMaterial?: string; stoneAdjust: ColorAdjust } {
  if (obj.model !== undefined) reader.oneOf(obj, "model", "", ["boulder"] as const);
  reader.onlyKeys(obj, "", [...KIND_COMMON_KEYS, "variants", "radius", "squash", "stretch", "lumps", "taper", "facets", "facetDepth", "tilt", "sink", "stone"]);
  const stone = reader.object(obj.stone, "stone");
  reader.onlyKeys(stone, "stone", ["tile", "texture", "material", "adjust"]);
  const stoneMaterial = reader.optionalString(stone, "material", "stone") || undefined;
  if ((stoneMaterial === undefined) === (stone.texture === undefined)) reader.fail("stone", "expected either a texture or the material whose texture it is");
  const stoneAdjust = stone.adjust === undefined ? NO_ADJUST : readColorAdjust(reader.object(stone.adjust, "stone.adjust"), reader, "stone.adjust");
  const facets = reader.range(obj, "facets", "", { allowEqual: true });
  if (facets[0] < 0 || !Number.isInteger(facets[0]) || !Number.isInteger(facets[1])) reader.fail("facets", "expected whole numbers of faces, at least 0");
  const shape: BoulderShape = {
    model: "boulder",
    variants: reader.number(obj, "variants", "", { min: 1, max: 16, integer: true }),
    radius: reader.number(obj, "radius", "", { min: 0.05 }),
    squash: reader.range(obj, "squash", "", { allowEqual: true }),
    stretch: reader.range(obj, "stretch", "", { allowEqual: true }),
    lumps: reader.number(obj, "lumps", "", { min: 0, max: 1 }),
    taper: obj.taper === undefined ? 0 : reader.number(obj, "taper", "", { min: 0, max: 0.95 }),
    facets,
    facetDepth: reader.number(obj, "facetDepth", "", { min: 0, max: 0.9 }),
    tilt: reader.number(obj, "tilt", "", { min: 0, max: 90 }),
    sink: typeof obj.sink === "number" ? [reader.number(obj, "sink", "", { min: 0, max: 0.9 }), obj.sink] : reader.range(obj, "sink", "", { allowEqual: true }),
    stone: {
      tile: reader.number(stone, "tile", "stone", { min: 0.1 }),
      // A material's texture is filled in once the materials are known.
      texture: stoneMaterial === undefined ? readTexture(stone.texture, reader, "stone.texture") : { bumpStrength: 0, pipeline: { noises: [], steps: [] } },
      adjust: adjustMatrix(stoneAdjust),
    },
  };
  return { def: { id, shape, ...readKindLook(obj, reader, defaults), growsOld: reader.boolean(obj, "growsOld", "", false) }, stoneMaterial, stoneAdjust };
}

function readBushKind(id: string, obj: RawObject, reader: Reader, defaults: Defaults): TreeKindDef {
  if (obj.model !== undefined) reader.oneOf(obj, "model", "", ["bush"] as const);
  return { id, shape: readBush(obj, reader), ...readKindLook(obj, reader, defaults), growsOld: false };
}

/** What every tree and bush kind has besides its shape: its tint pair and its scale range. */
function readKindLook(obj: RawObject, reader: Reader, defaults: Defaults): Pick<TreeKindDef, "tint" | "scale"> {
  const tint = reader.array(obj, "tint", "").map((c, i) => reader.colorValue(c, `tint[${i}]`));
  if (tint.length !== 2) reader.fail("tint", "expected two colours: [darkest, lightest]");
  return {
    tint: [tint[0] ?? [1, 1, 1], tint[1] ?? [1, 1, 1]],
    scale: obj.scale === undefined ? defaults.treeScale : reader.range(obj, "scale", "", { allowEqual: true }),
  };
}

function readBushBed(obj: RawObject, reader: Reader): BushBed | null {
  if (obj.bed === undefined) return null;
  const bed = reader.object(obj.bed, "bed");
  reader.onlyKeys(bed, "bed", ["plants", "spread"]);
  const plants = reader.range(bed, "plants", "bed", { allowEqual: true });
  if (plants[0] < 1 || !Number.isInteger(plants[0]) || !Number.isInteger(plants[1])) reader.fail("bed.plants", "expected whole numbers of plants, at least 1");
  return { plants, spread: reader.number(bed, "spread", "bed", { min: 0 }) };
}

/** A frond plant's fronds (a fern bush's, or a tree fern's crown) - `key` names the field. */
function readFronds(value: unknown, reader: Reader, key: string): Fronds {
  const f = reader.object(value, key);
  reader.onlyKeys(f, key, ["count", "length", "width", "angle", "curl", "fold", "segments", "stalk"]);
  const stalk = f.stalk === undefined ? null : reader.object(f.stalk, `${key}.stalk`);
  if (stalk) reader.onlyKeys(stalk, `${key}.stalk`, ["length", "width"]);
  const count = reader.range(f, "count", key, { allowEqual: true });
  if (count[0] < 1 || !Number.isInteger(count[0]) || !Number.isInteger(count[1])) reader.fail(`${key}.count`, "expected whole numbers of fronds, at least 1");
  return {
    count,
    length: reader.range(f, "length", key, { allowEqual: true }),
    width: reader.number(f, "width", key, { min: 0.01 }),
    angle: reader.range(f, "angle", key, { allowEqual: true }),
    curl: reader.number(f, "curl", key),
    fold: reader.optionalNumber(f, "fold", key, 0.15, { min: 0, max: 1 }),
    segments: reader.optionalNumber(f, "segments", key, 4, { min: 1, max: 12, integer: true }),
    stalk: stalk
      ? { length: reader.range(stalk, "length", `${key}.stalk`, { allowEqual: true }), width: reader.number(stalk, "width", `${key}.stalk`, { min: 0.005 }) }
      : null,
  };
}

/** A bush's foliage atlas (also a tree fern's crown's). */
function readBushTexture(foliage: RawObject, reader: Reader): BushTexture {
  reader.onlyKeys(foliage, "foliage", ["builder", "dark", "light", "stem", "stems", "leaves", "leafLength", "leafWidth", "bare"]);
  const stems = reader.range(foliage, "stems", "foliage", { allowEqual: true });
  if (stems[0] < 1 || !Number.isInteger(stems[0]) || !Number.isInteger(stems[1])) reader.fail("foliage.stems", "expected whole numbers of stems, at least 1");
  return {
    builder: reader.oneOf(foliage, "builder", "foliage", BUSH_FOLIAGE_BUILDERS),
    dark: reader.color(foliage, "dark", "foliage"),
    light: reader.color(foliage, "light", "foliage"),
    stem: reader.color(foliage, "stem", "foliage"),
    stems,
    leaves: reader.number(foliage, "leaves", "foliage", { min: 1, integer: true }),
    leafLength: reader.number(foliage, "leafLength", "foliage", { min: 0.01, max: 1 }),
    leafWidth: reader.number(foliage, "leafWidth", "foliage", { min: 0.01, max: 1 }),
    bare: reader.number(foliage, "bare", "foliage", { min: 0, max: 0.9 }),
  };
}

function readBush(obj: RawObject, reader: Reader): BushShape {
  reader.onlyKeys(obj, "", [...KIND_COMMON_KEYS.filter((key) => key !== "growsOld"), "variants", "width", "height", "cards", "clumps", "clumpSize", "fronds", "bed", "foliage"]);
  // A frond plant has no cards or clumps - its fronds are its geometry.
  const fronds = obj.fronds === undefined ? null : readFronds(obj.fronds, reader, "fronds");
  return {
    model: "bush",
    variants: reader.number(obj, "variants", "", { min: 1, max: 16, integer: true }),
    width: reader.range(obj, "width", "", { allowEqual: true }),
    height: reader.range(obj, "height", "", { allowEqual: true }),
    cards: fronds && obj.cards === undefined ? 0 : reader.number(obj, "cards", "", { min: 1, max: 8, integer: true }),
    clumps: fronds && obj.clumps === undefined ? 0 : reader.number(obj, "clumps", "", { min: 0, max: 32, integer: true }),
    clumpSize: fronds && obj.clumpSize === undefined ? [1, 1] : reader.range(obj, "clumpSize", "", { allowEqual: true }),
    fronds,
    bed: readBushBed(obj, reader),
    foliage: readBushTexture(reader.object(obj.foliage, "foliage"), reader),
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

function readConiferTree(obj: RawObject, reader: Reader, common: string[]): ConiferTree {
  reader.onlyKeys(obj, "", [...common, "variants", "trunk", "roots", "tiers", "bark", "foliage"]);
  const section = (key: string, keys: string[]): RawObject => {
    const value = reader.object(obj[key], key);
    reader.onlyKeys(value, key, keys);
    return value;
  };
  const trunk = section("trunk", ["height", "radius", "topRadius", "lean", "bend", "wobble", "flare", "flareHeight", "sides", "rings"]);
  const roots = section("roots", ["count", "length", "radius", "drop", "sides", "rings"]);
  const tiers = section("tiers", ["count", "from", "radius", "height", "droop", "panels", "breadth", "arch", "tilt", "variety"]);
  const bark = section("bark", ["tile", "texture"]);
  const foliage = section("foliage", ["builder", "dark", "light", "twig", "twigs", "needleLength", "needleWidth", "needleGap"]);
  const sides = (o: RawObject, path: string): number => reader.number(o, "sides", path, { min: 3, max: 16, integer: true });
  const rings = (o: RawObject, path: string): number => reader.number(o, "rings", path, { min: 1, max: 16, integer: true });
  const count = reader.range(tiers, "count", "tiers", { allowEqual: true });
  if (count[0] < 1 || !Number.isInteger(count[0]) || !Number.isInteger(count[1])) reader.fail("tiers.count", "expected whole numbers of tiers, at least 1");
  // Both [lowest, topmost]: a crown narrows upwards, but either is allowed to be the larger.
  const pair = (o: RawObject, key: string, path: string): [number, number] => {
    const value = o[key];
    if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === "number" && v > 0)) {
      reader.fail(`${path}.${key}`, "expected [lowest tier, topmost tier], both above 0");
      return [1, 1];
    }
    return [value[0], value[1]];
  };
  return {
    model: "conifer",
    variants: reader.number(obj, "variants", "", { min: 1, max: 16, integer: true }),
    trunk: {
      height: reader.number(trunk, "height", "trunk", { min: 1 }),
      radius: reader.number(trunk, "radius", "trunk", { min: 0.05 }),
      topRadius: reader.number(trunk, "topRadius", "trunk", { min: 0.01 }),
      lean: reader.number(trunk, "lean", "trunk"),
      bend: reader.number(trunk, "bend", "trunk", { min: 0 }),
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
    tiers: {
      count,
      from: reader.number(tiers, "from", "tiers", { min: 0, max: 1 }),
      radius: pair(tiers, "radius", "tiers"),
      height: pair(tiers, "height", "tiers"),
      droop: reader.number(tiers, "droop", "tiers", { min: 0 }),
      panels: reader.number(tiers, "panels", "tiers", { min: 3, max: 24, integer: true }),
      breadth: reader.number(tiers, "breadth", "tiers", { min: 0.2, max: 1.6 }),
      arch: reader.number(tiers, "arch", "tiers", { min: 0, max: 1.5 }),
      tilt: reader.number(tiers, "tilt", "tiers", { min: 0 }),
      variety: reader.number(tiers, "variety", "tiers", { min: 0, max: 0.8 }),
    },
    bark: {
      tile: reader.number(bark, "tile", "bark", { min: 0.1 }),
      texture: readTexture(bark.texture, reader, "bark.texture"),
    },
    foliage: {
      builder: reader.oneOf(foliage, "builder", "foliage", CONIFER_FOLIAGE_BUILDERS),
      dark: reader.color(foliage, "dark", "foliage"),
      light: reader.color(foliage, "light", "foliage"),
      twig: reader.color(foliage, "twig", "foliage"),
      twigs: reader.number(foliage, "twigs", "foliage", { min: 1, max: 40, integer: true }),
      needleLength: reader.number(foliage, "needleLength", "foliage", { min: 0.005, max: 0.5 }),
      needleWidth: reader.number(foliage, "needleWidth", "foliage", { min: 0.002, max: 0.2 }),
      needleGap: reader.number(foliage, "needleGap", "foliage", { min: 0.002, max: 0.2 }),
    },
  };
}

function readBranchingTree(obj: RawObject, reader: Reader, common: string[]): BranchingTree {
  reader.onlyKeys(obj, "", [...common, "variants", "trunk", "roots", "branches", "leaves", "crown", "vines", "bark", "foliage"]);
  const section = (key: string, keys: string[]): RawObject => {
    const value = reader.object(obj[key], key);
    reader.onlyKeys(value, key, keys);
    return value;
  };
  const trunk = section("trunk", ["height", "radius", "topRadius", "lean", "wobble", "flare", "flareHeight", "bulge", "bulgeAt", "sides", "rings"]);
  const roots = section("roots", ["count", "length", "radius", "drop", "sides", "rings", "buttress", "stilt"]);
  const buttress = roots.buttress === undefined ? null : reader.object(roots.buttress, "roots.buttress");
  if (buttress) reader.onlyKeys(buttress, "roots.buttress", ["height", "thickness"]);
  const branches = section("branches", ["count", "from", "length", "radius", "angle", "arc", "broken", "crook", "sides", "rings", "twigs"]);
  const twigs = reader.object(branches.twigs, "branches.twigs");
  reader.onlyKeys(twigs, "branches.twigs", ["count", "length", "angle", "sides", "rings"]);
  // A bare tree - a dead one - has neither leaves (nor a frond crown) nor the foliage they are cut from.
  const leafyVines = isObject(obj.vines) && obj.vines.leaves !== undefined;
  const leafy = obj.leaves !== undefined || obj.crown !== undefined || leafyVines;
  if (leafy !== (obj.foliage !== undefined)) reader.fail("foliage", "a tree with leaves, a crown or leafy vines has foliage; a bare tree has none of them");
  const bare = obj.leaves === undefined;
  const leaves = bare ? {} : section("leaves", ["size", "cards", "alongBranch", "top", "spread", "squash", "level"]);
  const crown = obj.crown === undefined ? null : readFronds(obj.crown, reader, "crown");
  const vinesObj = obj.vines === undefined ? null : section("vines", ["count", "length", "radius", "loops", "leaves"]);
  const vineLeaves = vinesObj?.leaves === undefined ? null : reader.object(vinesObj.leaves, "vines.leaves");
  if (vineLeaves) reader.onlyKeys(vineLeaves, "vines.leaves", ["width", "tile", "arch", "taper"]);
  const bark = section("bark", ["tile", "texture"]);
  const foliageObj = obj.foliage === undefined ? null : reader.object(obj.foliage, "foliage");
  // A frond crown's atlas is a bush's (a fern's, a palm's, a broad leaf's); leaf clusters' are the broadleaf's.
  const readTreeFoliage = (f: RawObject): FoliageTexture | BushTexture => {
    if (f.builder !== "broadleaf" && f.builder !== "featherSpray") return readBushTexture(f, reader);
    reader.onlyKeys(f, "foliage", ["builder", "dark", "light", "leaves", "leafLength", "leafWidth", "moss"]);
    // One kind of moss, or `{ oneOf: [a, b] }` - two, each tree picking one.
    const mossObj = f.moss === undefined ? null : reader.object(f.moss, "foliage.moss");
    const mossKinds = !mossObj ? [] : "oneOf" in mossObj ? reader.array(mossObj, "oneOf", "foliage.moss").map((m, i) => ({ m, path: `foliage.moss.oneOf.${i}` })) : [{ m: mossObj as unknown, path: "foliage.moss" }];
    if (mossObj && "oneOf" in mossObj) {
      reader.onlyKeys(mossObj, "foliage.moss", ["oneOf"]);
      if (mossKinds.length < 1 || mossKinds.length > 2) reader.fail("foliage.moss.oneOf", "one or two kinds of moss - the atlas has two cells for it");
    }
    const moss = mossKinds.map(({ m, path }) => {
      const o = reader.object(m, path);
      reader.onlyKeys(o, path, ["dark", "light", "threads", "curls", "sway"]);
      return {
        dark: reader.color(o, "dark", path),
        light: reader.color(o, "light", path),
        threads: reader.number(o, "threads", path, { min: 1, integer: true }),
        curls: reader.optionalNumber(o, "curls", path, 10, { min: 0 }),
        sway: reader.optionalNumber(o, "sway", path, 0.07, { min: 0, max: 0.5 }),
      };
    });
    return {
      builder: reader.oneOf(f, "builder", "foliage", FOLIAGE_BUILDERS),
      dark: reader.color(f, "dark", "foliage"),
      light: reader.color(f, "light", "foliage"),
      leaves: reader.number(f, "leaves", "foliage", { min: 1, integer: true }),
      leafLength: reader.number(f, "leafLength", "foliage", { min: 0.01, max: 1 }),
      leafWidth: reader.number(f, "leafWidth", "foliage", { min: 0.01, max: 1 }),
      moss: moss.length > 0 ? moss : null,
    };
  };
  const optional = (o: RawObject, key: string, path: string, fallback: number, bounds: { min?: number; max?: number }): number =>
    o[key] === undefined ? fallback : reader.number(o, key, path, bounds);
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
      bulge: optional(trunk, "bulge", "trunk", 0, { min: 0, max: 3 }),
      bulgeAt: optional(trunk, "bulgeAt", "trunk", 0.35, { min: 0, max: 1 }),
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
      buttress: buttress
        ? { height: reader.number(buttress, "height", "roots.buttress", { min: 0.1 }), thickness: reader.number(buttress, "thickness", "roots.buttress", { min: 0.02 }) }
        : null,
      stilt: roots.stilt === undefined ? null : reader.range(roots, "stilt", "roots", { allowEqual: true }),
    },
    branches: {
      count: count(branches, "count", "branches"),
      from: reader.number(branches, "from", "branches", { min: 0, max: 1 }),
      length: reader.range(branches, "length", "branches", { allowEqual: true }),
      radius: reader.number(branches, "radius", "branches", { min: 0 }),
      angle: reader.range(branches, "angle", "branches", { allowEqual: true }),
      arc: reader.number(branches, "arc", "branches"),
      broken: optional(branches, "broken", "branches", 0, { min: 0, max: 1 }),
      crook: optional(branches, "crook", "branches", 0, { min: 0, max: 0.5 }),
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
    leaves: bare
      ? null
      : {
          size: reader.range(leaves, "size", "leaves", { allowEqual: true }),
          cards: reader.number(leaves, "cards", "leaves", { min: 1, max: 8, integer: true }),
          alongBranch: reader.number(leaves, "alongBranch", "leaves", { min: 0, integer: true }),
          top: reader.number(leaves, "top", "leaves", { min: 0, integer: true }),
          spread: reader.number(leaves, "spread", "leaves", { min: 0 }),
          squash: optional(leaves, "squash", "leaves", 1, { min: 0.05, max: 1 }),
          level: optional(leaves, "level", "leaves", 0, { min: 0, max: 1 }),
        },
    crown,
    vines: vinesObj
      ? {
          count: count(vinesObj, "count", "vines"),
          length: reader.range(vinesObj, "length", "vines", { allowEqual: true }),
          radius: reader.number(vinesObj, "radius", "vines", { min: 0.01 }),
          loops: reader.optionalNumber(vinesObj, "loops", "vines", 0.3, { min: 0, max: 1 }),
          leaves: vineLeaves
            ? {
                width: reader.number(vineLeaves, "width", "vines.leaves", { min: 0.05 }),
                tile: reader.optionalNumber(vineLeaves, "tile", "vines.leaves", reader.number(vineLeaves, "width", "vines.leaves", { min: 0.05 }), { min: 0.05 }),
                arch: reader.optionalNumber(vineLeaves, "arch", "vines.leaves", 1, { min: 0 }),
                taper: reader.optionalNumber(vineLeaves, "taper", "vines.leaves", 0, { min: 0, max: 1 }),
              }
            : null,
        }
      : null,
    bark: {
      tile: reader.number(bark, "tile", "bark", { min: 0.1 }),
      texture: readTexture(bark.texture, reader, "bark.texture"),
    },
    foliage: foliageObj ? readTreeFoliage(foliageObj) : null,
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

/** Biome fields read before an area has a roll - what picks the biome, and what it is called. */
const UNROLLED_BIOME_KEYS = ["name", "spawnWeight"] as const;

/** Whether a biome file rolls anything (biomeRolls.ts) - one that does not needs no rolling per area. */
function hasRolls(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRolls);
  if (!isObject(value)) return false;
  return "range" in value || "between" in value || "oneOf" in value || "chance" in value || Object.values(value).some(hasRolls);
}

/** A biome file rolled by `roller`, then read as any biome is. */
function readRolledBiome(
  id: string,
  source: RawObject,
  roller: Roller,
  reader: Reader,
  defaults: Defaults,
  styles: Map<string, SettlementStyle>,
  seedKey: string,
): BiomeDefinition {
  const rolled = rollValue(source, roller, reader);
  const expanded = expandGenerators(rolled, reader);
  return { ...readBiome(id, reader.object(expanded, ""), reader, defaults, styles), seedKey };
}

/**
 * `biome` as area `areaId` of the world made from `seed` has it: its file rolled with the area's
 * own dice, and its noises seeded by the area - always, even for a biome that rolls nothing, so two
 * areas of one biome never share a pattern. Deterministic, so the main thread and every chunk
 * worker agree on every area without being told.
 */
export function rollAreaBiome(seed: number, areaId: number, biome: BiomeDefinition, content: WorldContent): BiomeDefinition {
  const seedKey = `${biome.id}@${areaId}`;
  const source = content.biomeSources[biome.id];
  if (!source?.rolls) return { ...biome, seedKey };
  const issues: ContentIssue[] = [];
  const styles = new Map(content.settlementStyles.map((style) => [style.id, style]));
  const random = randomRoller(mulberry32(deriveSeed(deriveSeed(seed, AREA_ROLL_SALT), areaId)));
  const rolled = readRolledBiome(biome.id, source.data, random, new Reader(issues, source.file), content.biomeDefaults, styles, seedKey);
  // Every extreme was read when the packs loaded (checkRoller), so this is not expected - but an
  // area must never be half-read.
  if (issues.length > 0) throw new ContentError(issues);
  return rolled;
}

function readBiome(id: string, obj: RawObject, reader: Reader, defaults: Defaults, styles: Map<string, SettlementStyle>): Omit<BiomeDefinition, "seedKey"> {
  reader.onlyKeys(obj, "", [
    "name",
    "voice",
    "spawnWeight",
    "lakeChance",
    "borderType",
    "height",
    "trees",
    "bushes",
    "rocks",
    "treeRules",
    "treeTints",
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
  reader.onlyKeys(ground, "ground", ["base", "road", "layers", "adjust", "tints", "grass"]);
  const materialLayers = reader.optionalArray(ground, "layers", "ground").map((raw, i) => {
    const path = `ground.layers[${i}]`;
    const layer = reader.object(raw, path);
    reader.onlyKeys(layer, path, ["id", "material", "weight"]);
    return readLayer(layer, reader, path, reader.optionalString(layer, "id", path) ?? `${id}-${i}`);
  });

  const sky = reader.object(obj.sky, "sky");
  reader.onlyKeys(sky, "sky", ["horizon", "zenith", "cloud", "fogStart", "fogEnd"]);

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
      bushes: obj.bushes === undefined ? undefined : readPipeline(obj.bushes, reader, "bushes"),
      rocks: obj.rocks === undefined ? undefined : readPipeline(obj.rocks, reader, "rocks"),
    },
    borderType: obj.borderType === undefined ? "mountain" : reader.oneOf(obj, "borderType", "", BORDER_TYPES),
    spawnWeight: reader.number(obj, "spawnWeight", "", { min: 0 }),
    lakeChance: reader.optionalNumber(obj, "lakeChance", "", 0, { min: 0, max: 1 }),
    baseMaterialId: reader.string(ground, "base", "ground"),
    roadMaterialId: reader.string(ground, "road", "ground"),
    materialLayers,
    groundAdjust: ground.adjust === undefined ? NO_ADJUST : readColorAdjust(reader.object(ground.adjust, "ground.adjust"), reader, "ground.adjust"),
    groundTints: reader.optionalArray(ground, "tints", "ground").map((raw, i) => {
      const path = `ground.tints[${i}]`;
      const { family, ...adjust } = reader.object(raw, path);
      if (typeof family !== "string" || family === "") reader.fail(joinPath(path, "family"), "expected the family of materials this tint recolours");
      return { family: String(family ?? ""), adjust: readColorAdjust(adjust, reader, path) };
    }),
    groundGrass: reader.optionalArray(ground, "grass", "ground").map((raw, i) => {
      const path = `ground.grass[${i}]`;
      const spec = reader.object(raw, path);
      reader.onlyKeys(spec, path, ["family", "kind", "density", "color"]);
      return {
        family: reader.string(spec, "family", path),
        spec: { kind: reader.string(spec, "kind", path), density: reader.number(spec, "density", path, { min: 0 }), color: reader.color(spec, "color", path) },
      };
    }),
    treeRules: readTreeRules(obj, reader, defaults.treeRules),
    treeTints: readTreeTints(obj, reader),
    settlementStyle,
    atmosphere: {
      horizon: reader.color(sky, "horizon", "sky"),
      zenith: reader.color(sky, "zenith", "sky"),
      cloud: reader.color(sky, "cloud", "sky"),
      fogStartFraction: reader.optionalNumber(sky, "fogStart", "sky", defaults.fogStart, { min: 0, max: 1 }),
      fogEndFraction: reader.optionalNumber(sky, "fogEnd", "sky", defaults.fogEnd, { min: 0.05, max: 1 }),
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
