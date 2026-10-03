import { ArcRotateCamera, Color4, Mesh, MeshBuilder, Scene, Vector3, VertexData, type Engine } from "@babylonjs/core";
import type { AreaWeight } from "../world/cells/areaField";
import type { BiomeDefinition } from "../world/biomes/biomeTypes";
import type { WorldContent } from "../world/content/worldContent";
import type { MaterialDef, GrassSpec } from "../world/materials/materialTypes";
import type { TreeKindDef } from "../world/foliage/foliageConfig";
import type { TreePlacement } from "../world/foliage/treeScatter";
import type { TreeField } from "../world/foliage/treeField";
import { createSunLighting } from "../world/lighting/sunLighting";
import { createSkyDome } from "../world/sky/skyDome";
import { createTerrainMaterial, type TerrainMaterial } from "../world/materials/materialLibrary";
import { createLitShading, type LitShading } from "../world/materials/litShading";
import type { BakedBark } from "../world/foliage/treeModels";
import { bakedAtlas, bakedBark, bakedGround, isGroundBaked } from "./bakeCache";
import { createGrassField } from "../world/foliage/grassField";
import { scatterGrass } from "../world/foliage/grassScatter";
import { createTreeField } from "../world/foliage/treeField";
import { NO_WEATHER } from "../world/weather/weatherTypes";
import type { BuildingModel } from "../world/buildings/buildingTypes";
import { createBuildingMaterial, createBuildingMesh } from "../world/buildings/buildingMesh";

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
  trees?: { kinds: TreeKindDef[]; specimens: { kind: string; variant?: number; scale: number }[]; far: boolean };
  /** Buildings to stand in a row across the middle of the ground, fronts toward the camera. */
  buildings?: BuildingModel[];
  /** Mark each building's footprint and door on the ground. */
  footprints?: boolean;
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
function heightFunction(shape: GroundShape): (x: number, z: number) => number {
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
function buildGroundPatch(scene: Scene, height: (x: number, z: number) => number): Mesh {
  const grid = PATCH_SUBDIVISIONS + 1;
  const step = PATCH_SIZE / PATCH_SUBDIVISIONS;
  const half = PATCH_SIZE / 2;
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
    const height = heightFunction(options.bare ? "flat" : shape);
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
    let framing = { width: 0, height: 1 };
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
      framing = placed.framing;
    }

    if (options.buildings && options.buildings.length > 0) {
      options.onProgress?.("Raising buildings");
      framing = layOutBuildings(scene, options.buildings, height, litShading, sunLighting.shadowGenerator, options.footprints === true);
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
      alpha: options.buildings ? Math.PI / 2 - 0.5 : options.trees ? -Math.PI / 2 + 0.15 : -Math.PI / 2 + 0.5,
      beta: options.buildings ? 1.2 : options.trees ? 1.45 : 1.15,
      radius: options.trees || options.buildings ? Math.max(4, fitWidth, fitHeight) * 1.15 : 22,
      target: [0, height(0, 0) + (options.trees || options.buildings ? framing.height * 0.45 : 0.5), 0] as [number, number, number],
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
      const patch = buildGroundPatch(scene, height);
      patch.material = terrain.terrainMaterial;
    }

    if (options.grass.length > 0 && terrain) {
      options.onProgress?.("Growing grass");
      const grass = createGrassField(scene, seed, litShading, content.grassKinds);
      const step = PATCH_SIZE / PATCH_SUBDIVISIONS;
      const half = PATCH_SIZE / 2;
      const scattered = scatterGrass(
        {
          size: PATCH_SIZE,
          subdivisions: PATCH_SUBDIVISIONS,
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
      grass.setChunk("patch", scattered, 0, 0, PATCH_SIZE);
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
  litShading: LitShading,
  shadowGenerator: { addShadowCaster: (mesh: Mesh, includeDescendants?: boolean) => void },
  marks: boolean,
): { width: number; height: number } {
  const material = createBuildingMaterial(scene, litShading);
  const gap = 4;
  const width = models.reduce((sum, model) => sum + model.halfWidth * 2, 0) + gap * Math.max(0, models.length - 1);
  let x = -width / 2;
  models.forEach((model, i) => {
    x += model.halfWidth;
    const mesh = createBuildingMesh(scene, `building_${i}`, model, material);
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
      post.material = material;
      post.setVerticesData("color", new Array((post.getTotalVertices()) * 4).fill(0).map((_, k) => [1, 0.85, 0.2, 1][k % 4]));
      post.isPickable = false;
    }
    x += model.halfWidth + gap;
  });
  return { width, height: Math.max(1, ...models.map((model) => model.height)) };
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
