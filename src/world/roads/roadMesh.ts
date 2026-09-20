import {
  Color3,
  DynamicTexture,
  Mesh,
  StandardMaterial,
  Texture,
  VertexData,
  type Scene,
} from "@babylonjs/core";
import type { TerrainSampler } from "../terrain/terrainSampler";
import type { RoadRun } from "./roadChunkIndex";
import {
  ROAD_MESH_HALF_WIDTH,
  ROAD_MESH_LIFT,
  ROAD_MESH_TEXTURE_LENGTH,
  ROAD_MESH_Z_OFFSET,
} from "./roadConfig";

/**
 * A dirt road surface, drawn once into a canvas rather than shipped as an asset.
 *
 * Wraps along the road (v) and clamps across it (u), so the ruts stay where they are put instead of
 * repeating across the width, and the tiling seam falls where the road is already varying.
 */
export function createRoadMaterial(scene: Scene, seed: number): StandardMaterial {
  const size = 256;
  const texture = new DynamicTexture("roadTexture", { width: size, height: size }, scene, true);
  const context = texture.getContext() as CanvasRenderingContext2D;

  // Deterministic, so the surface is the same every run - the world is seeded everywhere else and
  // a texture that changed between loads would be the one thing that did not.
  let state = (seed ^ 0x9e3779b9) >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  context.fillStyle = "rgb(122, 104, 82)";
  context.fillRect(0, 0, size, size);

  // Grit. Enough of it that the surface reads as loose material at walking distance rather than as
  // a flat brown band.
  for (let i = 0; i < 24000; i++) {
    const shade = 60 + random() * 90;
    const warm = shade + random() * 28;
    context.fillStyle = `rgba(${warm | 0}, ${(shade * 0.88) | 0}, ${(shade * 0.66) | 0}, ${0.25 + random() * 0.4})`;
    const r = 0.5 + random() * 1.8;
    context.fillRect(random() * size, random() * size, r, r);
  }

  // Two wheel ruts, darker and slightly damp, wandering a little down the length so they do not
  // read as painted lines.
  for (const centre of [0.33, 0.67]) {
    for (let y = 0; y < size; y++) {
      const wander = Math.sin((y / size) * Math.PI * 4 + centre * 9) * 3 + Math.sin(y * 0.17) * 1.5;
      const x = centre * size + wander;
      context.fillStyle = "rgba(78, 64, 48, 0.5)";
      context.fillRect(x - 5, y, 10, 1);
      context.fillStyle = "rgba(64, 52, 38, 0.45)";
      context.fillRect(x - 2, y, 4, 1);
    }
  }

  texture.update(false);
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;

  const material = new StandardMaterial("roadMaterial", scene);
  material.diffuseTexture = texture;
  material.specularColor = new Color3(0, 0, 0);
  // Polygon offset. The ribbon sits a few centimetres above ground that it follows exactly, which
  // is not always enough on its own at distance - this biases it in depth as well, which is what
  // stops the terrain punching through it in specks when the camera is far away.
  material.zOffset = ROAD_MESH_Z_OFFSET;
  return material;
}

export interface RoadChunkOptions {
  name: string;
  runs: RoadRun[];
  sampleTerrain: TerrainSampler;
  material: StandardMaterial;
}

/**
 * Builds one chunk's worth of road as a ribbon draped over the terrain.
 *
 * The height of every vertex is the terrain's own height at that point plus a small lift, so the
 * road follows the ground exactly rather than floating over a rise and sinking into a dip - which
 * is what a fixed offset from a smoothed line would do. It also means the road is currently as
 * bumpy as the ground under it: nothing has been flattened yet, and that is the next piece of work,
 * not an oversight here.
 *
 * Both edges are sampled independently rather than one centre height being used for the pair, so
 * the ribbon banks with the slope it is crossing instead of hovering on one side.
 */
export function createRoadChunk(scene: Scene, options: RoadChunkOptions): Mesh | null {
  const { name, runs, sampleTerrain, material } = options;
  if (runs.length === 0) return null;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const run of runs) {
    const points = run.points;
    if (points.length < 2) continue;
    const base = positions.length / 3;
    let arc = run.arcOffset;

    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      // Tangent from both neighbours, so it turns smoothly through a corner instead of snapping at
      // it - and so a point shared with the next chunk gets the same tangent there.
      const previous = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      let dx = next.x - previous.x;
      let dz = next.z - previous.z;
      const length = Math.hypot(dx, dz);
      if (length <= 0) {
        dx = 1;
        dz = 0;
      } else {
        dx /= length;
        dz /= length;
      }

      const leftX = point.x + dz * ROAD_MESH_HALF_WIDTH;
      const leftZ = point.z - dx * ROAD_MESH_HALF_WIDTH;
      const rightX = point.x - dz * ROAD_MESH_HALF_WIDTH;
      const rightZ = point.z + dx * ROAD_MESH_HALF_WIDTH;

      positions.push(
        leftX, sampleTerrain(leftX, leftZ).height + ROAD_MESH_LIFT, leftZ,
        rightX, sampleTerrain(rightX, rightZ).height + ROAD_MESH_LIFT, rightZ,
      );

      if (i > 0) arc += Math.hypot(point.x - points[i - 1].x, point.z - points[i - 1].z);
      const v = arc / ROAD_MESH_TEXTURE_LENGTH;
      uvs.push(0, v, 1, v);

      if (i > 0) {
        // Wound so the face normal comes out upward. The other order builds the same ribbon with
        // its normals pointing at the ground, which renders as an unlit black band - correct
        // geometry, no light on it.
        const a = base + (i - 1) * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }

  if (indices.length === 0) return null;

  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);

  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.uvs = uvs;
  data.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  return mesh;
}
