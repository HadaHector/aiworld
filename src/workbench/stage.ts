import { ArcRotateCamera, Color3, Color4, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3, VertexData, type Engine } from "@babylonjs/core";
import type { AreaWeight } from "../world/cells/areaField";
import type { BiomeDefinition } from "../world/biomes/biomeTypes";
import type { WorldContent } from "../world/content/worldContent";
import type { MaterialDef, GrassSpec } from "../world/materials/materialTypes";
import type { TreeKindDef } from "../world/foliage/foliageConfig";
import type { TreePlacement } from "../world/foliage/treeScatter";
import type { TreeField } from "../world/foliage/treeField";
import { createSunLighting } from "../world/lighting/sunLighting";
import { createSkyDome } from "../world/sky/skyDome";
import { applyTerrainCuts, createTerrainMaterial, type TerrainCut, type TerrainMaterial } from "../world/materials/materialLibrary";
import { WALL } from "../world/buildings/interiorGeometry";
import { createLitShading, type LitShading } from "../world/materials/litShading";
import type { BakedBark } from "../world/foliage/treeModels";
import { bakedAtlas, bakedBark, bakedGround, isGroundBaked } from "./bakeCache";
import { createGrassField } from "../world/foliage/grassField";
import { scatterGrass } from "../world/foliage/grassScatter";
import { createTreeField } from "../world/foliage/treeField";
import { convexHull } from "../world/collision/hull";
import type { ConvexDesc } from "../world/collision/shapes";
import { NO_WEATHER } from "../world/weather/weatherTypes";
import type { BuildingModel } from "../world/buildings/buildingTypes";
import { DEFAULT_PAD_BLEND, type Pad } from "../world/settlements/padField";
import { placedAxes } from "../world/buildings/buildingRenderer";
import { appendModel, bakeBuildingTextures, bakeModelLight, createBuildingMaterial, createBuildingMesh, emptyGeometry, type BuildingMaterial } from "../world/buildings/buildingMesh";

/**
 * Collision pieces drawn over what they stand for: each a see-through orange hull with its edges -
 * and the leaves taken away, which would only hide the trunk they are being compared with.
 */
function drawColliders(scene: Scene, pieces: ConvexDesc[], alpha = 0.35): void {
  for (const mesh of scene.meshes) if (mesh.name.endsWith("_leaves")) mesh.setEnabled(false);
  const fill = new StandardMaterial("colliderFill", scene);
  fill.diffuseColor = new Color3(1, 0.55, 0.15);
  fill.emissiveColor = new Color3(0.35, 0.18, 0.04);
  fill.alpha = alpha;
  fill.backFaceCulling = false;
  const positions: number[] = [];
  const indices: number[] = [];
  const lines: Vector3[][] = [];
  for (const piece of pieces) {
    const hull = piece.triangles ? { points: piece.points, triangles: Array.from(piece.triangles) } : convexHull(piece.points);
    const base = positions.length / 3;
    for (const p of hull.points) positions.push(p.x, p.y, p.z);
    const t = hull.triangles;
    const seen = new Set<string>();
    for (let i = 0; i < t.length; i += 3) {
      // Babylon winds the other way round.
      indices.push(base + t[i], base + t[i + 2], base + t[i + 1]);
      for (const [a, b] of [[t[i], t[i + 1]], [t[i + 1], t[i + 2]], [t[i + 2], t[i]]]) {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pa = hull.points[a], pb = hull.points[b];
        lines.push([new Vector3(pa.x, pa.y, pa.z), new Vector3(pb.x, pb.y, pb.z)]);
      }
    }
  }
  if (positions.length === 0) return;
  const mesh = new Mesh("colliders", scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  data.applyToMesh(mesh);
  mesh.material = fill;
  mesh.isPickable = false;
  const edges = MeshBuilder.CreateLineSystem("colliderEdges", { lines }, scene);
  edges.color = new Color3(1, 0.6, 0.2);
  edges.alpha = 0.8;
  edges.isPickable = false;
}

/** A placed model's collision shapes, as convex pieces: turned to face (frontX, frontZ) and stood at
 *  (x, y, z), as the world turns a house. */
function placedPieces(model: BuildingModel, at: { x: number; y: number; z: number; frontX: number; frontZ: number; up?: [number, number, number] }): ConvexDesc[] {
  const a = placedAxes(at);
  const place = (px: number, py: number, pz: number) => ({ x: at.x + a.x.x * px + a.y.x * py + a.z.x * pz, y: at.y + a.x.y * px + a.y.y * py + a.z.y * pz, z: at.z + a.x.z * px + a.y.z * py + a.z.z * pz });
  const pieces: ConvexDesc[] = [];
  const boxes = model.colliders?.boxes ?? new Float32Array(0);
  for (let i = 0; i < boxes.length; i += 6) {
    const [x0, y0, z0, x1, y1, z1] = boxes.subarray(i, i + 6);
    pieces.push({ kind: "convex", points: [place(x0, y0, z0), place(x1, y0, z0), place(x0, y1, z0), place(x1, y1, z0), place(x0, y0, z1), place(x1, y0, z1), place(x0, y1, z1), place(x1, y1, z1)] });
  }
  for (const hull of model.colliders?.hulls ?? []) {
    const points = [];
    for (let i = 0; i < hull.length; i += 3) points.push(place(hull[i], hull[i + 1], hull[i + 2]));
    pieces.push({ kind: "convex", points });
  }
  return pieces;
}

/**
 * Pads outlined: each one's edge at its own level - yellow, or cyan for a firm one (a prop's) - and,
 * fainter, how far its blend back to the ground can reach at the most, on the ground. Drawn over
 * everything, so an outline under a building shows through it.
 */
function drawPads(scene: Scene, pads: Pad[], height: (x: number, z: number) => number): void {
  const outline = (pad: Pad, grow: number, onGround: boolean): Vector3[] => {
    const at = (x: number, z: number): Vector3 => new Vector3(x, (onGround ? height(x, z) : pad.y) + 0.12, z);
    if (pad.radius > 0) {
      return Array.from({ length: 65 }, (_, k) => {
        const a = (k / 64) * Math.PI * 2;
        return at(pad.x + Math.cos(a) * (pad.radius + grow), pad.z + Math.sin(a) * (pad.radius + grow));
      });
    }
    const hw = pad.hw + grow;
    const hd = pad.hd + grow;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => at(pad.x + pad.ux * hw * a - pad.uz * hd * b, pad.z + pad.uz * hw * a + pad.ux * hd * b));
  };
  const edges = MeshBuilder.CreateLineSystem(
    "padEdges",
    { lines: pads.map((pad) => outline(pad, 0, false)), colors: pads.map((pad) => outline(pad, 0, false).map(() => (pad.firm ? new Color4(0.3, 0.95, 1, 1) : new Color4(1, 0.85, 0.2, 1)))) },
    scene,
  );
  const reach = MeshBuilder.CreateLineSystem(
    "padReach",
    { lines: pads.map((pad) => outline(pad, (pad.blend ?? DEFAULT_PAD_BLEND).max, true)), colors: pads.map((pad) => outline(pad, (pad.blend ?? DEFAULT_PAD_BLEND).max, true).map(() => (pad.firm ? new Color4(0.3, 0.95, 1, 0.22) : new Color4(1, 0.85, 0.2, 0.22)))), useVertexAlpha: true },
    scene,
  );
  for (const mesh of [edges, reach]) {
    mesh.isPickable = false;
    mesh.renderingGroupId = 1;
  }
}

/** Roads, lanes and trails as strips laid on the ground - each its own shade of trodden earth. */
function drawLines(
  scene: Scene,
  lines: { points: { x: number; z: number }[]; width: number; kind: "road" | "lane" | "trail" }[],
  yards: { x: number; z: number; radius: number }[],
  height: (x: number, z: number) => number,
): void {
  const colors = { road: new Color3(0.42, 0.36, 0.28), lane: new Color3(0.5, 0.43, 0.33), trail: new Color3(0.36, 0.3, 0.22), yard: new Color3(0.46, 0.4, 0.31) };
  /** Laid on the ground: a hair over it, and drawn as if nearer than it, so it never sinks into it. */
  const onGround = (name: string, color: Color3): StandardMaterial => {
    const material = new StandardMaterial(name, scene);
    material.diffuseColor = color;
    material.specularColor = new Color3(0, 0, 0);
    material.zOffset = -4;
    return material;
  };
  yards.forEach((yard, n) => {
    // Rings out from its middle, each following the ground.
    const rings: Vector3[][] = [];
    const segments = 64;
    for (let r = 0; r <= yard.radius + 1e-6; r += Math.min(1.5, yard.radius)) {
      rings.push(Array.from({ length: segments + 1 }, (_, k) => {
        const a = (k / segments) * Math.PI * 2;
        const x = yard.x + Math.cos(a) * r;
        const z = yard.z + Math.sin(a) * r;
        return new Vector3(x, height(x, z) + 0.05, z);
      }));
    }
    const disc = MeshBuilder.CreateRibbon(`yard_${n}`, { pathArray: rings, sideOrientation: Mesh.DOUBLESIDE }, scene);
    disc.material = onGround(`yard_${n}`, colors.yard);
    disc.isPickable = false;
  });
  lines.forEach((line, n) => {
    const left: Vector3[] = [];
    const right: Vector3[] = [];
    for (let i = 0; i + 1 < line.points.length; i++) {
      const a = line.points[i];
      const b = line.points[i + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(length));
      const sx = (-(b.z - a.z) / length) * (line.width / 2);
      const sz = ((b.x - a.x) / length) * (line.width / 2);
      for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
        const x = a.x + ((b.x - a.x) * s) / steps;
        const z = a.z + ((b.z - a.z) * s) / steps;
        left.push(new Vector3(x + sx, height(x + sx, z + sz) + 0.06, z + sz));
        right.push(new Vector3(x - sx, height(x - sx, z - sz) + 0.06, z - sz));
      }
    }
    if (left.length < 2) return;
    // Across it too, a metre apart, so it follows the ground across a wide road as well as along it.
    const across = Math.max(1, Math.ceil(line.width));
    const paths = Array.from({ length: across + 1 }, (_, k) =>
      left.map((l, i) => {
        const r = right[i];
        const x = l.x + ((r.x - l.x) * k) / across;
        const z = l.z + ((r.z - l.z) * k) / across;
        return new Vector3(x, height(x, z) + 0.06, z);
      }),
    );
    const ribbon = MeshBuilder.CreateRibbon(`line_${n}`, { pathArray: paths, sideOrientation: Mesh.DOUBLESIDE }, scene);
    ribbon.material = onGround(`line_${n}`, colors[line.kind]);
    ribbon.isPickable = false;
  });
}

/** A building's collision shapes, as convex pieces, stood at (x, y, 0). */
function buildingPieces(model: BuildingModel, x: number, y: number): ConvexDesc[] {
  const pieces: ConvexDesc[] = [];
  const at = (px: number, py: number, pz: number) => ({ x: x + px, y: y + py, z: pz });
  const boxes = model.colliders?.boxes ?? new Float32Array(0);
  for (let i = 0; i < boxes.length; i += 6) {
    const [x0, y0, z0, x1, y1, z1] = boxes.subarray(i, i + 6);
    pieces.push({ kind: "convex", points: [at(x0, y0, z0), at(x1, y0, z0), at(x0, y1, z0), at(x1, y1, z0), at(x0, y0, z1), at(x1, y0, z1), at(x0, y1, z1), at(x1, y1, z1)] });
  }
  for (const hull of model.colliders?.hulls ?? []) {
    const points = [];
    for (let i = 0; i < hull.length; i += 3) points.push(at(hull[i], hull[i + 1], hull[i + 2]));
    pieces.push({ kind: "convex", points });
  }
  return pieces;
}

/** The ground's shape under a preview. */
export type GroundShape = "flat" | "hills" | "steep";

/** Where the camera is looking from - kept across previews of the same thing, so re-previewing
 *  after an edit does not throw away the angle being studied. */
export interface CameraView {
  alpha: number;
  beta: number;
  radius: number;
  target: [number, number, number];
}

export interface StageOptions {
  seed: number;
  content: WorldContent;
  /** The patch of ground everything stands on. */
  ground: MaterialDef;
  /** What grows on it - none for bare ground. */
  grass: GrassSpec[];
  shape: GroundShape;
  /** Just the trees, on a plain background: no ground, grass or sky. */
  bare?: boolean;
  /** Trees to stand in a row across the middle of the ground, each at its own scale; a variant
   *  left out is hashed from where it stands, as in the world. */
  trees?: { kinds: TreeKindDef[]; specimens: { kind: string; variant?: number; scale: number }[]; far: boolean; colliders?: boolean };
  /** Buildings to stand in a row across the middle of the ground, fronts toward the camera. */
  buildings?: BuildingModel[];
  /** Draw the buildings' collision shapes in place of the buildings themselves. */
  buildingColliders?: boolean;
  /** Mark each building's footprint and door on the ground. */
  footprints?: boolean;
  /** A whole place instead - a feature laid out (see featurePreview.ts): its own ground, levelled,
   *  its buildings and props standing where it put them, turned as it turned them, its roads and
   *  trails drawn on the ground, and the trees round it. */
  site?: {
    size: number;
    heightAt: (x: number, z: number) => number;
    placed: { x: number; y: number; z: number; frontX: number; frontZ: number; up?: [number, number, number]; model: BuildingModel }[];
    lines: { points: { x: number; z: number }[]; width: number; kind: "road" | "lane" | "trail" }[];
    /** Trodden rounds: a yard, out to its level ground's edge. */
    yards: { x: number; z: number; radius: number }[];
    trees: TreePlacement[];
    /** Trees drawn as the world draws distant ones. */
    farTrees: TreePlacement[];
    /** Its pads, outlined at their levels - or none. */
    pads?: Pad[];
    far: boolean;
  };
  timeHours: number;
  /** Whose sky and light: a biome's day-night settings. */
  lightBiome: BiomeDefinition;
  /** The camera to start from, or undefined to frame the stage. */
  view?: CameraView;
  onProgress?: (phase: string) => void;
}

export interface Stage {
  scene: Scene;
  camera: ArcRotateCamera;
  setTime: (hours: number) => void;
  getView: () => CameraView;
  dispose: () => void;
}

/** The patch's side, in metres: three of the terrain texture's 50 m repeats, so tiling shows. */
const PATCH_SIZE = 150;
/** Grid squares along a side - a metre each, finer than the game's nearest terrain (2.7 m). */
const PATCH_SUBDIVISIONS = 150;
/** How far the sky and fog reach: well past the patch, so the ground is never fogged out. */
const DRAW_DISTANCE = 2000;

/** The ground's height at (x, z). Deterministic sines rather than noise: the same shape every
 *  time, whatever the seed, so two previews of an edit compare like for like. */
export function heightFunction(shape: GroundShape): (x: number, z: number) => number {
  if (shape === "flat") return () => 0;
  const amplitude = shape === "hills" ? 1 : 5;
  return (x, z) =>
    amplitude *
    (2.2 * Math.sin(x * 0.041 + 0.7) * Math.cos(z * 0.037 - 0.4) +
      1.1 * Math.sin(x * 0.093 + z * 0.071 + 1.3) +
      0.45 * Math.sin(-x * 0.19 + z * 0.23 + 0.2) +
      // A long ramp, so steep ground has one real slope rather than only bumps.
      (shape === "steep" ? x * 0.12 : 0));
}

/** A grid at ground level, `half` metres out each way: a line every metre, a stronger one every
 *  five, and the two axes through the origin tinted - x red, z blue. */
function buildGrid(scene: Scene, half: number): void {
  const lines: Vector3[][] = [];
  const colors: Color4[][] = [];
  const minor = new Color4(0.32, 0.36, 0.42, 1);
  const major = new Color4(0.5, 0.55, 0.62, 1);
  const xAxis = new Color4(0.75, 0.35, 0.35, 1);
  const zAxis = new Color4(0.35, 0.5, 0.8, 1);
  for (let i = -half; i <= half; i++) {
    const shade = i % 5 === 0 ? major : minor;
    lines.push([new Vector3(i, 0, -half), new Vector3(i, 0, half)]);
    colors.push(i === 0 ? [zAxis, zAxis] : [shade, shade]);
    lines.push([new Vector3(-half, 0, i), new Vector3(half, 0, i)]);
    colors.push(i === 0 ? [xAxis, xAxis] : [shade, shade]);
  }
  const grid = MeshBuilder.CreateLineSystem("grid", { lines, colors }, scene);
  grid.isPickable = false;
}

/** A square of ground, one material everywhere, with its normals from the height function. */
function buildGroundPatch(scene: Scene, height: (x: number, z: number) => number, size = PATCH_SIZE): Mesh {
  // A metre a square, whatever the patch's size.
  const subdivisions = Math.round((size / PATCH_SIZE) * PATCH_SUBDIVISIONS);
  const grid = subdivisions + 1;
  const step = size / subdivisions;
  const half = size / 2;
  const positions = new Float32Array(grid * grid * 3);
  const normals = new Float32Array(grid * grid * 3);
  const matIndices = new Float32Array(grid * grid * 4);
  const matWeights = new Float32Array(grid * grid * 4);
  const indices: number[] = [];
  const e = 0.25;
  for (let row = 0; row < grid; row++) {
    for (let col = 0; col < grid; col++) {
      const v = row * grid + col;
      const x = -half + col * step;
      const z = -half + row * step;
      positions[v * 3] = x;
      positions[v * 3 + 1] = height(x, z);
      positions[v * 3 + 2] = z;
      const n = new Vector3(height(x - e, z) - height(x + e, z), 2 * e, height(x, z - e) - height(x, z + e)).normalize();
      normals[v * 3] = n.x;
      normals[v * 3 + 1] = n.y;
      normals[v * 3 + 2] = n.z;
      // The one material, at full weight, in the first of the triangle's slots.
      matWeights[v * 4] = 1;
      // Wound so the top faces up, as the terrain shader culls back faces.
      if (row < grid - 1 && col < grid - 1) indices.push(v, v + 1, v + grid, v + 1, v + grid + 1, v + grid);
    }
  }
  const mesh = new Mesh("groundPatch", scene);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.indices = indices;
  data.applyToMesh(mesh);
  mesh.setVerticesData("matIndices", matIndices, false, 4);
  mesh.setVerticesData("matWeights", matWeights, false, 4);
  mesh.isPickable = false;
  return mesh;
}

/**
 * One preview: a patch of ground under the game's own sun and sky, with the game's own grass and
 * trees on it - every part built by the code the world is built by, so what shows here is what
 * shows in the world. A fresh Babylon scene each time; the engine and canvas are kept.
 */
export async function createStage(engine: Engine, canvas: HTMLCanvasElement, options: StageOptions): Promise<Stage> {
  const { seed, content, ground, shape, lightBiome } = options;
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.53, 0.75, 0.92, 1);
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogEnd = DRAW_DISTANCE;

  try {
    const site = options.site;
    const height = site ? site.heightAt : heightFunction(options.bare ? "flat" : shape);
    const patchSize = site ? site.size : PATCH_SIZE;
    const sunLighting = createSunLighting(scene);
    const areaWeights: AreaWeight[] = [{ areaId: 0, biome: lightBiome, weight: 1 }];
    // updateDayNight with no time passing is what first applies a biome's day-night settings;
    // setTimeHours then only moves the clock.
    sunLighting.updateDayNight(0, areaWeights);
    sunLighting.setTimeHours(options.timeHours);
    if (options.bare) {
      scene.clearColor = new Color4(0.16, 0.18, 0.21, 1);
      scene.fogMode = Scene.FOGMODE_NONE;
    } else {
      const sky = createSkyDome(scene);
      scene.onBeforeRenderObservable.add(() => sky.update(areaWeights, DRAW_DISTANCE, sunLighting.getTimeHours(), sunLighting.direction, NO_WEATHER));
    }

    // With no ground to draw, only the light-and-shadow feed the trees are lit through - no ground
    // texture to bake. Otherwise the ground's bake comes from the workbench's cache.
    let terrain: TerrainMaterial | null = null;
    let litShading: LitShading;
    if (options.bare) {
      litShading = createLitShading(scene, sunLighting);
    } else {
      options.onProgress?.(isGroundBaked(ground, seed) ? "Laying the ground" : "Baking the ground texture");
      terrain = await createTerrainMaterial(scene, seed, [ground], sunLighting, undefined, await bakedGround(ground, seed));
      litShading = terrain.litShading;
    }

    // The trees first, since the camera frames them: the field is what knows how big they are.
    let field: TreeField | null = null;
    let framing: { width: number; height: number; placed?: number[] } = { width: 0, height: 1 };
    if (options.trees) {
      options.onProgress?.("Growing trees");
      const kinds = options.trees.kinds;
      const barks = new Map<string, BakedBark>();
      const atlases = new Map<string, Uint8Array>();
      for (const kind of kinds) {
        const bark = await bakedBark(kind, seed);
        if (bark) barks.set(kind.id, bark);
        const atlas = bakedAtlas(kind, seed);
        if (atlas) atlases.set(kind.id, atlas);
      }
      field = await createTreeField(scene, sunLighting.shadowGenerator, kinds, seed, litShading, { barks, atlases });
      const placed = layOutSpecimens(options.trees.specimens, field, height);
      field.setChunk("stage", placed.trees, options.trees.far ? 1 : 0);
      field.flush();
      if (options.trees.colliders) drawColliders(scene, field.colliders(placed.trees));
      framing = placed.framing;
    }

    if (site) {
      if (site.trees.length + site.farTrees.length > 0) {
        options.onProgress?.("Growing the wood");
        const used = new Set([...site.trees, ...site.farTrees].map((tree) => tree.kind));
        const kinds = content.treeKinds.filter((kind) => used.has(kind.id));
        const barks = new Map<string, BakedBark>();
        const atlases = new Map<string, Uint8Array>();
        for (const kind of kinds) {
          const bark = await bakedBark(kind, seed);
          if (bark) barks.set(kind.id, bark);
          const atlas = bakedAtlas(kind, seed);
          if (atlas) atlases.set(kind.id, atlas);
        }
        field = await createTreeField(scene, sunLighting.shadowGenerator, kinds, seed, litShading, { barks, atlases });
        field.setChunk("site", site.trees, site.far ? 1 : 0);
        field.setChunk("siteFar", site.farTrees, 1);
        field.flush();
      }
      options.onProgress?.("Baking building materials");
      const buildingMaterial = createBuildingMaterial(scene, litShading, await bakeBuildingTextures(seed, content.buildingMaterials));
      options.onProgress?.("Raising the buildings and setting the props down");
      site.placed.forEach((item, i) => {
        // Its front (+z) turned to (frontX, frontZ), its +x to (frontZ, -frontX), tipped to its up -
        // as in the world.
        const a = placedAxes(item);
        const geometry = emptyGeometry();
        const lightmap = bakeModelLight(item.model, buildingMaterial);
        appendModel(geometry, item.model, buildingMaterial.layerOf, (px, py, pz) => [a.x.x * px + a.y.x * py + a.z.x * pz, a.x.y * px + a.y.y * py + a.z.y * pz, a.x.z * px + a.y.z * py + a.z.z * pz], lightmap?.uvs);
        const mesh = createBuildingMesh(scene, `building_${i}`, geometry, buildingMaterial, lightmap);
        mesh.position.set(item.x, item.y, item.z);
        sunLighting.shadowGenerator.addShadowCaster(mesh, false);
      });
      if (options.buildingColliders) {
        for (const mesh of scene.meshes) if (mesh.name.startsWith("building_")) mesh.setEnabled(false);
        drawColliders(scene, site.placed.flatMap((item) => placedPieces(item.model, item)), 0.55);
      }
      drawLines(scene, site.lines, site.yards, height);
      if (site.pads) drawPads(scene, site.pads, height);
      framing = { width: site.size * 0.75, height: 10 };
    }

    if (options.buildings && options.buildings.length > 0) {
      options.onProgress?.("Baking building materials");
      const buildingMaterial = createBuildingMaterial(scene, litShading, await bakeBuildingTextures(seed, content.buildingMaterials));
      options.onProgress?.("Raising buildings");
      framing = layOutBuildings(scene, options.buildings, height, buildingMaterial, sunLighting.shadowGenerator, options.footprints === true);
      if (options.buildingColliders) {
        // In the buildings' place: what they put in the way would hide behind their own walls.
        for (const mesh of scene.meshes) if (mesh.name.startsWith("building_")) mesh.setEnabled(false);
        const placed = framing.placed ?? [];
        drawColliders(scene, options.buildings.flatMap((model, i) => buildingPieces(model, placed[i], height(placed[i], 0))), 0.55);
      }
    }

    // Far enough back for the whole row and the tallest top to fit the view, whichever way the
    // canvas is shaped. Babylon's fov is the vertical one.
    const fov = 0.8;
    const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
    const fitWidth = framing.width / 2 / (Math.tan(fov / 2) * aspect);
    const fitHeight = framing.height / 2 / Math.tan(fov / 2);
    const view = options.view ?? {
      // The row runs along x: looked at nearly face on, so none of it hides behind the rest.
      // Buildings face +z, so they are looked at from the front and a little to the side.
      alpha: site ? Math.PI / 2 - 0.6 : options.buildings ? Math.PI / 2 - 0.5 : options.trees ? -Math.PI / 2 + 0.15 : -Math.PI / 2 + 0.5,
      beta: site ? 0.85 : options.buildings ? 1.2 : options.trees ? 1.45 : 1.15,
      radius: site ? site.size * 0.5 : options.trees || options.buildings ? Math.max(4, fitWidth, fitHeight) * 1.15 : 22,
      target: [0, height(0, 0) + (site ? 0 : options.trees || options.buildings ? framing.height * 0.45 : 0.5), 0] as [number, number, number],
    };
    const camera = new ArcRotateCamera("workbenchCamera", view.alpha, view.beta, view.radius, new Vector3(...view.target), scene);
    camera.lowerRadiusLimit = 1.5;
    camera.upperRadiusLimit = 600;
    camera.upperBetaLimit = Math.PI / 2 + 0.3;
    camera.wheelDeltaPercentage = 0.02;
    camera.panningSensibility = 60;
    camera.attachControl(canvas, true);
    // Sets the near plane to the 1 m the shadow cascades are laid out from (see sunLighting.ts) -
    // nearer, and the generator's cascades would stop matching the shaders' own split distances.
    // Hence the zoom limit: the camera never gets close enough to cut into what it orbits.
    sunLighting.attachCamera(camera);

    if (options.bare) {
      // A model has no ground to stand on, so it can be looked at from below too - with a grid at
      // ground level to read its size and where its base is against.
      camera.upperBetaLimit = Math.PI - 0.05;
      buildGrid(scene, Math.max(10, Math.ceil((framing.width / 2 + 4) / 5) * 5));
    } else if (terrain) {
      const patch = buildGroundPatch(scene, height, patchSize);
      patch.material = terrain.terrainMaterial;
      // The ground taken out over the buildings' cellars, as in the world.
      applyTerrainCuts([terrain.terrainMaterial], cellarCuts(options.buildings ?? [], framing.placed ?? []));
    }

    if (options.grass.length > 0 && terrain) {
      options.onProgress?.("Growing grass");
      const grass = createGrassField(scene, seed, litShading, content.grassKinds);
      const subdivisions = Math.round((patchSize / PATCH_SIZE) * PATCH_SUBDIVISIONS);
      const step = patchSize / subdivisions;
      const half = patchSize / 2;
      const scattered = scatterGrass(
        {
          size: patchSize,
          subdivisions,
          originX: 0,
          originZ: 0,
          blendAt: () => new Map([[0, 1]]),
          // Rows run from the far (+z) edge, as a chunk's do.
          surfaceHeight: (row, col, u, v) => height(-half + (col + u) * step, half - (row + v) * step),
        },
        [{ ...ground, grass: options.grass }],
        content.grassKinds,
        seed,
        terrain.averageColors,
      );
      grass.setChunk("patch", scattered, 0, 0, patchSize);
    }

    await scene.whenReadyAsync();
    return {
      scene,
      camera,
      setTime: (hours) => sunLighting.setTimeHours(hours),
      getView: () => ({ alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: [camera.target.x, camera.target.y, camera.target.z] }),
      dispose: () => scene.dispose(),
    };
  } catch (error) {
    scene.dispose();
    throw error;
  }
}

/** Stands buildings in a row along x, fronts to +z, each on the ground under its own footprint's
 *  middle, and says how wide and tall the row is. With `marks`, outlines each footprint on the
 *  ground and puts a post at its door. */
function layOutBuildings(
  scene: Scene,
  models: BuildingModel[],
  height: (x: number, z: number) => number,
  material: BuildingMaterial,
  shadowGenerator: { addShadowCaster: (mesh: Mesh, includeDescendants?: boolean) => void },
  marks: boolean,
): { width: number; height: number; placed: number[] } {
  const placed: number[] = [];
  const markMaterial = new StandardMaterial("doorMark", scene);
  markMaterial.emissiveColor = new Color3(1, 0.85, 0.2);
  markMaterial.disableLighting = true;
  const gap = 4;
  const width = models.reduce((sum, model) => sum + model.halfWidth * 2, 0) + gap * Math.max(0, models.length - 1);
  let x = -width / 2;
  models.forEach((model, i) => {
    x += model.halfWidth;
    placed.push(x);
    const geometry = emptyGeometry();
    const lightmap = bakeModelLight(model, material);
    appendModel(geometry, model, material.layerOf, (px, py, pz) => [px, py, pz], lightmap?.uvs);
    const mesh = createBuildingMesh(scene, `building_${i}`, geometry, material, lightmap);
    const y = height(x, 0);
    mesh.position.set(x, y, 0);
    shadowGenerator.addShadowCaster(mesh, false);
    if (marks) {
      const w = model.halfWidth;
      const d = model.halfDepth;
      const lift = 0.08;
      const outline = MeshBuilder.CreateLines(
        `footprint_${i}`,
        { points: [[-w, -d], [w, -d], [w, d], [-w, d], [-w, -d]].map(([px, pz]) => new Vector3(x + px, height(x + px, pz) + lift, pz)) },
        scene,
      );
      outline.color.set(1, 0.85, 0.2);
      outline.isPickable = false;
      // The plan's tiles, where the generator has a plan.
      if (model.tiles && model.tiles.length > 0) {
        const lines = model.tiles.map((t) =>
          [[t.x0, t.z0], [t.x1, t.z0], [t.x1, t.z1], [t.x0, t.z1], [t.x0, t.z0]].map(([px, pz]) => new Vector3(x + px, height(x + px, pz) + lift * 2, pz)),
        );
        const plan = MeshBuilder.CreateLineSystem(`plan_${i}`, { lines }, scene);
        plan.color.set(0.3, 0.9, 1);
        plan.isPickable = false;
        // Drawn over everything, so the plan shows through the house standing on it.
        plan.renderingGroupId = 1;
      }
      const post = MeshBuilder.CreateCylinder(`door_${i}`, { height: 3, diameter: 0.25 }, scene);
      post.position.set(x + model.door.x, height(x + model.door.x, model.door.z) + 1.5, model.door.z + 0.5);
      post.material = markMaterial;
      post.isPickable = false;
    }
    x += model.halfWidth + gap;
  });
  return { width, height: Math.max(1, ...models.map((model) => model.height)), placed };
}

/** The ground over each building's cellars, the buildings standing at `placed` along x. */
function cellarCuts(models: BuildingModel[], placed: number[]): TerrainCut[] {
  return models.flatMap((model, n) => {
    const interior = model.interior;
    if (!interior) return [];
    const { X0, Z0, tile } = interior;
    return interior.layout.rooms
      .filter((room) => room.base < 0)
      .map((room): TerrainCut => {
        const x0 = X0 + room.rect.i0 * tile + WALL;
        const x1 = X0 + room.rect.i1 * tile - WALL;
        const z0 = Z0 + room.rect.j0 * tile + WALL;
        const z1 = Z0 + room.rect.j1 * tile - WALL;
        return { x: placed[n] + (x0 + x1) / 2, z: (z0 + z1) / 2, ux: 1, uz: 0, halfWidth: (x1 - x0) / 2, halfDepth: (z1 - z0) / 2 };
      });
  });
}

/** Stands specimens in a row along x, centred on the origin, each far enough from the next that
 *  their crowns do not touch - and says how wide and tall the row is, for framing it. */
function layOutSpecimens(
  specimens: { kind: string; variant?: number; scale: number }[],
  field: TreeField,
  height: (x: number, z: number) => number,
): { trees: TreePlacement[]; framing: { width: number; height: number } } {
  const sizes = specimens.map((specimen) => {
    const size = field.sizeOf(specimen.kind);
    return { radius: size.radius * specimen.scale, height: size.height * specimen.scale };
  });
  const gap = 1.5;
  const width = sizes.reduce((sum, size) => sum + size.radius * 2, 0) + gap * Math.max(0, specimens.length - 1);
  let x = -width / 2;
  const trees = specimens.map((specimen, i) => {
    x += sizes[i].radius;
    const tree: TreePlacement = { kind: specimen.kind, variant: specimen.variant, scale: specimen.scale, x, y: height(x, 0), z: 0, rotation: 0, tint: 0.5 };
    x += sizes[i].radius + gap;
    return tree;
  });
  return { trees, framing: { width, height: Math.max(1, ...sizes.map((size) => size.height)) } };
}
