import { VOICE_NAME_TOKENS, type FeatureNaming } from "../naming/nameGenerator";
import { PROP_LABELS } from "../props/propTypes";
import JSON5 from "json5";
import { DEFAULT_CONFIG, ROOT_KINDS, type WorldConfig } from "./worldConfig";
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
import { PAD_BLEND_MAX, PAD_BLEND_MIN, PAD_SIDE_SLOPE, SETTLEMENT_TIERS, STREET_KINDS, type SettlementStyle, type SettlementTier, type SettlementTierDef } from "../settlements/settlementConfig";
import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";
import { coolNightTone, deriveNightIntensity } from "../lighting/dayNightMath";
import { ContentError, isObject, joinPath, Reader, type ContentIssue, type RawObject } from "./contentReader";
import { DEFAULT_SNOW_MATERIAL, expandGenerators, FAILED_GENERATOR } from "./generators";
import { readPipeline } from "./pipelineReader";
import { checkPlans, checkRoller, describeCheckPlan, MIDDLE_ROLLER, randomRoller, rollValue, type Roller } from "./biomeRolls";
import { deriveSeed, mulberry32 } from "../rng";
import { AREA_ROLL_SALT } from "../cells/config";
import type { WorldContent } from "./worldContent";
import { ALL_DIMENSIONS, checkDimensions, dimensionBiomes, dimensionShape, IMPLICIT_DIMENSION, readDimension, type DimensionDef } from "./dimensions";
import type { GroupMember, Mount, PropDef, PropLight, PropGroupDef, PropPaint, PropSettings, Spill } from "../props/propTypes";
import { PROP_GENERATORS } from "../props/generators/index";
import { isLineProp } from "../props/propGenerator";
import type { TextureDef } from "../materials/textureGen";
import { adjustMatrix, chainMatrix, NO_ADJUST, type ColorAdjust } from "../materials/colorAdjust";
import type { WeatherChance, WeatherDef } from "../weather/weatherTypes";
import {
  BOUNDARY_OPENINGS,
  COMPOUND_ARRANGEMENTS,
  COMPOUND_PLACES,
  type GravesSpec,
  PROP_ANCHORS,
  type BoundaryOpeningSpec,
  type CompoundBoundarySpec,
  type CompoundPropSpec,
  COMPOUND_DOORS,
  FEATURE_TYPES,
  NO_FEATURE,
  TRAIL_DESTINATIONS,
  type CompoundBuildingSpec,
  type CompoundSpec,
  type CompoundTrailSpec,
  type FeatureChance,
  type FeatureKindDef,
  type PlaceRoadSpec,
  type QuarrySpec,
} from "../features/featureTypes";
import {
  BUILDING_GENERATORS,
  BUILDING_PART_GENERATORS,
  HOUSE_PARTS,
  OPTIONAL_HOUSE_PARTS,
  HOUSE_PLAN_GENERATORS,
  LEAN_TO_WALLS,
  PORCH_WALLS,
  type LeanToSpec,
  type PorchPlanSpec,
  type CabinPlanSettings,
  INTERIOR_GENERATORS,
  ROOM_LEVELS,
  STAIR_STYLES,
  WINDOW_INSIDES,
  FURNISH_SPOTS,
  type FurnishEntry,
  PARAPET_STYLES,
  RIDGE_PROFILES,
  ROOF_TYPES,
  STOREY_KINDS,
  WALL_SIDES,
  type BuildingDef,
  type BuildingMaterialDef,
  type BuildingPartDef,
  type HousePart,
  type HousePlanSettings,
  type RoomRequest,
  type RoomSurface,
  type RoomTypeDef,
  type StallsSpec,
  type HouseSpec,
  type PartChoice,
  type PitchedRoofSpec,
  type RoofType,
  type StoreyKind,
  type WallExtra,
  type WallSide,
  type Rgb,
  type WindowLight,
} from "../buildings/buildingTypes";

/** One pack as found on disk: its folder name and every .json5 file in it, by path inside it. */
export interface PackSource {
  id: string;
  files: { path: string; text: string }[];
}

/** The folders a pack's content lives in, one kind of definition each. A definition's id is its
 *  file name, and a pack with a higher priority replaces a lower one's definition of the same id. */
const CONTENT_FOLDERS = ["dimensions", "biomes", "materials", "layers", "grass", "trees", "bushes", "rocks", "voices", "borderHills", "settlements", "weathers", "features", "buildings", "buildingParts", "buildingMaterials", "rooms", "props", "propGroups"] as const;
type ContentFolder = (typeof CONTENT_FOLDERS)[number];

/** The folders gameplay content lives in - stats, resources, templates (see ENTITIES.md). Not world
 *  content: the world's resolver passes over them, and the game rules' resolver reads them, once per
 *  server. */
export const GAME_FOLDERS = ["stats", "modifiers", "resources", "entities"] as const;

/** The folders characters' bodies are drawn from - races, gear, outfits (see CHARACTERS.md). Read by
 *  the client alone (src/character); the world's resolver passes over them too. */
export const CHARACTER_FOLDERS = ["races", "gearMaterials"] as const;

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

export function parseFile(file: string, text: string, issues: ContentIssue[]): unknown {
  try {
    return JSON5.parse(text);
  } catch (error) {
    const e = error as { lineNumber?: number; columnNumber?: number; message?: string };
    const where = e.lineNumber !== undefined ? `line ${e.lineNumber}, column ${e.columnNumber}` : "";
    issues.push({ file, path: where, message: (e.message ?? String(error)).replace(/^JSON5: /, "").replace(/ at \d+:\d+$/, "") });
    return undefined;
  }
}

/** The packs in the order they load - by their manifests' `priority`, lowest first, then by id - so a
 *  later one's definition replaces an earlier one's. Problems with a manifest go in `issues`. */
export function orderPacks(packs: PackSource[], issues: ContentIssue[]): PackSource[] {
  return packs
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
}

/**
 * Turns the packs into one WorldContent: parses every file, lets higher-priority packs replace
 * definitions by id, applies patches, expands generators, and checks every field and every
 * reference between definitions. Throws a ContentError listing every problem found.
 *
 * The content is one dimension's (see DIMENSIONS.md): `dimension` by id, the start dimension if
 * null, or ALL_DIMENSIONS for every biome the config keeps.
 */
export function resolveContent(packs: PackSource[], config: WorldConfig = DEFAULT_CONFIG, dimension: string | null = null): WorldContent {
  const issues: ContentIssue[] = [];

  // --- pack order ---
  const ordered = orderPacks(packs, issues);

  // --- collect definitions, later packs replacing earlier ones ---
  const entries = new Map<ContentFolder, Map<string, Entry>>(CONTENT_FOLDERS.map((folder) => [folder, new Map()]));
  const defaultsLayers: { file: string; data: unknown }[] = [];
  const patches: { file: string; data: unknown }[] = [];

  for (const pack of ordered) {
    for (const { path, text } of pack.files) {
      if (path === "pack.json5") continue;
      const file = `${pack.id}/${path}`;
      const parts = path.split("/");
      // Gameplay content: read by the game rules' own resolver (src/sim/rules/gameRules.ts).
      if (parts.length === 2 && ([...GAME_FOLDERS, ...CHARACTER_FOLDERS] as readonly string[]).includes(parts[0])) continue;
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
        issues.push({ file, path: "", message: `not a place content is read from (expected ${[...CONTENT_FOLDERS, ...GAME_FOLDERS, ...CHARACTER_FOLDERS, "patches"].map((f) => `${f}/`).join(", ")} or defaults.json5)` });
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

  // --- dimensions: the ones the config keeps, and which one this content is for ---
  const dimensionEntries = entries.get("dimensions")!;
  const anyDimensions = dimensionEntries.size > 0;
  config.only.dimensions?.forEach((id, i) => {
    if (!dimensionEntries.has(id)) issues.push({ file: `configs/${config.name}.json5`, path: `content.only.dimensions[${i}]`, message: `no dimension "${id}" (known: ${[...dimensionEntries.keys()].join(", ")})` });
  });
  const keptDimensions = anyDimensions
    ? [...dimensionEntries.values()]
        .filter((entry) => !config.only.dimensions || config.only.dimensions.includes(entry.id))
        .sort((a, b) => compareIds(a.id, b.id))
        .map((entry) => {
          const reader = new Reader(issues, entry.file);
          return { file: entry.file, def: readDimension(entry.id, reader.object(entry.data, ""), reader) };
        })
    : [{ file: "(all packs)", def: IMPLICIT_DIMENSION }];
  if (keptDimensions.length === 0) issues.push({ file: `configs/${config.name}.json5`, path: "content.only.dimensions", message: "keeps no dimension" });
  const allBiomeIds = [...entries.get("biomes")!.keys()].sort(compareIds);
  const start = checkDimensions(keptDimensions, new Set(dimensionEntries.keys()), new Set(allBiomeIds), config.world, issues);
  const keptIds = new Set(keptDimensions.map(({ def }) => def.id));
  const dimensions: DimensionDef[] = keptDimensions.map(({ def }) => ({ ...def, start: def.id === start.id, links: def.links.filter((link) => keptIds.has(link.to)) }));
  let current = dimensions.find((def) => def.id === start.id) ?? IMPLICIT_DIMENSION;
  if (dimension !== null && dimension !== ALL_DIMENSIONS) {
    const found = dimensions.find((def) => def.id === dimension);
    if (found) current = found;
    else issues.push({ file: `configs/${config.name}.json5`, path: "", message: `no dimension "${dimension}" in this config (known: ${dimensions.map((def) => def.id).join(", ")})` });
  }

  // --- the config's whitelist and the dimension's biomes: the roots, and whatever they use (see
  // CONFIG.md). Nothing is pruned when every definition stays a root - pruning would also drop what
  // nothing uses, and the full game's world is generated from all of it.
  const available = config.only.biomes ? allBiomeIds.filter((id) => config.only.biomes!.includes(id)) : allBiomeIds;
  const only = { ...config.only };
  delete only.dimensions;
  if (dimension !== ALL_DIMENSIONS) {
    const chosen = dimensionBiomes(current, available);
    if (chosen.length !== allBiomeIds.length) only.biomes = chosen;
  }
  if (Object.keys(only).length > 0) pruneEntries(entries, { ...config, only }, [defaultsRaw, CODE_DEFAULT_IDS], issues);

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
  const weathers = readAll("weathers", (e, o, r) => readWeather(e.id, o, r));
  const weatherIds = new Set(weathers.map((w) => w.id));
  const boundaryHillStyles = readAll("borderHills", (e, o, r) => readBoundaryHillStyle(e.id, o, r));
  const buildingMaterials = readAll("buildingMaterials", (e, o, r) => readBuildingMaterial(e.id, o, r));
  const buildingMaterialIds = new Set(buildingMaterials.map((m) => m.id));
  const insideOf = new Map(buildingMaterials.map((m) => [m.id, m.inside]));
  const litOf = new Map(buildingMaterials.map((m) => [m.id, m.lit]));
  for (const m of buildingMaterials) {
    if (m.inside !== null && !buildingMaterialIds.has(m.inside)) issues.push({ file: `buildingMaterials/${m.id}`, path: "inside", message: `no building material "${m.inside}" (known: ${[...buildingMaterialIds].join(", ")})` });
    if (m.lit !== null && !buildingMaterialIds.has(m.lit)) issues.push({ file: `buildingMaterials/${m.id}`, path: "lit", message: `no building material "${m.lit}" (known: ${[...buildingMaterialIds].join(", ")})` });
  }
  const buildingParts = readAll("buildingParts", (e, o, r) => readBuildingPart(e.id, o, r));
  const partById = new Map(buildingParts.map((part) => [part.id, part]));
  // Props before rooms: a room type is furnished with them.
  const propReads = readAll("props", (e, o, r) => ({ file: e.file, def: readProp(e.id, o, r) }));
  const props = propReads.map((read) => read.def);
  const propById = new Map(props.map((prop) => [prop.id, prop]));
  const propGroups = readAll("propGroups", (e, o, r) => readPropGroup(e.id, o, r, propById));
  const groupById = new Map(propGroups.map((group) => [group.id, group]));
  const roomReads = readAll("rooms", (e, o, r) => ({ file: e.file, def: readRoomType(e.id, o, r, propById, groupById) }));
  const roomTypes = roomReads.map((read) => read.def);
  for (const { file, def } of roomReads) {
    for (const [key, surface] of [["floor", def.floor], ["walls", def.walls], ["ceiling", def.ceiling], ["beams", def.beams], ["timber", def.timber]] as const) {
      if (surface && !buildingMaterialIds.has(surface.material)) {
        issues.push({ file, path: `${key}.material`, message: `no building material "${surface.material}" (known: ${[...buildingMaterialIds].join(", ") || "none"})` });
      }
    }
  }
  const roomById = new Map(roomTypes.map((room) => [room.id, room]));
  for (const { file, def } of propReads) {
    for (const [part, paint] of Object.entries(def.parts)) {
      if (paint.material !== null && !buildingMaterialIds.has(paint.material)) {
        issues.push({ file, path: `parts.${part}.material`, message: `no building material "${paint.material}" (known: ${[...buildingMaterialIds].join(", ") || "none"})` });
      }
    }
  }
  const buildingReads = readAll("buildings", (e, o, r) => ({ file: e.file, def: readBuilding(e.id, o, r, partById, roomById) }));
  const buildings = buildingReads.map((read) => read.def);
  for (const { file, def } of buildingReads) {
    for (const part of HOUSE_PARTS) {
      const id = def.house?.parts[part].material;
      if (id !== undefined && !buildingMaterialIds.has(id)) {
        issues.push({ file, path: `house.parts.${part}.material`, message: `no building material "${id}" (known: ${[...buildingMaterialIds].join(", ") || "none"})` });
      }
      // What it is seen as from inside, its material's say.
      if (def.house && id !== undefined) def.house.parts[part].inside = insideOf.get(id) ?? null;
      // And where a lamp burns behind it.
      if (def.house && id !== undefined) def.house.parts[part].lit = litOf.get(id) ?? null;
    }
  }
  const buildingById = new Map(buildings.map((building) => [building.id, building]));
  const settlementStyles = readAll("settlements", (e, o, r) => readSettlementStyle(e.id, o, r, buildingById));
  const featureReads = readAll("features", (e, o, r) => ({ file: e.file, kind: readFeatureKind(e.id, o, r, buildingById, propById, groupById) }));
  const featureKinds = featureReads.map((read) => read.kind);
  const featureIds = new Set([NO_FEATURE, ...featureKinds.map((kind) => kind.id)]);
  const settlementFeatureIds = new Set(featureKinds.filter((kind) => kind.type === "settlement").map((kind) => kind.id));
  // The road network is planned over settlements and features alike, so a settlement has to say how
  // much it matters to it; and what a road wants to lead to must be a kind of place.
  for (const { file, kind } of featureReads) {
    if (kind.type === "settlement" && !kind.road) issues.push({ file, path: "road", message: "a settlement needs a road block: its importance per tier and how many roads it takes" });
    kind.road?.wants.forEach((want, i) => {
      if (want === NO_FEATURE || !featureIds.has(want)) issues.push({ file, path: `road.wants[${i}]`, message: `no feature "${want}" (known: ${featureKinds.map((k) => k.id).join(", ")})` });
    });
  }
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
  for (const { file, biome } of biomeReads) {
    const fence = propById.get(biome.roadFenceId);
    if (!fence) issues.push({ file, path: "roadFence", message: `no prop "${biome.roadFenceId}" (known: ${[...propById.keys()].join(", ")})` });
    else if (!isLineProp(fence)) issues.push({ file, path: "roadFence", message: `"${biome.roadFenceId}" is not laid along a line - a wall or a fence is` });
    const bridge = propById.get(biome.roadBridgeId);
    if (!bridge) issues.push({ file, path: "roadBridge", message: `no prop "${biome.roadBridgeId}" (known: ${[...propById.keys()].join(", ")})` });
    else if (!isLineProp(bridge)) issues.push({ file, path: "roadBridge", message: `"${biome.roadBridgeId}" is not laid along a line - a bridge is` });
  }

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
  for (const { file, kind } of featureReads) if (kind.ground) checkMaterial(file, "ground.material", kind.ground.materialId);
  for (const { file, kind } of featureReads) if (kind.compound?.pads.spill) checkMaterial(file, "compound.pads.spill.material", kind.compound.pads.spill.material);
  for (const { file, def } of [...propReads, ...buildingReads]) if (def.spill) checkMaterial(file, "spill.material", def.spill.material);
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
    biome.features.forEach((chance, i) => {
      if (!featureIds.has(chance.featureId)) report({ file, path: `features[${i}].feature`, message: `no feature "${chance.featureId}" (known: ${[...featureIds].join(", ")})` });
      if (settlementFeatureIds.has(chance.featureId) && chance.odds > 0 && biome.settlementStyles.length === 0) {
        report({ file, path: `features[${i}].feature`, message: `"${chance.featureId}" is a settlement, but this biome has no settlement style (\`settlement\`) to build it in` });
      }
    });
    biome.weather.forEach((chance, i) => {
      if (!weatherIds.has(chance.weatherId)) report({ file, path: `weather[${i}].weather`, message: `no weather "${chance.weatherId}" (known: ${[...weatherIds].join(", ") || "none"})` });
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
    config: config.name,
    world: dimensionShape(current, config.world),
    dimension: current,
    dimensions,
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
    weathers,
    featureKinds,
    buildings,
    buildingParts,
    buildingMaterials,
    roomTypes,
    props,
    propGroups,
  };
}

/** The props a biome's roads are fenced and bridged with, where it names none. */
const DEFAULT_ROAD_FENCE = "railFence";
const DEFAULT_ROAD_BRIDGE = "bridge";

/** Ids the code itself supplies where a file leaves one out - nothing in a file names them, so a
 *  config's whitelist keeps them as if something kept did. A new default id belongs here. */
const CODE_DEFAULT_IDS = [DEFAULT_ROAD_FENCE, DEFAULT_ROAD_BRIDGE, DEFAULT_SNOW_MATERIAL];

/** Definitions kept whatever a whitelist says: they apply everywhere. */
const ALWAYS_KEPT: readonly ContentFolder[] = ["layers"];

/**
 * Drops what a config does not want: the root kinds' definitions its `only` leaves out, then every
 * other definition nothing kept uses. A definition is used when its id turns up - as a string value
 * or an object key, anywhere - in something kept (or in `alsoKept`, the defaults); that is
 * generous, never mean, so nothing a kept definition refers to is lost.
 */
function pruneEntries(entries: Map<ContentFolder, Map<string, Entry>>, config: WorldConfig, alsoKept: unknown[], issues: ContentIssue[]): void {
  const file = `configs/${config.name}.json5`;
  const roots = new Set<ContentFolder>([...ROOT_KINDS, ...ALWAYS_KEPT]);
  for (const kind of ROOT_KINDS) {
    // Dimensions are picked before this (resolveContent), and nothing refers to them.
    if (kind === "dimensions") continue;
    const wanted = config.only[kind];
    if (!wanted) continue;
    const defined = entries.get(kind)!;
    wanted.forEach((id, i) => {
      if (!defined.has(id)) issues.push({ file, path: `content.only.${kind}[${i}]`, message: `no ${kind} "${id}" (known: ${[...defined.keys()].join(", ")})` });
    });
    for (const id of [...defined.keys()]) if (!wanted.includes(id)) defined.delete(id);
  }

  // Everything that is kept only when used, by id - several definitions can share one.
  const used = new Map<string, Entry[]>();
  for (const [folder, defined] of entries) {
    if (roots.has(folder)) continue;
    for (const entry of defined.values()) used.set(entry.id, [...(used.get(entry.id) ?? []), entry]);
  }
  const kept = new Set<Entry>();
  const pending: unknown[] = [...alsoKept];
  for (const folder of roots) for (const entry of entries.get(folder)!.values()) pending.push(entry.data);
  const visit = (text: string): void => {
    for (const entry of used.get(text) ?? []) {
      if (kept.has(entry)) continue;
      kept.add(entry);
      pending.push(entry.data);
    }
  };
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") visit(value);
    else if (Array.isArray(value)) pending.push(...value);
    else if (isObject(value)) {
      for (const [key, inner] of Object.entries(value)) {
        visit(key);
        pending.push(inner);
      }
    }
  }
  for (const [folder, defined] of entries) {
    if (roots.has(folder)) continue;
    for (const [id, entry] of [...defined]) if (!kept.has(entry)) defined.delete(id);
  }
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
  /** The weathers of a biome that names none. */
  weather: WeatherChance[];
  /** What the cells of a biome that names none roll for their feature. */
  features: FeatureChance[];
}

function readDefaults(obj: RawObject, reader: Reader): Defaults {
  reader.onlyKeys(obj, "", ["defaultMaterial", "sky", "light", "treeRules", "treeScale", "materialDetail", "oldTrees", "weather", "features"]);
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
    weather: readWeatherChances(obj, reader),
    features: readFeatureChances(obj, reader),
  };
}

/** `features: [{ feature: id, odds }]` - what a biome's cells roll for their one major feature, each
 *  as likely as its odds over the sum of them all; `feature: "none"` leaves a cell empty. */
function readFeatureChances(obj: RawObject, reader: Reader): FeatureChance[] {
  return reader.optionalArray(obj, "features", "").map((raw, i) => {
    const path = `features[${i}]`;
    const chance = reader.object(raw, path);
    reader.onlyKeys(chance, path, ["feature", "odds"]);
    return { featureId: reader.string(chance, "feature", path), odds: reader.number(chance, "odds", path, { min: 0 }) };
  });
}

/** A buildingMaterials/ file - see BuildingMaterialDef. */
function readBuildingMaterial(id: string, obj: RawObject, reader: Reader): BuildingMaterialDef {
  reader.onlyKeys(obj, "", ["name", "texture", "size", "shine", "glow", "daylight", "inside", "lit", "lamp"]);
  const size = obj.size;
  let repeat: [number, number] = [1, 1];
  if (typeof size === "number" && size > 0) repeat = [size, size];
  else if (Array.isArray(size) && size.length === 2 && size.every((v) => typeof v === "number" && v > 0)) repeat = [size[0], size[1]];
  else reader.fail("size", "expected metres per repeat: a number, or [across, up]");
  return {
    id,
    name: reader.string(obj, "name", ""),
    texture: readTexture(obj.texture, reader, "texture"),
    size: repeat,
    shine: reader.optionalNumber(obj, "shine", "", 0, { min: 0, max: 1 }),
    glow: reader.optionalNumber(obj, "glow", "", 0, { min: 0, max: 1 }),
    daylight: reader.optionalNumber(obj, "daylight", "", 0, { min: 0, max: 1 }),
    inside: obj.inside === undefined || obj.inside === null ? null : reader.string(obj, "inside", ""),
    lit: obj.lit === undefined || obj.lit === null ? null : reader.string(obj, "lit", ""),
    lamp: obj.lamp === undefined || obj.lamp === null ? null : reader.color(obj, "lamp", ""),
  };
}

/** A buildings/ file - see BuildingDef. Its generator is named by `type` (`generator` already means
 *  a content generator - see generators.ts), and its own block is under the generator's name. */
/**
 * A props/ file - see PropDef. Named by `type` (its generator), its settings under the generator's
 * name, each read as the generator's own `params` declare it - so any generator's file is read here
 * - and `parts`, what each part the generator paints is made of.
 */
/** A prop's `light: { color, intensity, radius, size }` - the light it gives - or none. */
function readLight(obj: RawObject, reader: Reader): PropLight | null {
  if (obj.light === undefined) return null;
  const light = reader.object(obj.light, "light");
  reader.onlyKeys(light, "light", ["color", "intensity", "radius", "size"]);
  return {
    color: reader.color(light, "color", "light"),
    intensity: reader.number(light, "intensity", "light", { min: 0 }),
    radius: reader.number(light, "radius", "light", { min: 0.5 }),
    size: reader.optionalNumber(light, "size", "light", 0.1, { min: 0 }),
  };
}

/** A window part's `light: { intensity, radius }` - the daylight it lets in - or none. */
function readWindowLight(obj: RawObject, reader: Reader): WindowLight | null {
  if (obj.light === undefined) return null;
  const light = reader.object(obj.light, "light");
  reader.onlyKeys(light, "light", ["intensity", "radius"]);
  return { intensity: reader.number(light, "intensity", "light", { min: 0 }), radius: reader.number(light, "radius", "light", { min: 0.5 }) };
}

/** A prop's `mount: { kind, height }` - how a room sets it down; on the floor if none. */
function readMount(obj: RawObject, reader: Reader): Mount {
  if (obj.mount === undefined) return { kind: "floor", height: [0, 0] };
  const mount = reader.object(obj.mount, "mount");
  reader.onlyKeys(mount, "mount", ["kind", "height"]);
  const kind = reader.oneOf(mount, "kind", "mount", ["floor", "wall", "ceiling"] as const);
  const height: [number, number] = mount.height === undefined ? [0, 0] : typeof mount.height === "number" ? [mount.height, mount.height] : reader.range(mount, "height", "mount", { allowEqual: true });
  return { kind, height };
}

/** A prop's or building's `spill: { material, reach }` - the ground round it painted - or none. */
function readSpill(obj: RawObject, reader: Reader): Spill | null {
  if (obj.spill === undefined) return null;
  const spill = reader.object(obj.spill, "spill");
  reader.onlyKeys(spill, "spill", ["material", "reach"]);
  return { material: reader.string(spill, "material", "spill"), reach: reader.number(spill, "reach", "spill", { min: 0.1 }) };
}

function readProp(id: string, obj: RawObject, reader: Reader): PropDef {
  const names = Object.keys(PROP_GENERATORS);
  const type = reader.oneOf(obj, "type", "", names);
  reader.onlyKeys(obj, "", ["name", "type", type, "parts", "collide", "ground", "spill", "mount", "light", "label"]);
  const generator = PROP_GENERATORS[type];
  const settings: PropSettings = {};
  if (generator) {
    const raw = obj[type] === undefined ? {} : reader.object(obj[type], type);
    reader.onlyKeys(raw, type, Object.keys(generator.params));
    for (const [key, param] of Object.entries(generator.params)) {
      const at = type;
      if (raw[key] === undefined) {
        if (param.default === null) reader.fail(`${at}.${key}`, `is needed (${param.doc})`);
        else settings[key] = param.default;
        continue;
      }
      switch (param.kind) {
        case "range":
        case "count": {
          const range = reader.range(raw, key, at, { allowEqual: true });
          if (param.min !== undefined && range[0] < param.min) reader.fail(`${at}.${key}`, `is at least ${param.min}`);
          if (param.kind === "count" && !range.every(Number.isInteger)) reader.fail(`${at}.${key}`, "is a whole number");
          settings[key] = range;
          break;
        }
        case "chance":
          settings[key] = reader.number(raw, key, at, { min: 0, max: 1 });
          break;
        case "number":
          settings[key] = reader.number(raw, key, at, { min: param.min, max: param.max });
          break;
        case "choice": {
          const list = Array.isArray(raw[key]) ? (raw[key] as unknown[]) : [raw[key]];
          const names = list.filter((value): value is string => typeof value === "string" && param.options.includes(value));
          if (names.length === 0 || names.length !== list.length) reader.fail(`${at}.${key}`, `expected one or a list of: ${param.options.join(", ")}`);
          settings[key] = names.length > 0 ? names : (param.default ?? [param.options[0]]);
          break;
        }
      }
    }
  }
  const partsRaw = reader.object(obj.parts, "parts");
  const parts: Record<string, PropPaint> = {};
  reader.onlyKeys(partsRaw, "parts", generator ? generator.parts : []);
  for (const part of generator?.parts ?? []) {
    const at = `parts.${part}`;
    if (partsRaw[part] === undefined) {
      reader.fail(at, "is needed: what it is painted");
      continue;
    }
    const raw = reader.object(partsRaw[part], at);
    reader.onlyKeys(raw, at, ["material", "tints"]);
    const tints = reader.array(raw, "tints", at).map((value, i) => reader.colorValue(value, `${at}.tints[${i}]`));
    if (tints.length === 0) reader.fail(`${at}.tints`, "needs at least one colour");
    parts[part] = { material: raw.material === undefined || raw.material === null ? null : reader.string(raw, "material", at), tints: tints.length > 0 ? tints : [[1, 1, 1]] };
  }
  return { id, name: reader.string(obj, "name", ""), generator: type, settings, parts, collide: obj.collide === undefined ? true : obj.collide === true, ground: obj.ground === undefined ? "level" : reader.oneOf(obj, "ground", "", ["level", "slope", "plumb"] as const), spill: readSpill(obj, reader), mount: readMount(obj, reader), light: readLight(obj, reader), label: obj.label === undefined ? null : reader.oneOf(obj, "label", "", PROP_LABELS) };
}

/** A rooms/ file - see RoomTypeDef. */
function readRoomType(id: string, obj: RawObject, reader: Reader, props: Map<string, PropDef>, groups: Map<string, PropGroupDef>): RoomTypeDef {
  const readStalls = (): StallsSpec => {
    const raw = reader.object(obj.stalls, "stalls");
    reader.onlyKeys(raw, "stalls", ["depth", "height"]);
    return {
      depth: reader.number(raw, "depth", "stalls", { min: 1, integer: true }),
      height: reader.number(raw, "height", "stalls", { min: 0.5 }),
    };
  };
  reader.onlyKeys(obj, "", ["name", "floor", "walls", "ceiling", "beams", "timber", "stair", "windows", "underRoof", "hearth", "stalls", "furnish"]);
  const surface = (key: string): RoomSurface => {
    const raw = reader.object(obj[key], key);
    reader.onlyKeys(raw, key, ["material", "tints"]);
    const tints = reader.array(raw, "tints", key).map((value, i) => reader.colorValue(value, `${key}.tints[${i}]`));
    if (tints.length === 0) reader.fail(`${key}.tints`, "needs at least one colour");
    return { material: reader.string(raw, "material", key), tints: tints.length > 0 ? tints : [[1, 1, 1]] };
  };
  return {
    id,
    name: reader.string(obj, "name", ""),
    floor: surface("floor"),
    walls: surface("walls"),
    ceiling: surface("ceiling"),
    beams: obj.beams === undefined || obj.beams === null ? null : surface("beams"),
    timber: surface("timber"),
    stair: obj.stair === undefined ? "solid" : reader.oneOf(obj, "stair", "", STAIR_STYLES),
    windows: obj.windows === undefined ? "glass" : reader.oneOf(obj, "windows", "", WINDOW_INSIDES),
    underRoof: obj.underRoof === true,
    hearth: obj.hearth === true,
    stalls: obj.stalls === undefined || obj.stalls === null ? null : readStalls(),
    furnish: obj.furnish === undefined ? [] : reader.array(obj, "furnish", "").flatMap((raw, i): FurnishEntry[] => {
      const path = `furnish[${i}]`;
      const entry = reader.object(raw, path);
      reader.onlyKeys(entry, path, ["prop", "group", "count", "per", "chance", "priority", "at"]);
      const isGroup = entry.group !== undefined;
      if (isGroup === (entry.prop !== undefined)) {
        reader.fail(path, "give either a prop or a group");
        return [];
      }
      const name = reader.string(entry, isGroup ? "group" : "prop", path);
      const prop = isGroup ? null : (props.get(name) ?? null);
      const group = isGroup ? (groups.get(name) ?? null) : null;
      if (!prop && !group) {
        const known = isGroup ? [...groups.keys()] : [...props.keys()];
        reader.fail(`${path}.${isGroup ? "group" : "prop"}`, `no ${isGroup ? "prop group" : "prop"} "${name}" (known: ${known.join(", ") || "none"})`);
        return [];
      }
      return [
        {
          prop,
          group,
          count: entry.count === undefined ? [1, 1] : typeof entry.count === "number" ? [entry.count, entry.count] : reader.range(entry, "count", path, { allowEqual: true }),
          per: entry.per === undefined ? null : reader.number(entry, "per", path, { min: 1 }),
          chance: reader.optionalNumber(entry, "chance", path, 1, { min: 0, max: 1 }),
          priority: reader.optionalNumber(entry, "priority", path, 0),
          at: entry.at === undefined ? "any" : reader.oneOf(entry, "at", path, FURNISH_SPOTS),
        },
      ];
    }),
  };
}

function readBuilding(id: string, obj: RawObject, reader: Reader, partById: Map<string, BuildingPartDef>, roomById: Map<string, RoomTypeDef>): BuildingDef {
  const generator = reader.oneOf(obj, "type", "", BUILDING_GENERATORS);
  reader.onlyKeys(obj, "", ["name", "type", generator, "spill"]);
  const block = reader.object(obj[generator], generator);
  const colorsIn = (obj: RawObject, path: string, key: string): Rgb[] => {
    const list = reader.array(obj, key, path).map((raw, i) => reader.colorValue(raw, `${path}.${key}[${i}]`));
    if (list.length === 0) reader.fail(`${path}.${key}`, "needs at least one colour");
    return list.length > 0 ? list : [[0.5, 0.5, 0.5]];
  };
  const colors = (key: string): Rgb[] => colorsIn(block, generator, key);
  let boxes: BuildingDef["boxes"] = null;
  if (generator === "boxes") {
    reader.onlyKeys(block, generator, ["width", "depth", "height", "annexes", "annexSize", "walls", "tops"]);
    boxes = {
      width: reader.range(block, "width", generator, { allowEqual: true }),
      depth: reader.range(block, "depth", generator, { allowEqual: true }),
      height: reader.range(block, "height", generator, { allowEqual: true }),
      annexes: reader.range(block, "annexes", generator, { allowEqual: true }),
      annexSize: reader.range(block, "annexSize", generator, { allowEqual: true }),
      walls: colors("walls"),
      tops: colors("tops"),
    };
  }
  let house: BuildingDef["house"] = null;
  if (generator === "house") {
    const path = "house";
    reader.onlyKeys(block, path, ["tile", "width", "depth", "plan", "storeys", "cellars", "wallHeight", "upperHeight", "cellarHeight", "plinth", "plinthOutset", "framing", "jetty", "roof", "doors", "wallExtras", "parts", "interior", "litWindows"]);
    // A list of building parts, each with a weight.
    const partNamed = (entry: RawObject, at: string, key = "part"): BuildingPartDef | undefined => {
      const partId = reader.string(entry, key, at);
      const part = partById.get(partId);
      if (!part) reader.fail(joinPath(at, key), `no building part "${partId}" (known: ${[...partById.keys()].join(", ") || "none"})`);
      return part;
    };
    const choices = (key: string, from: RawObject = block, at0 = path): PartChoice[] => {
      const list = reader.array(from, key, at0).flatMap((raw, i) => {
        const at = `${at0}.${key}[${i}]`;
        const entry = reader.object(raw, at);
        reader.onlyKeys(entry, at, ["part", "weight"]);
        const part = partNamed(entry, at);
        return part ? [{ part, weight: reader.number(entry, "weight", at, { min: 0 }) }] : [];
      });
      if (list.length === 0) reader.fail(`${at0}.${key}`, "needs at least one building part");
      return list;
    };
    /** A part that tops a storey - a roof or a terrace. */
    const isTop = (part: BuildingPartDef): boolean => part.generator === "pitched" || part.generator === "terrace";
    /** A whole number of tiles, at least 1. */
    const tilesIn = (from: RawObject, key: string, at: string): [number, number] => {
      const range = reader.range(from, key, at, { allowEqual: true });
      if (range[0] < 1 || !range.every(Number.isInteger)) reader.fail(`${at}.${key}`, "is in whole tiles, at least 1");
      return range;
    };
    /** A count's range - of storeys - or `otherwise` where it is not given. */
    const countIn = (from: RawObject, key: string, at: string, least: number, otherwise: [number, number]): [number, number] => {
      if (from[key] === undefined) return otherwise;
      const range = reader.range(from, key, at, { allowEqual: true });
      if (range[0] < least || !range.every(Number.isInteger)) reader.fail(`${at}.${key}`, `is a whole number, at least ${least}`);
      return range;
    };
    // The plan: a generator, named by `type`, its settings under its own name.
    const readPlan = (): HouseSpec["plan"] => {
      const at = "house.plan";
      const raw = reader.object(block.plan, at);
      const type = reader.oneOf(raw, "type", at, HOUSE_PLAN_GENERATORS);
      reader.onlyKeys(raw, at, ["type", type]);
      const where = `${at}.${type}`;
      const settings = reader.object(raw[type], where);
      if (type === "tower") {
        reader.onlyKeys(settings, where, ["width", "ends", "storeys", "roof"]);
        const ends = reader.stringList(settings, "ends", where).filter((end): end is "front" | "back" => {
          if (end === "front" || end === "back") return true;
          reader.fail(`${where}.ends`, `"${end}" is not an end (known: front, back)`);
          return false;
        });
        if (ends.length === 0) reader.fail(`${where}.ends`, "needs at least one end");
        const roof = partNamed(settings, where, "roof");
        if (roof && roof.generator !== "pitched") reader.fail(`${where}.roof`, `building part "${roof.id}" is not a roof`);
        return {
          type,
          tower: { width: tilesIn(settings, "width", where), ends, storeys: countIn(settings, "storeys", where, 1, [1, 1]), roof: roof as BuildingPartDef },
        };
      }
      if (type === "cabin") {
        reader.onlyKeys(settings, where, ["leanTos", "porches", "open"]);
        let open: CabinPlanSettings["open"] = null;
        if (settings.open !== undefined && settings.open !== null) {
          const oat = `${where}.open`;
          const oraw = reader.object(settings.open, oat);
          reader.onlyKeys(oraw, oat, ["closedBays", "post", "postEvery"]);
          const post = partNamed(oraw, oat, "post");
          if (post && post.generator !== "support") reader.fail(`${oat}.post`, `building part "${post.id}" is not a support`);
          const closedBays = countIn(oraw, "closedBays", oat, 1, [1, 1]);
          const postEvery = reader.optionalNumber(oraw, "postEvery", oat, 1, { min: 1, integer: true });
          if (post) open = { closedBays, post, postEvery };
        }
        const porches = reader.optionalArray(settings, "porches", where).flatMap((rawPorch, i): PorchPlanSpec[] => {
          const pat = `${where}.porches[${i}]`;
          const entry = reader.object(rawPorch, pat);
          reader.onlyKeys(entry, pat, ["walls", "chance", "length", "part"]);
          const walls = reader.stringList(entry, "walls", pat).filter((wall): wall is PorchPlanSpec["walls"][number] => {
            if ((PORCH_WALLS as readonly string[]).includes(wall)) return true;
            reader.fail(`${pat}.walls`, `"${wall}" is not a wall a porch stands along (known: ${PORCH_WALLS.join(", ")})`);
            return false;
          });
          if (walls.length === 0) reader.fail(`${pat}.walls`, "needs at least one wall");
          const part = partNamed(entry, pat, "part");
          if (part && part.generator !== "porch") reader.fail(`${pat}.part`, `building part "${part.id}" is not a porch`);
          if (!part) return [];
          return [{
            walls,
            chance: reader.optionalNumber(entry, "chance", pat, 1, { min: 0, max: 1 }),
            length: entry.length === undefined || entry.length === null ? null : tilesIn(entry, "length", pat),
            part,
          }];
        });
        const leanTos = reader.optionalArray(settings, "leanTos", where).flatMap((rawLeanTo, i): LeanToSpec[] => {
          const lat = `${where}.leanTos[${i}]`;
          const entry = reader.object(rawLeanTo, lat);
          reader.onlyKeys(entry, lat, ["walls", "chance", "depth", "length", "roof"]);
          const walls = reader.stringList(entry, "walls", lat).filter((wall): wall is LeanToSpec["walls"][number] => {
            if ((LEAN_TO_WALLS as readonly string[]).includes(wall)) return true;
            reader.fail(`${lat}.walls`, `"${wall}" is not a wall a lean-to stands against (known: ${LEAN_TO_WALLS.join(", ")})`);
            return false;
          });
          if (walls.length === 0) reader.fail(`${lat}.walls`, "needs at least one wall");
          const roof = partNamed(entry, lat, "roof");
          if (roof && roof.generator !== "leanTo") reader.fail(`${lat}.roof`, `building part "${roof.id}" is not a lean-to roof`);
          if (!roof) return [];
          return [{
            walls,
            chance: reader.optionalNumber(entry, "chance", lat, 1, { min: 0, max: 1 }),
            depth: tilesIn(entry, "depth", lat),
            length: entry.length === undefined || entry.length === null ? null : tilesIn(entry, "length", lat),
            roof,
          }];
        });
        return { type, cabin: { leanTos, porches, open } };
      }
      reader.onlyKeys(settings, where, ["backWing", "sideWing", "wingLength", "wingWidth", "wingStoreys", "lowTops", "setback", "arcade"]);
      const lowTops = settings.lowTops === undefined ? [] : choices("lowTops", settings, where);
      for (const choice of lowTops) if (!isTop(choice.part)) reader.fail(`${where}.lowTops`, `building part "${choice.part.id}" is not a roof or a terrace`);
      let setback: HousePlanSettings["setback"] = null;
      if (settings.setback !== undefined && settings.setback !== null) {
        const sat = `${where}.setback`;
        const sraw = reader.object(settings.setback, sat);
        reader.onlyKeys(sraw, sat, ["chance", "terraces"]);
        const terraces = choices("terraces", sraw, sat);
        for (const choice of terraces) if (choice.part.generator !== "terrace") reader.fail(`${sat}.terraces`, `building part "${choice.part.id}" is not a terrace`);
        setback = { chance: reader.number(sraw, "chance", sat, { min: 0, max: 1 }), terraces };
      }
      let arcade: HousePlanSettings["arcade"] = null;
      if (settings.arcade !== undefined && settings.arcade !== null) {
        const aat = `${where}.arcade`;
        const araw = reader.object(settings.arcade, aat);
        reader.onlyKeys(araw, aat, ["chance", "support"]);
        const support = partNamed(araw, aat, "support");
        if (support && support.generator !== "support") reader.fail(`${aat}.support`, `building part "${support.id}" is not a support`);
        if (support) arcade = { chance: reader.number(araw, "chance", aat, { min: 0, max: 1 }), support };
      }
      return {
        type,
        house: {
          backWing: reader.optionalNumber(settings, "backWing", where, 0, { min: 0, max: 1 }),
          sideWing: reader.optionalNumber(settings, "sideWing", where, 0, { min: 0, max: 1 }),
          wingLength: settings.wingLength === undefined ? [1, 1] : tilesIn(settings, "wingLength", where),
          wingWidth: settings.wingWidth === undefined ? [1, 1] : tilesIn(settings, "wingWidth", where),
          wingStoreys: settings.wingStoreys === undefined ? null : countIn(settings, "wingStoreys", where, 1, [1, 1]),
          lowTops,
          setback,
          arcade,
        },
      };
    };
    const wallExtras = (block.wallExtras === undefined ? [] : reader.array(block, "wallExtras", path)).flatMap((raw, i): WallExtra[] => {
      const at = `house.wallExtras[${i}]`;
      const entry = reader.object(raw, at);
      reader.onlyKeys(entry, at, ["part", "priority", "chance", "maxCount", "walls", "storeys"]);
      const part = partNamed(entry, at);
      const walls = entry.walls === undefined ? [...WALL_SIDES] : reader.stringList(entry, "walls", at).filter((wall): wall is WallSide => {
        if ((WALL_SIDES as readonly string[]).includes(wall)) return true;
        reader.fail(joinPath(at, "walls"), `"${wall}" is not a wall (known: ${WALL_SIDES.join(", ")})`);
        return false;
      });
      const storeys = entry.storeys === undefined ? (["ground", "upper"] as StoreyKind[]) : reader.stringList(entry, "storeys", at).filter((storey): storey is StoreyKind => {
        if ((STOREY_KINDS as readonly string[]).includes(storey)) return true;
        reader.fail(joinPath(at, "storeys"), `"${storey}" is not a storey (known: ${STOREY_KINDS.join(", ")})`);
        return false;
      });
      const maxCount = entry.maxCount === undefined ? null : reader.number(entry, "maxCount", at, { min: 0 });
      if (maxCount !== null && !Number.isInteger(maxCount)) reader.fail(joinPath(at, "maxCount"), "is a whole number");
      return part
        ? [{ part, priority: reader.optionalNumber(entry, "priority", at, 0), chance: reader.number(entry, "chance", at, { min: 0, max: 1 }), maxCount, walls, storeys }]
        : [];
    });
    const partsRaw = reader.object(block.parts, "house.parts");
    reader.onlyKeys(partsRaw, "house.parts", HOUSE_PARTS);
    const parts = {} as HouseSpec["parts"];
    for (const part of HOUSE_PARTS) {
      const at = `house.parts.${part}`;
      // A part a house may leave out is its timber.
      if (OPTIONAL_HOUSE_PARTS.includes(part) && partsRaw[part] === undefined) {
        parts[part] = parts.timber;
        continue;
      }
      const entry = reader.object(partsRaw[part], at);
      reader.onlyKeys(entry, at, ["material", "tints"]);
      parts[part] = { material: reader.string(entry, "material", at), tints: colorsIn(entry, at, "tints") };
    }
    // Every house has a roof - a roof part (one a whole house is handed, as roofs are).
    const roof = partNamed(block, path, "roof");
    if (roof && roof.generator !== "pitched") reader.fail("house.roof", `building part "${roof.id}" is not a roof`);
    // A jetty: how far each storey over the ground one stands out, and on which walls.
    const readJetty = (): HouseSpec["jetty"] => {
      if (block.jetty === undefined || block.jetty === null) return null;
      const at = "house.jetty";
      const jetty = reader.object(block.jetty, at);
      reader.onlyKeys(jetty, at, ["out", "walls"]);
      const walls = reader.stringList(jetty, "walls", at).filter((wall): wall is WallSide => {
        if ((WALL_SIDES as readonly string[]).includes(wall)) return true;
        reader.fail(joinPath(at, "walls"), `"${wall}" is not a wall (known: ${WALL_SIDES.join(", ")})`);
        return false;
      });
      return { out: reader.number(jetty, "out", at, { min: 0 }), walls };
    };
    const tiles = (key: string): [number, number] => {
      const range = reader.range(block, key, path, { allowEqual: true });
      if (range[0] < 1) reader.fail(`house.${key}`, "is in whole tiles, at least 1");
      return range;
    };
    /** A count's range - of storeys, of cellars - or `otherwise` where it is not given. */
    const count = (key: string, least: number, otherwise: [number, number]): [number, number] => {
      if (block[key] === undefined) return otherwise;
      const range = reader.range(block, key, path, { allowEqual: true });
      if (range[0] < least || !range.every(Number.isInteger)) reader.fail(`house.${key}`, `is a whole number, at least ${least}`);
      return range;
    };
    // The interior: a generator, named by `type`, its settings under its own name - or none.
    const readInterior = (): HouseSpec["interior"] => {
      if (block.interior === undefined || block.interior === null) return null;
      const at = "house.interior";
      const raw = reader.object(block.interior, at);
      const type = reader.oneOf(raw, "type", at, INTERIOR_GENERATORS);
      reader.onlyKeys(raw, at, ["type", type]);
      const where = `${at}.${type}`;
      const settings = reader.object(raw[type], where);
      reader.onlyKeys(settings, where, ["exits", "fakeDoors", "grow", "rooms"]);
      const requests = reader.array(settings, "rooms", where).flatMap((value, i): RoomRequest[] => {
        const rat = `${where}.rooms[${i}]`;
        const entry = reader.object(value, rat);
        reader.onlyKeys(entry, rat, ["room", "priority", "chance", "count", "levels", "level", "tiles", "minSide", "maxSide", "grow", "at", "near", "next", "under", "over", "stair", "windows", "oneBlock", "through"]);
        const roomId = reader.string(entry, "room", rat);
        const room = roomById.get(roomId);
        if (!room) {
          reader.fail(`${rat}.room`, `no room type "${roomId}" (known: ${[...roomById.keys()].join(", ") || "none"})`);
          return [];
        }
        const name = (key: string): string | null => {
          if (entry[key] === undefined || entry[key] === null) return null;
          const other = reader.string(entry, key, rat);
          if (!roomById.has(other)) reader.fail(`${rat}.${key}`, `no room type "${other}"`);
          return other;
        };
        const entrance = (key: string): "entrance" | null => {
          if (entry[key] === undefined || entry[key] === null) return null;
          if (entry[key] !== "entrance") reader.fail(`${rat}.${key}`, `expected "entrance"`);
          return "entrance";
        };
        return [
          {
            room,
            priority: reader.optionalNumber(entry, "priority", rat, 0),
            chance: reader.optionalNumber(entry, "chance", rat, 1, { min: 0, max: 1 }),
            count: countIn(entry, "count", rat, 1, [1, 1]),
            levels: countIn(entry, "levels", rat, 1, [1, 1]),
            level: entry.level === undefined ? "ground" : reader.oneOf(entry, "level", rat, ROOM_LEVELS),
            tiles: tilesIn(entry, "tiles", rat),
            minSide: reader.optionalNumber(entry, "minSide", rat, 1, { min: 1, integer: true }),
            maxSide: entry.maxSide === undefined ? null : reader.number(entry, "maxSide", rat, { min: 1, integer: true }),
            grow: entry.grow === undefined ? null : reader.number(entry, "grow", rat, { min: 1 }),
            at: entrance("at"),
            near: entrance("near"),
            next: name("next"),
            under: name("under"),
            over: name("over"),
            stair: entry.stair === true,
            windows: entry.windows === true,
            oneBlock: entry.oneBlock === true,
            through: entry.through === true,
          },
        ];
      });
      if (requests.length === 0) reader.fail(`${where}.rooms`, "needs at least one room");
      return {
        type,
        rooms: {
          exits: countIn(settings, "exits", where, 1, [1, 1]),
          fakeDoors: reader.optionalNumber(settings, "fakeDoors", where, 0, { min: 0, max: 1 }),
          grow: reader.optionalNumber(settings, "grow", where, 1.5, { min: 1 }),
          rooms: requests,
        },
      };
    };
    house = {
      tile: reader.range(block, "tile", path, { allowEqual: true }),
      width: tiles("width"),
      depth: tiles("depth"),
      plan: readPlan(),
      storeys: count("storeys", 1, [1, 1]),
      cellars: count("cellars", 0, [0, 0]),
      wallHeight: reader.range(block, "wallHeight", path, { allowEqual: true }),
      upperHeight: block.upperHeight === undefined ? null : reader.range(block, "upperHeight", path, { allowEqual: true }),
      cellarHeight: block.cellarHeight === undefined ? [2.6, 3] : reader.range(block, "cellarHeight", path, { allowEqual: true }),
      plinth: reader.range(block, "plinth", path, { allowEqual: true }),
      plinthOutset: reader.number(block, "plinthOutset", path, { min: 0 }),
      framing: block.framing === undefined ? null : (partNamed(block, path, "framing") ?? null),
      jetty: readJetty(),
      // A house without a roof part has already failed above; its content is never used.
      roof: roof as BuildingPartDef,
      doors: choices("doors"),
      wallExtras,
      parts,
      interior: readInterior(),
      litWindows: reader.optionalNumber(block, "litWindows", path, 0, { min: 0, max: 1 }),
    };
  }
  return { id, name: reader.string(obj, "name", ""), generator, boxes, house, spill: readSpill(obj, reader) };
}

/** A buildingParts/ file - see BuildingPartDef. Named by `type` like a building, its settings under
 *  the generator's name. */
function readBuildingPart(id: string, obj: RawObject, reader: Reader): BuildingPartDef {
  const generator = reader.oneOf(obj, "type", "", BUILDING_PART_GENERATORS);
  reader.onlyKeys(obj, "", ["name", "type", generator, "light"]);
  const path = generator;
  const block = reader.object(obj[generator], path);
  const role = (key: string, at: string, from: RawObject): HousePart => reader.oneOf(from, key, at, HOUSE_PARTS);
  let framed: BuildingPartDef["framed"] = null;
  if (generator === "framed") {
    reader.onlyKeys(block, path, ["span", "width", "height", "sill", "frame", "headReach", "bars", "sillReach", "steps", "parts"]);
    let steps: NonNullable<BuildingPartDef["framed"]>["steps"] = null;
    if (block.steps !== undefined) {
      const at = `${path}.steps`;
      const raw = reader.object(block.steps, at);
      reader.onlyKeys(raw, at, ["count", "tread", "reach", "part"]);
      steps = {
        count: reader.number(raw, "count", at, { min: 1, integer: true }),
        tread: reader.optionalNumber(raw, "tread", at, 0.38, { min: 0.1 }),
        reach: reader.optionalNumber(raw, "reach", at, 0.2, { min: 0 }),
        part: raw.part === undefined ? "stone" : role("part", at, raw),
      };
    }
    const span = reader.number(block, "span", path, { min: 1 });
    if (!Number.isInteger(span)) reader.fail(`${path}.span`, "is in whole bays");
    const bars = block.bars === undefined ? [0, 0] : block.bars;
    let barCounts: [number, number] = [0, 0];
    if (Array.isArray(bars) && bars.length === 2 && bars.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) barCounts = [bars[0], bars[1]];
    else reader.fail(`${path}.bars`, "expected [up, across]: how many bars each way, whole numbers");
    const parts = reader.object(block.parts, `${path}.parts`);
    reader.onlyKeys(parts, `${path}.parts`, ["frame", "panel"]);
    framed = {
      span: Math.max(1, Math.round(span)),
      width: reader.number(block, "width", path, { min: 0.3 }),
      height: reader.number(block, "height", path, { min: 0.4 }),
      sill: reader.number(block, "sill", path, { min: 0 }),
      frame: reader.number(block, "frame", path, { min: 0.02 }),
      headReach: reader.optionalNumber(block, "headReach", path, 0, { min: 0 }),
      bars: barCounts,
      sillReach: block.sillReach === undefined ? null : reader.number(block, "sillReach", path, { min: 0 }),
      steps,
      parts: { frame: role("frame", `${path}.parts`, parts), panel: role("panel", `${path}.parts`, parts) },
    };
  }
  let timberFrame: BuildingPartDef["timberFrame"] = null;
  if (generator === "timberFrame") {
    reader.onlyKeys(block, path, ["corner", "post", "sill", "plate", "parts"]);
    const sizes = (key: string, keys: [string, string]): RawObject => {
      const at = `${path}.${key}`;
      const o = reader.object(block[key], at);
      reader.onlyKeys(o, at, keys);
      return o;
    };
    const post = sizes("post", ["width", "out"]);
    const sill = sizes("sill", ["height", "out"]);
    const plate = sizes("plate", ["height", "out"]);
    const parts = reader.object(block.parts, `${path}.parts`);
    reader.onlyKeys(parts, `${path}.parts`, ["timber"]);
    const size = (o: RawObject, key: string, at: string): number => reader.number(o, key, `${path}.${at}`, { min: 0.02 });
    timberFrame = {
      corner: reader.range(block, "corner", path, { allowEqual: true }),
      post: { width: size(post, "width", "post"), out: size(post, "out", "post") },
      sill: { height: size(sill, "height", "sill"), out: size(sill, "out", "sill") },
      plate: { height: size(plate, "height", "plate"), out: size(plate, "out", "plate") },
      parts: { timber: role("timber", `${path}.parts`, parts) },
    };
  }
  let pitched: BuildingPartDef["pitched"] = null;
  if (generator === "pitched") {
    reader.onlyKeys(block, path, ["shapes", "pitch", "overhang", "thickness", "covering", "bargeboard", "sag", "step", "ridgeTiles", "parts"]);
    const shapes = reader.stringList(block, "shapes", path).filter((shape): shape is RoofType => {
      if ((ROOF_TYPES as readonly string[]).includes(shape)) return true;
      reader.fail(`${path}.shapes`, `"${shape}" is not a roof shape (known: ${ROOF_TYPES.join(", ")})`);
      return false;
    });
    if (shapes.length === 0) reader.fail(`${path}.shapes`, "needs at least one shape");
    const covering = reader.object(block.covering, `${path}.covering`);
    reader.onlyKeys(covering, `${path}.covering`, ["thickness", "overhang"]);
    const bargeboard = block.bargeboard === undefined || block.bargeboard === null ? null : reader.object(block.bargeboard, `${path}.bargeboard`);
    if (bargeboard) reader.onlyKeys(bargeboard, `${path}.bargeboard`, ["height", "thickness"]);
    const sag = reader.object(block.sag, `${path}.sag`);
    reader.onlyKeys(sag, `${path}.sag`, ["ridge", "slope"]);
    let ridgeTiles: PitchedRoofSpec["ridgeTiles"] = null;
    if (block.ridgeTiles !== undefined && block.ridgeTiles !== null) {
      const at = `${path}.ridgeTiles`;
      const tiles = reader.object(block.ridgeTiles, at);
      reader.onlyKeys(tiles, at, ["width", "height", "profile"]);
      ridgeTiles = {
        width: reader.number(tiles, "width", at, { min: 0.05 }),
        height: reader.number(tiles, "height", at, { min: 0.02 }),
        profile: tiles.profile === undefined ? "round" : reader.oneOf(tiles, "profile", at, RIDGE_PROFILES),
      };
    }
    const parts = reader.object(block.parts, `${path}.parts`);
    reader.onlyKeys(parts, `${path}.parts`, ["covering", "underside", "ridge", "gable"]);
    pitched = {
      shapes: shapes.length > 0 ? shapes : ["gable"],
      pitch: reader.range(block, "pitch", path, { allowEqual: true }),
      overhang: reader.number(block, "overhang", path, { min: 0 }),
      thickness: reader.number(block, "thickness", path, { min: 0.01 }),
      sag: { ridge: reader.range(sag, "ridge", `${path}.sag`, { allowEqual: true }), slope: reader.range(sag, "slope", `${path}.sag`, { allowEqual: true }) },
      covering: { thickness: reader.number(covering, "thickness", `${path}.covering`, { min: 0.01 }), overhang: reader.number(covering, "overhang", `${path}.covering`, { min: 0 }) },
      bargeboard: bargeboard
        ? { height: reader.number(bargeboard, "height", `${path}.bargeboard`, { min: 0 }), thickness: reader.number(bargeboard, "thickness", `${path}.bargeboard`, { min: 0.01 }) }
        : null,
      step: reader.number(block, "step", path, { min: 0.25 }),
      ridgeTiles,
      parts: {
        covering: role("covering", `${path}.parts`, parts),
        underside: role("underside", `${path}.parts`, parts),
        ridge: role("ridge", `${path}.parts`, parts),
        gable: role("gable", `${path}.parts`, parts),
      },
    };
  }
  let terrace: BuildingPartDef["terrace"] = null;
  if (generator === "terrace") {
    reader.onlyKeys(block, path, ["edge", "parapet", "parts"]);
    const edge = reader.object(block.edge, `${path}.edge`);
    reader.onlyKeys(edge, `${path}.edge`, ["height", "out"]);
    const parapet = reader.object(block.parapet, `${path}.parapet`);
    reader.onlyKeys(parapet, `${path}.parapet`, ["height", "thickness", "style", "post"]);
    const parts = reader.object(block.parts, `${path}.parts`);
    reader.onlyKeys(parts, `${path}.parts`, ["floor", "edge", "parapet"]);
    terrace = {
      edge: { height: reader.number(edge, "height", `${path}.edge`, { min: 0.02 }), out: reader.number(edge, "out", `${path}.edge`, { min: 0 }) },
      parapet: {
        height: reader.number(parapet, "height", `${path}.parapet`, { min: 0.1 }),
        thickness: reader.number(parapet, "thickness", `${path}.parapet`, { min: 0.02 }),
        style: reader.oneOf(parapet, "style", `${path}.parapet`, PARAPET_STYLES),
        post: reader.optionalNumber(parapet, "post", `${path}.parapet`, 1.2, { min: 0.2 }),
      },
      parts: { floor: role("floor", `${path}.parts`, parts), edge: role("edge", `${path}.parts`, parts), parapet: role("parapet", `${path}.parts`, parts) },
    };
  }
  let support: BuildingPartDef["support"] = null;
  if (generator === "support") {
    reader.onlyKeys(block, path, ["width", "base", "capital", "parts"]);
    const end = (key: string): { height: number; reach: number } | null => {
      if (block[key] === undefined || block[key] === null) return null;
      const at = `${path}.${key}`;
      const o = reader.object(block[key], at);
      reader.onlyKeys(o, at, ["height", "reach"]);
      return { height: reader.number(o, "height", at, { min: 0.02 }), reach: reader.number(o, "reach", at, { min: 0 }) };
    };
    const parts = reader.object(block.parts, `${path}.parts`);
    reader.onlyKeys(parts, `${path}.parts`, ["shaft", "ends"]);
    support = {
      width: reader.number(block, "width", path, { min: 0.1 }),
      base: end("base"),
      capital: end("capital"),
      parts: { shaft: role("shaft", `${path}.parts`, parts), ends: role("ends", `${path}.parts`, parts) },
    };
  }
  let stoneFrame: BuildingPartDef["stoneFrame"] = null;
  if (generator === "stoneFrame") {
    reader.onlyKeys(block, path, ["quoins", "pilaster", "cornice", "band", "parts"]);
    const sub = (key: string, keys: string[]): RawObject => {
      const o = reader.object(block[key], `${path}.${key}`);
      reader.onlyKeys(o, `${path}.${key}`, keys);
      return o;
    };
    const size = (o: RawObject, key: string, at: string): number => reader.number(o, key, `${path}.${at}`, { min: 0.02 });
    const quoins = sub("quoins", ["course", "long", "short", "out"]);
    const pilaster = sub("pilaster", ["width", "out"]);
    const cornice = sub("cornice", ["height", "out"]);
    const band = block.band === undefined || block.band === null ? null : sub("band", ["height", "out"]);
    const parts = sub("parts", ["stone"]);
    stoneFrame = {
      quoins: { course: size(quoins, "course", "quoins"), long: size(quoins, "long", "quoins"), short: size(quoins, "short", "quoins"), out: size(quoins, "out", "quoins") },
      pilaster: { width: size(pilaster, "width", "pilaster"), out: size(pilaster, "out", "pilaster") },
      cornice: { height: size(cornice, "height", "cornice"), out: size(cornice, "out", "cornice") },
      band: band ? { height: size(band, "height", "band"), out: size(band, "out", "band") } : null,
      parts: { stone: role("stone", `${path}.parts`, parts) },
    };
  }
  let porch: BuildingPartDef["porch"] = null;
  if (generator === "porch") {
    reader.onlyKeys(block, path, ["depth", "pitch", "drop", "headroom", "overhang", "thickness", "post", "beam", "step", "parts"]);
    const parts = reader.object(block.parts, `${path}.parts`);
    reader.onlyKeys(parts, `${path}.parts`, ["deck", "post", "covering", "underside"]);
    porch = {
      depth: reader.range(block, "depth", path, { allowEqual: true }),
      pitch: reader.range(block, "pitch", path, { allowEqual: true }),
      drop: reader.number(block, "drop", path, { min: 0 }),
      headroom: reader.number(block, "headroom", path, { min: 1 }),
      overhang: reader.number(block, "overhang", path, { min: 0 }),
      thickness: reader.number(block, "thickness", path, { min: 0.02 }),
      post: reader.number(block, "post", path, { min: 0.05 }),
      beam: reader.number(block, "beam", path, { min: 0.05 }),
      step: reader.number(block, "step", path, { min: 0.1 }),
      parts: {
        deck: role("deck", `${path}.parts`, parts),
        post: role("post", `${path}.parts`, parts),
        covering: role("covering", `${path}.parts`, parts),
        underside: role("underside", `${path}.parts`, parts),
      },
    };
  }
  let leanTo: BuildingPartDef["leanTo"] = null;
  if (generator === "leanTo") {
    reader.onlyKeys(block, path, ["pitch", "overhang", "thickness", "parts"]);
    const parts = reader.object(block.parts, `${path}.parts`);
    reader.onlyKeys(parts, `${path}.parts`, ["covering", "underside", "gable"]);
    leanTo = {
      pitch: reader.range(block, "pitch", path, { allowEqual: true }),
      overhang: reader.number(block, "overhang", path, { min: 0 }),
      thickness: reader.number(block, "thickness", path, { min: 0.02 }),
      parts: { covering: role("covering", `${path}.parts`, parts), underside: role("underside", `${path}.parts`, parts), gable: role("gable", `${path}.parts`, parts) },
    };
  }
  let logs: BuildingPartDef["logs"] = null;
  if (generator === "logs") {
    reader.onlyKeys(block, path, ["course", "reach", "depth", "endOffset", "parts"]);
    const parts = reader.object(block.parts, `${path}.parts`);
    reader.onlyKeys(parts, `${path}.parts`, ["face", "grain", "end"]);
    logs = {
      course: reader.number(block, "course", path, { min: 0.1 }),
      reach: reader.range(block, "reach", path, { allowEqual: true }),
      depth: reader.number(block, "depth", path, { min: 0.05 }),
      endOffset: reader.number(block, "endOffset", path, { min: 0 }),
      parts: { face: role("face", `${path}.parts`, parts), grain: role("grain", `${path}.parts`, parts), end: role("end", `${path}.parts`, parts) },
    };
  }
  let chimney: BuildingPartDef["chimney"] = null;
  if (generator === "chimney") {
    reader.onlyKeys(block, path, ["span", "width", "depth", "shoulder", "stackWidth", "stackDepth", "angle", "rise", "foundation", "cap", "pots", "parts"]);
    const span = reader.number(block, "span", path, { min: 1 });
    if (!Number.isInteger(span)) reader.fail(`${path}.span`, "is in whole bays");
    const sub = (key: string, keys: string[]): RawObject => {
      const at = `${path}.${key}`;
      const o = reader.object(block[key], at);
      reader.onlyKeys(o, at, keys);
      return o;
    };
    const foundation = sub("foundation", ["reach", "height"]);
    const cap = sub("cap", ["height", "reach"]);
    const pots = sub("pots", ["count", "width", "height"]);
    const parts = sub("parts", ["body", "cap", "pots"]);
    const potCount = reader.number(pots, "count", `${path}.pots`, { min: 0 });
    if (!Number.isInteger(potCount)) reader.fail(`${path}.pots.count`, "is a whole number");
    chimney = {
      span: Math.max(1, Math.round(span)),
      width: reader.number(block, "width", path, { min: 0.4 }),
      depth: reader.number(block, "depth", path, { min: 0.2 }),
      shoulder: reader.number(block, "shoulder", path, { min: 0 }),
      stackWidth: reader.number(block, "stackWidth", path, { min: 0.3 }),
      stackDepth: reader.number(block, "stackDepth", path, { min: 0.2 }),
      angle: reader.number(block, "angle", path, { min: 0, max: 80 }),
      rise: reader.range(block, "rise", path, { allowEqual: true }),
      foundation: { reach: reader.number(foundation, "reach", `${path}.foundation`, { min: 0 }), height: reader.number(foundation, "height", `${path}.foundation`, { min: 0 }) },
      cap: { height: reader.number(cap, "height", `${path}.cap`, { min: 0.02 }), reach: reader.number(cap, "reach", `${path}.cap`, { min: 0 }) },
      pots: {
        count: Math.max(0, Math.round(potCount)),
        width: reader.number(pots, "width", `${path}.pots`, { min: 0.05 }),
        height: reader.number(pots, "height", `${path}.pots`, { min: 0.05 }),
      },
      parts: { body: role("body", `${path}.parts`, parts), cap: role("cap", `${path}.parts`, parts), pots: role("pots", `${path}.parts`, parts) },
    };
  }
  return { id, name: reader.string(obj, "name", ""), generator, framed, chimney, timberFrame, stoneFrame, logs, pitched, leanTo, porch, terrace, support, light: readWindowLight(obj, reader) };
}

/** A features/ file - see FeatureKindDef. */
function readFeatureKind(id: string, obj: RawObject, reader: Reader, buildings: Map<string, BuildingDef>, props: Map<string, PropDef>, groups: Map<string, PropGroupDef>): FeatureKindDef {
  reader.onlyKeys(obj, "", ["name", "type", "quarry", "compound", "clearing", "stumps", "road", "ground", "names"]);
  const type = reader.oneOf(obj, "type", "", FEATURE_TYPES);
  // A settlement is laid out by its own code, in its biome's settlement style: it takes nothing else.
  if (type === "settlement") {
    reader.onlyKeys(obj, "", ["name", "type", "road"]);
    return { id, name: reader.string(obj, "name", ""), type, quarry: null, compound: null, clearing: [0, 0], stumps: 0, road: readPlaceRoad(obj, reader, true), ground: null, names: null };
  }
  // Each type takes its own block and not another's.
  reader.onlyKeys(obj, "", ["name", "type", type, "clearing", "stumps", "road", "ground", "names"]);
  const ground = obj.ground === undefined ? null : reader.object(obj.ground, "ground");
  if (ground) reader.onlyKeys(ground, "ground", ["material", "weight"]);
  return {
    id,
    name: reader.string(obj, "name", ""),
    type,
    quarry: type === "quarry" ? readQuarry(reader.object(obj.quarry, "quarry"), reader) : null,
    compound: type === "compound" ? readCompound(reader.object(obj.compound, "compound"), reader, buildings, props, groups) : null,
    clearing: reader.range(obj, "clearing", "", { allowEqual: true }),
    stumps: reader.optionalNumber(obj, "stumps", "", 0, { min: 0, max: 1 }),
    road: readPlaceRoad(obj, reader, false),
    ground: ground ? readLayer(ground, reader, "ground", `feature-${id}`) : null,
    names: readNaming(obj, reader),
  };
}

/** A feature's `names` - see FeatureNaming. Every `{word}` in its patterns is one of its `words` or
 *  one its voice gives (VOICE_NAME_TOKENS). */
function readNaming(obj: RawObject, reader: Reader): FeatureNaming | null {
  if (obj.names === undefined) return null;
  const names = reader.object(obj.names, "names");
  reader.onlyKeys(names, "names", ["patterns", "words"]);
  const patterns = reader.array(names, "patterns", "names").map((raw, i) => {
    const path = `names.patterns[${i}]`;
    const entry = reader.object(raw, path);
    reader.onlyKeys(entry, path, ["text", "odds"]);
    return { text: reader.string(entry, "text", path), odds: reader.optionalNumber(entry, "odds", path, 1, { min: 0 }) };
  });
  const wordsRaw = names.words === undefined ? {} : reader.object(names.words, "names.words");
  const words: Record<string, Record<string, string[]>> = {};
  for (const [key, value] of Object.entries(wordsRaw)) {
    if (Array.isArray(value)) {
      words[key] = { any: reader.stringList(wordsRaw, key, "names.words") };
      continue;
    }
    const path = `names.words.${key}`;
    const byVoice = reader.object(value, path);
    words[key] = Object.fromEntries(Object.keys(byVoice).map((voice) => [voice, reader.stringList(byVoice, voice, path)]));
  }
  patterns.forEach((pattern, i) => {
    for (const [, token] of pattern.text.matchAll(/\{(\w+)\}/g)) {
      if (!(token in words) && !(VOICE_NAME_TOKENS as readonly string[]).includes(token)) reader.fail(`names.patterns[${i}].text`, `no word list "${token}" (known: ${[...Object.keys(words), ...VOICE_NAME_TOKENS].join(", ")})`);
    }
  });
  return { patterns, words };
}

function readQuarry(quarry: RawObject, reader: Reader): QuarrySpec {
  reader.onlyKeys(quarry, "quarry", ["floorLength", "floorWidth", "benchHeight", "benchSteepness", "benchWidth", "spoilSlope", "grade", "idealGrade"]);
  return {
    floorLength: reader.range(quarry, "floorLength", "quarry", { allowEqual: true }),
    floorWidth: reader.range(quarry, "floorWidth", "quarry", { allowEqual: true }),
    benchHeight: reader.range(quarry, "benchHeight", "quarry", { allowEqual: true }),
    benchSteepness: reader.number(quarry, "benchSteepness", "quarry", { min: 0.5 }),
    benchWidth: reader.range(quarry, "benchWidth", "quarry", { allowEqual: true }),
    spoilSlope: reader.number(quarry, "spoilSlope", "quarry", { min: 0.2 }),
    grade: reader.range(quarry, "grade", "quarry"),
    idealGrade: reader.number(quarry, "idealGrade", "quarry", { min: 0.01 }),
  };
}

/** A compound's block - see CompoundSpec. */
function readCompound(compound: RawObject, reader: Reader, buildings: Map<string, BuildingDef>, props: Map<string, PropDef>, groups: Map<string, PropGroupDef>): CompoundSpec {
  reader.onlyKeys(compound, "compound", ["site", "yard", "pads", "arrangement", "trails", "buildings", "props", "boundary", "graves"]);
  // How its level ground blends back - the settlements' own unless it says.
  const padsRaw = compound.pads === undefined ? {} : reader.object(compound.pads, "compound.pads");
  reader.onlyKeys(padsRaw, "compound.pads", ["slope", "blend", "spill"]);
  const pads = {
    slope: reader.optionalNumber(padsRaw, "slope", "compound.pads", PAD_SIDE_SLOPE, { min: 0.05 }),
    blend: padsRaw.blend === undefined ? ([PAD_BLEND_MIN, PAD_BLEND_MAX] as [number, number]) : reader.range(padsRaw, "blend", "compound.pads", { allowEqual: true }),
    spill: readSpill(padsRaw, reader),
  };
  if (pads.blend[0] < 0) reader.fail("compound.pads.blend", "is at least 0");
  const site = reader.object(compound.site, "compound.site");
  reader.onlyKeys(site, "compound.site", ["grade", "cover", "nearWater", "fromSettlements"]);
  const yard = reader.object(compound.yard, "compound.yard");
  reader.onlyKeys(yard, "compound.yard", ["radius", "width"]);
  const cover = reader.range(site, "cover", "compound.site", { allowEqual: true });
  if (cover[0] < 0 || cover[1] > 1) reader.fail("compound.site.cover", `expected a range within 0-1, got [${cover[0]}, ${cover[1]}]`);
  const trails = reader.optionalArray(compound, "trails", "compound").map((raw, i): CompoundTrailSpec => {
    const path = `compound.trails[${i}]`;
    const trail = reader.object(raw, path);
    reader.onlyKeys(trail, path, ["to", "length", "chance"]);
    return {
      to: reader.oneOf(trail, "to", path, TRAIL_DESTINATIONS),
      length: reader.range(trail, "length", path, { allowEqual: true }),
      chance: reader.optionalNumber(trail, "chance", path, 1, { min: 0, max: 1 }),
    };
  });
  const buildingList = reader.array(compound, "buildings", "compound").flatMap((raw, i): CompoundBuildingSpec[] => {
    const path = `compound.buildings[${i}]`;
    const entry = reader.object(raw, path);
    reader.onlyKeys(entry, path, ["building", "count", "chance", "required", "doorTo", "place"]);
    const buildingId = reader.string(entry, "building", path);
    const building = buildings.get(buildingId);
    if (!building) {
      reader.fail(joinPath(path, "building"), `no building "${buildingId}" (known: ${[...buildings.keys()].join(", ") || "none"})`);
      return [];
    }
    const count = reader.range(entry, "count", path, { allowEqual: true });
    if (count[0] < 0 || !Number.isInteger(count[0]) || !Number.isInteger(count[1])) reader.fail(joinPath(path, "count"), `expected whole numbers, got [${count[0]}, ${count[1]}]`);
    return [{
      building,
      count,
      chance: reader.optionalNumber(entry, "chance", path, 1, { min: 0, max: 1 }),
      required: reader.boolean(entry, "required", path, false),
      doorTo: entry.doorTo === undefined ? "yard" : reader.oneOf(entry, "doorTo", path, COMPOUND_DOORS),
      place: entry.place === undefined ? "side" : reader.oneOf(entry, "place", path, COMPOUND_PLACES),
    }];
  });
  return {
    site: {
      grade: reader.range(site, "grade", "compound.site", { allowEqual: true }),
      cover,
      nearWater: site.nearWater === undefined ? null : reader.number(site, "nearWater", "compound.site", { min: 0 }),
      fromSettlements: site.fromSettlements === undefined ? null : reader.number(site, "fromSettlements", "compound.site", { min: 0 }),
    },
    yard: { radius: reader.range(yard, "radius", "compound.yard", { allowEqual: true }), width: yard.width === undefined ? null : reader.range(yard, "width", "compound.yard", { allowEqual: true }) },
    pads,
    arrangement: reader.oneOf(compound, "arrangement", "compound", COMPOUND_ARRANGEMENTS),
    trails,
    buildings: buildingList,
    props: reader.optionalArray(compound, "props", "compound").flatMap((raw, i): CompoundPropSpec[] => {
      const path = `compound.props[${i}]`;
      const entry = reader.object(raw, path);
      reader.onlyKeys(entry, path, ["prop", "group", "count", "chance", "at", "building", "distance"]);
      let placed: CompoundPropSpec["placed"] | null = null;
      if ((entry.prop === undefined) === (entry.group === undefined)) reader.fail(path, "names a `prop` or a `group`, one of them");
      else if (entry.prop !== undefined) {
        const prop = props.get(reader.string(entry, "prop", path));
        if (prop) placed = { kind: "prop", prop };
        else reader.fail(`${path}.prop`, `no prop "${String(entry.prop)}" (known: ${[...props.keys()].join(", ") || "none"})`);
      } else {
        const group = groups.get(reader.string(entry, "group", path));
        if (group) placed = { kind: "group", group };
        else reader.fail(`${path}.group`, `no prop group "${String(entry.group)}" (known: ${[...groups.keys()].join(", ") || "none"})`);
      }
      const count = reader.range(entry, "count", path, { allowEqual: true });
      if (count[0] < 0 || !Number.isInteger(count[0]) || !Number.isInteger(count[1])) reader.fail(`${path}.count`, `expected whole numbers, got [${count[0]}, ${count[1]}]`);
      let building: BuildingDef | null = null;
      if (entry.building !== undefined) {
        building = buildings.get(reader.string(entry, "building", path)) ?? null;
        if (!building) reader.fail(`${path}.building`, `no building "${String(entry.building)}"`);
      }
      if (!placed) return [];
      const at = reader.oneOf(entry, "at", path, PROP_ANCHORS);
      const distance: [number, number] = entry.distance === undefined ? [0, 0] : reader.range(entry, "distance", path, { allowEqual: true });
      if (at === "road" && entry.distance === undefined) reader.fail(joinPath(path, "distance"), "a prop by the road needs a distance out along it");
      return [{ placed, count, chance: reader.optionalNumber(entry, "chance", path, 1, { min: 0, max: 1 }), at, building, distance }];
    }),
    boundary: compound.boundary === undefined ? null : readBoundary(compound.boundary, reader, props),
    graves: compound.graves === undefined ? null : readGraves(compound.graves, reader, props, groups),
  };
}

/** A `rows` compound's `graves` - see GravesSpec. */
function readGraves(raw: unknown, reader: Reader, props: Map<string, PropDef>, groups: Map<string, PropGroupDef>): GravesSpec {
  const path = "compound.graves";
  const obj = reader.object(raw, path);
  reader.onlyKeys(obj, path, ["spacing", "fill", "markers"]);
  // [along, across] - a pair, not a range.
  const raw2 = obj.spacing;
  let spacing: [number, number] = [2.8, 1.7];
  if (Array.isArray(raw2) && raw2.length === 2 && raw2.every((v) => typeof v === "number" && v > 0)) spacing = [raw2[0], raw2[1]];
  else reader.fail(`${path}.spacing`, "expected [along, across] metres, both more than 0");
  const markers = reader.array(obj, "markers", path).flatMap((rawMarker, i): GravesSpec["markers"] => {
    const at = `${path}.markers[${i}]`;
    const entry = reader.object(rawMarker, at);
    reader.onlyKeys(entry, at, ["prop", "group", "from", "to", "weight"]);
    let placed: CompoundPropSpec["placed"] | null = null;
    if ((entry.prop === undefined) === (entry.group === undefined)) reader.fail(at, "names a `prop` or a `group`, one of them");
    else if (entry.prop !== undefined) {
      const prop = props.get(reader.string(entry, "prop", at));
      if (prop) placed = { kind: "prop", prop };
      else reader.fail(`${at}.prop`, `no prop "${String(entry.prop)}" (known: ${[...props.keys()].join(", ") || "none"})`);
    } else {
      const group = groups.get(reader.string(entry, "group", at));
      if (group) placed = { kind: "group", group };
      else reader.fail(`${at}.group`, `no prop group "${String(entry.group)}" (known: ${[...groups.keys()].join(", ") || "none"})`);
    }
    const from = reader.optionalNumber(entry, "from", at, 0, { min: 0, max: 1 });
    const to = reader.optionalNumber(entry, "to", at, 1, { min: 0, max: 1 });
    if (to < from) reader.fail(`${at}.to`, "is down the yard from `from` (0 its head, 1 its foot)");
    return placed ? [{ placed, from, to, weight: reader.optionalNumber(entry, "weight", at, 1, { min: 0 }) }] : [];
  });
  return { spacing, fill: reader.optionalNumber(obj, "fill", path, 0.8, { min: 0, max: 1 }), markers };
}

/** A compound's `boundary`: its wall (a line prop) and its openings - see CompoundBoundarySpec. */
function readBoundary(raw: unknown, reader: Reader, props: Map<string, PropDef>): CompoundBoundarySpec | null {
  const path = "compound.boundary";
  const obj = reader.object(raw, path);
  reader.onlyKeys(obj, path, ["wall", "openings"]);
  const wallId = reader.string(obj, "wall", path);
  const wall = props.get(wallId);
  if (!wall) reader.fail(`${path}.wall`, `no prop "${wallId}" (known: ${[...props.keys()].join(", ") || "none"})`);
  else if (!isLineProp(wall)) reader.fail(`${path}.wall`, `"${wallId}" is not laid along a line (its generator "${wall.generator}" has no line - a wall or a fence has)`);
  const openings = reader.optionalArray(obj, "openings", path).flatMap((rawOpening, i): BoundaryOpeningSpec[] => {
    const at = `${path}.openings[${i}]`;
    const entry = reader.object(rawOpening, at);
    reader.onlyKeys(entry, at, ["at", "gate", "gap", "breach", "count", "chance"]);
    const where = reader.oneOf(entry, "at", at, BOUNDARY_OPENINGS);
    const given = (["gate", "gap", "breach"] as const).filter((key) => entry[key] !== undefined);
    if (given.length !== 1) {
      reader.fail(at, "names one of `gate` (a prop), `gap` or `breach` (a width range, metres)");
      return [];
    }
    const kind = given[0];
    let gate: PropDef | null = null;
    let width: [number, number] = [0, 0];
    if (kind === "gate") {
      const id = reader.string(entry, "gate", at);
      gate = props.get(id) ?? null;
      if (!gate) {
        reader.fail(`${at}.gate`, `no prop "${id}" (known: ${[...props.keys()].join(", ") || "none"})`);
        return [];
      }
    } else {
      width = reader.range(entry, kind, at, { allowEqual: true });
      if (width[0] <= 0) reader.fail(`${at}.${kind}`, "is a width in metres, more than 0");
    }
    const count: [number, number] = entry.count === undefined ? [1, 1] : reader.range(entry, "count", at, { allowEqual: true });
    if (count[0] < 0 || !Number.isInteger(count[0]) || !Number.isInteger(count[1])) reader.fail(`${at}.count`, `expected whole numbers, got [${count[0]}, ${count[1]}]`);
    if (where !== "anywhere" && entry.count !== undefined) reader.fail(`${at}.count`, "only an opening `anywhere` takes a count - one at a road or a trail is one to each");
    return [{ at: where, kind, gate, width, count, chance: reader.optionalNumber(entry, "chance", at, 1, { min: 0, max: 1 }) }];
  });
  return wall && isLineProp(wall) ? { wall, openings } : null;
}

/** A propGroups/ file - see PropGroupDef: its members, each a prop at a place in the group or on an
 *  earlier member, turned, with a chance. */
function readPropGroup(id: string, obj: RawObject, reader: Reader, props: Map<string, PropDef>): PropGroupDef {
  reader.onlyKeys(obj, "", ["name", "members"]);
  const members = reader.array(obj, "members", "").flatMap((raw, i): GroupMember[] => {
    const path = `members[${i}]`;
    const entry = reader.object(raw, path);
    reader.onlyKeys(entry, path, ["prop", "at", "on", "turn", "chance"]);
    const prop = props.get(reader.string(entry, "prop", path));
    if (!prop) {
      reader.fail(`${path}.prop`, `no prop "${String(entry.prop)}" (known: ${[...props.keys()].join(", ") || "none"})`);
      return [];
    }
    let at: [number, number] = [0, 0];
    if (entry.at !== undefined) {
      const value = entry.at;
      if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number")) at = [value[0], value[1]];
      else reader.fail(`${path}.at`, "expected [x, z] metres in the group");
    }
    let on: number | null = null;
    if (entry.on !== undefined) {
      on = reader.number(entry, "on", path, { min: 0, integer: true });
      if (on >= i) reader.fail(`${path}.on`, "names an earlier member, by its place in the list (0 the first)");
    }
    let turn: [number, number] = [0, 0];
    if (typeof entry.turn === "number") turn = [entry.turn, entry.turn];
    else if (entry.turn !== undefined) turn = reader.range(entry, "turn", path, { allowEqual: true });
    return [{ prop, at, on, turn, chance: reader.optionalNumber(entry, "chance", path, 1, { min: 0, max: 1 }) }];
  });
  if (members.length === 0) reader.fail("members", "needs at least one member");
  return { id, name: reader.string(obj, "name", ""), members };
}

/** A feature's `road` block - see PlaceRoadSpec. A settlement's importance is given per tier. */
function readPlaceRoad(obj: RawObject, reader: Reader, perTier: boolean): PlaceRoadSpec | null {
  if (obj.road === undefined) return null;
  const road = reader.object(obj.road, "road");
  reader.onlyKeys(road, "road", ["importance", "links", "wants", "maxLength"]);
  let importance: PlaceRoadSpec["importance"];
  if (perTier) {
    const tiers = reader.object(road.importance, "road.importance");
    reader.onlyKeys(tiers, "road.importance", SETTLEMENT_TIERS);
    importance = { hamlet: 0, village: 0, town: 0 };
    for (const tier of SETTLEMENT_TIERS) importance[tier] = reader.number(tiers, tier, "road.importance", { min: 0.01 });
  } else {
    importance = reader.number(road, "importance", "road", { min: 0.01 });
  }
  const links = reader.range(road, "links", "road", { allowEqual: true });
  if (links[0] < 1 || !Number.isInteger(links[0]) || !Number.isInteger(links[1])) reader.fail("road.links", `expected whole numbers, at least 1, got [${links[0]}, ${links[1]}]`);
  return {
    importance,
    links,
    wants: road.wants === undefined ? [] : reader.stringList(road, "wants", "road"),
    maxLength: reader.number(road, "maxLength", "road", { min: 0 }),
  };
}

/** `weather: [{ weather: id, odds }]` - which weathers, and how likely each is drawn next: its odds
 *  over the sum of them all, so they need not add up to anything. (Not `chance`: in a biome file
 *  that is a roll - see biomeRolls.ts.) */
function readWeatherChances(obj: RawObject, reader: Reader): WeatherChance[] {
  return reader.optionalArray(obj, "weather", "").map((raw, i) => {
    const path = `weather[${i}]`;
    const chance = reader.object(raw, path);
    reader.onlyKeys(chance, path, ["weather", "odds"]);
    return { weatherId: reader.string(chance, "weather", path), odds: reader.number(chance, "odds", path, { min: 0 }) };
  });
}

/** A weathers/ file - see WeatherDef. */
function readWeather(id: string, obj: RawObject, reader: Reader): WeatherDef {
  reader.onlyKeys(obj, "", ["name", "clouds", "skyGrey", "fog", "sun", "ambient", "wind", "precipitation", "lasts"]);
  const clouds = reader.object(obj.clouds ?? {}, "clouds");
  reader.onlyKeys(clouds, "clouds", ["cover", "darkness"]);
  const precipitation = reader.object(obj.precipitation ?? {}, "precipitation");
  reader.onlyKeys(precipitation, "precipitation", ["rain", "snow"]);
  return {
    id,
    name: reader.string(obj, "name", ""),
    cloudCover: reader.number(clouds, "cover", "clouds", { min: 0, max: 1 }),
    cloudDarkness: reader.optionalNumber(clouds, "darkness", "clouds", 0, { min: 0, max: 1 }),
    skyGrey: reader.optionalNumber(obj, "skyGrey", "", 0, { min: 0, max: 1 }),
    fog: reader.optionalNumber(obj, "fog", "", 1, { min: 0.02, max: 2 }),
    sun: reader.optionalNumber(obj, "sun", "", 1, { min: 0, max: 2 }),
    ambient: reader.optionalNumber(obj, "ambient", "", 1, { min: 0, max: 3 }),
    wind: reader.optionalNumber(obj, "wind", "", 1, { min: 0, max: 5 }),
    rain: reader.optionalNumber(precipitation, "rain", "precipitation", 0, { min: 0, max: 1 }),
    snow: reader.optionalNumber(precipitation, "snow", "precipitation", 0, { min: 0, max: 1 }),
    lasts: reader.range(obj, "lasts", "", { allowEqual: true }),
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
export function readTexture(raw: unknown, reader: Reader, path: string): TextureDef {
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
  reader.onlyKeys(foliage, "foliage", ["builder", "dark", "light", "stem", "stems", "leaves", "leafLength", "leafWidth", "bare", "flowers"]);
  const flowers = foliage.flowers === undefined ? null : reader.object(foliage.flowers, "foliage.flowers");
  if (flowers) reader.onlyKeys(flowers, "foliage.flowers", ["colors", "clusters", "size"]);
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
    flowers: flowers
      ? {
          colors: reader.array(flowers, "colors", "foliage.flowers").map((c, i) => reader.colorValue(c, `foliage.flowers.colors[${i}]`)),
          clusters: reader.number(flowers, "clusters", "foliage.flowers", { min: 1, integer: true }),
          size: reader.number(flowers, "size", "foliage.flowers", { min: 0.005, max: 0.2 }),
        }
      : null,
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
  // A tier's height may be below 0 - its branches swept up from the trunk rather than falling.
  const tierHeights = (o: RawObject): [number, number] => {
    const value = o.height;
    if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === "number")) {
      reader.fail("tiers.height", "expected [lowest tier, topmost tier]");
      return [1, 1];
    }
    return [value[0], value[1]];
  };
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
      height: tierHeights(tiers),
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
  reader.onlyKeys(obj, "", [...common, "variants", "trunk", "roots", "branches", "leaves", "crown", "vines", "ribs", "bark", "foliage"]);
  const section = (key: string, keys: string[]): RawObject => {
    const value = reader.object(obj[key], key);
    reader.onlyKeys(value, key, keys);
    return value;
  };
  const trunk = section("trunk", ["height", "radius", "topRadius", "lean", "wobble", "flare", "flareHeight", "bulge", "bulgeAt", "sides", "rings"]);
  const roots = section("roots", ["count", "length", "radius", "drop", "sides", "rings", "buttress", "stilt"]);
  const buttress = roots.buttress === undefined ? null : reader.object(roots.buttress, "roots.buttress");
  if (buttress) reader.onlyKeys(buttress, "roots.buttress", ["height", "thickness"]);
  const branches = section("branches", ["count", "from", "to", "length", "radius", "taper", "angle", "arc", "bend", "broken", "crook", "sides", "rings", "twigs"]);
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
  const ribsObj = obj.ribs === undefined ? null : section("ribs", ["count", "depth"]);
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
      to: optional(branches, "to", "branches", 1, { min: reader.number(branches, "from", "branches", { min: 0, max: 1 }), max: 1 }),
      length: reader.range(branches, "length", "branches", { allowEqual: true }),
      radius: reader.number(branches, "radius", "branches", { min: 0 }),
      taper: optional(branches, "taper", "branches", 0.78, { min: 0, max: 0.95 }),
      angle: reader.range(branches, "angle", "branches", { allowEqual: true }),
      arc: reader.number(branches, "arc", "branches"),
      bend: optional(branches, "bend", "branches", 2, { min: 1, max: 8 }),
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
    ribs: ribsObj
      ? {
          count: reader.number(ribsObj, "count", "ribs", { min: 3, max: 32, integer: true }),
          depth: reader.number(ribsObj, "depth", "ribs", { min: 0, max: 0.5 }),
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
    "roadFence",
    "roadBridge",
    "lakeChance",
    "borderType",
    "height",
    "relief",
    "trees",
    "bushes",
    "rocks",
    "treeRules",
    "treeTints",
    "settlement",
    "ground",
    "sky",
    "light",
    "weather",
    "features",
  ]);

  // One style, or a list of them - each place built in one that builds its tier.
  const settlementStyles: SettlementStyle[] = [];
  if (obj.settlement !== undefined && obj.settlement !== null) {
    const ids = Array.isArray(obj.settlement) ? reader.stringList(obj, "settlement", "") : [reader.string(obj, "settlement", "")];
    for (const styleId of ids) {
      const style = styles.get(styleId);
      if (style) settlementStyles.push(style);
      else reader.fail("settlement", `no settlement style "${styleId}" (known: ${[...styles.keys()].join(", ")})`);
    }
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
      relief: obj.relief === undefined ? undefined : readPipeline(obj.relief, reader, "relief"),
      foliage: obj.trees === undefined ? undefined : readPipeline(obj.trees, reader, "trees"),
      bushes: obj.bushes === undefined ? undefined : readPipeline(obj.bushes, reader, "bushes"),
      rocks: obj.rocks === undefined ? undefined : readPipeline(obj.rocks, reader, "rocks"),
    },
    borderType: obj.borderType === undefined ? "mountain" : reader.oneOf(obj, "borderType", "", BORDER_TYPES),
    spawnWeight: reader.number(obj, "spawnWeight", "", { min: 0 }),
    lakeChance: reader.optionalNumber(obj, "lakeChance", "", 0, { min: 0, max: 1 }),
    baseMaterialId: reader.string(ground, "base", "ground"),
    roadMaterialId: reader.string(ground, "road", "ground"),
    roadFenceId: obj.roadFence === undefined ? DEFAULT_ROAD_FENCE : reader.string(obj, "roadFence", ""),
    roadBridgeId: obj.roadBridge === undefined ? DEFAULT_ROAD_BRIDGE : reader.string(obj, "roadBridge", ""),
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
    settlementStyles,
    atmosphere: {
      horizon: reader.color(sky, "horizon", "sky"),
      zenith: reader.color(sky, "zenith", "sky"),
      cloud: reader.color(sky, "cloud", "sky"),
      fogStartFraction: reader.optionalNumber(sky, "fogStart", "sky", defaults.fogStart, { min: 0, max: 1 }),
      fogEndFraction: reader.optionalNumber(sky, "fogEnd", "sky", defaults.fogEnd, { min: 0.05, max: 1 }),
    },
    dayNight: readDayNight(light, reader, defaults),
    weather: obj.weather === undefined ? defaults.weather : readWeatherChances(obj, reader),
    features: obj.features === undefined ? defaults.features : readFeatureChances(obj, reader),
  };
}

const TIERS: readonly SettlementTier[] = ["hamlet", "village", "town"];

function readSettlementStyle(id: string, obj: RawObject, reader: Reader, buildings: Map<string, BuildingDef>): SettlementStyle {
  reader.onlyKeys(obj, "", ["tiers", "houses"]);

  const tiersRaw = reader.object(obj.tiers, "tiers");
  reader.onlyKeys(tiersRaw, "tiers", TIERS);
  // Only the tiers it gives: a style may build no hamlets, or no towns.
  const tiers: Partial<Record<SettlementTier, SettlementTierDef>> = {};
  for (const tier of TIERS) {
    if (tiersRaw[tier] === undefined) continue;
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
  if (Object.keys(tiers).length === 0) reader.fail("tiers", "needs at least one tier");

  const houses = reader.object(obj.houses, "houses");
  reader.onlyKeys(houses, "houses", ["buildings", "setback", "gap"]);
  const buildingList = reader.array(houses, "buildings", "houses").flatMap((raw, i) => {
    const path = `houses.buildings[${i}]`;
    const entry = reader.object(raw, path);
    reader.onlyKeys(entry, path, ["building", "weight", "tiers", "streets", "ring", "min", "max"]);
    const buildingId = reader.string(entry, "building", path);
    const building = buildings.get(buildingId);
    if (!building) {
      reader.fail(joinPath(path, "building"), `no building "${buildingId}" (known: ${[...buildings.keys()].join(", ") || "none"})`);
      return [];
    }
    const names = <T extends string>(key: string, known: readonly T[]): T[] | null => {
      if (entry[key] === undefined) return null;
      return reader.stringList(entry, key, path).filter((name): name is T => {
        if ((known as readonly string[]).includes(name)) return true;
        reader.fail(joinPath(path, key), `"${name}" is not one of ${known.join(", ")}`);
        return false;
      });
    };
    const ring: [number, number] = entry.ring === undefined ? [0, 1] : reader.range(entry, "ring", path, { allowEqual: true });
    const min = reader.optionalNumber(entry, "min", path, 0, { min: 0, integer: true });
    const max = entry.max === undefined || entry.max === null ? null : reader.number(entry, "max", path, { min: 0, integer: true });
    if (max !== null && max < min) reader.fail(joinPath(path, "max"), "is less than min");
    return [{ building, weight: reader.number(entry, "weight", path, { min: 0 }), tiers: names("tiers", TIERS), streets: names("streets", STREET_KINDS), ring, min, max }];
  });
  if (buildingList.length === 0) reader.fail("houses.buildings", "needs at least one building");

  return {
    id,
    tiers,
    houses: {
      buildings: buildingList,
      setback: reader.range(houses, "setback", "houses", { allowEqual: true }),
      gap: reader.range(houses, "gap", "houses", { allowEqual: true }),
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
