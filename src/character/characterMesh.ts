import { Bone, Color3, Material, Matrix, Mesh, Quaternion, RawTexture, Skeleton, StandardMaterial, Texture, Vector3, VertexData, type Scene } from "@babylonjs/core";
import type { BodyGeometry } from "./bodyMesh";
import { smoothNormals } from "./atlas";
import { cross, frameFor, normalize, sub, type BoneDef, type Vec } from "./skeleton";
import type { BakedGearMaterial } from "./gearMaterial";
import { timed } from "./bodyTiming";
import { TEXTURE_RESOLUTION } from "../world/materials/textureGen";

/** A pose: per bone name, a turn about the bone's own axes - x across it (bending forward and
 *  back), y along it (twisting), z toward its front (swinging out and in) - in radians. */
export type Pose = Record<string, [number, number, number]>;

/** How a body is coloured: one colour all over, or a painted atlas (atlas.ts, paint.ts) - its
 *  pixels, its size, and where each triangle corner is in it. */
export type BodySkin =
  | { color: [number, number, number] }
  | { pixels: Uint8Array; size: number; uvs: Float32Array; nearest: boolean };

export interface CharacterMesh {
  /** The body; gear's meshes are its children. */
  mesh: Mesh;
  /** The body and its gear, for shadows. */
  meshes: Mesh[];
  skeleton: Skeleton;
  /** Puts the body in a pose; bones it leaves out go back to the bind pose. `offset` moves the
   *  whole body, in metres (an animation's bob and crouch). */
  setPose: (pose: Pose, offset?: [number, number, number]) => void;
  dispose: () => void;
}

/**
 * A body drawn: the bind-pose geometry smooth-shaded - every triangle its own three vertices, for
 * its corners' places in the atlas, but each with its vertex's normal averaged over the faces round
 * it - skinned to a Babylon skeleton built from the same bones. Each bone's own axes
 * run y along it, z toward its front, x across, so a pose can bend a knee about x whichever way
 * the leg points.
 */
export function createCharacterMesh(scene: Scene, name: string, body: BodyGeometry, skin: BodySkin, gear?: Map<string, BakedGearMaterial>, skinColor?: [number, number, number]): CharacterMesh {
  const skeleton = timed("5 skeleton", () => new Skeleton(`${name}Skeleton`, `${name}Skeleton`, scene));
  const absolute = body.bones.map(boneMatrix);
  const rests: Quaternion[] = [];
  const restPositions: Vector3[] = [];
  const babylonBones: Bone[] = [];
  body.bones.forEach((def, i) => {
    const parent = def.parent >= 0 ? babylonBones[def.parent] : null;
    const local = def.parent >= 0 ? absolute[i].multiply(Matrix.Invert(absolute[def.parent])) : absolute[i].clone();
    const bone = new Bone(def.name, skeleton, parent, local, local.clone(), local.clone(), i);
    const rotation = new Quaternion();
    const position = new Vector3();
    local.decompose(undefined, rotation, position);
    rests.push(rotation);
    restPositions.push(position);
    babylonBones.push(bone);
  });

  // Every triangle its own vertices (a corner's texture place is its own), the normals smooth -
  // or, on a flat gear layer (a blade), its face's.
  const P = body.positions;
  const smooth = timed("6 smoothNormals", () => smoothNormals(body));
  const atlas = "uvs" in skin ? skin : null;
  function build(meshName: string, layer: number, uvOf: (corner: number) => [number, number] | null, flat: boolean): Mesh | null {
    const positions: number[] = [];
    const normals: number[] = [];
    const joints: number[] = [];
    const weights: number[] = [];
    const uvs: number[] = [];
    for (let t = 0; t < body.indices.length; t += 3) {
      if (body.triangleLayers[t / 3] !== layer) continue;
      const corners = [body.indices[t], body.indices[t + 1], body.indices[t + 2]];
      const at = (v: number): Vec => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      const face = normalize(cross(sub(at(corners[1]), at(corners[0])), sub(at(corners[2]), at(corners[0]))));
      corners.forEach((v, corner) => {
        const uv = uvOf(t + corner);
        if (uv) uvs.push(uv[0], uv[1]);
        positions.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
        if (flat) normals.push(face[0], face[1], face[2]);
        else normals.push(smooth[v * 3], smooth[v * 3 + 1], smooth[v * 3 + 2]);
        for (let k = 0; k < 4; k++) {
          joints.push(body.joints[v * 4 + k]);
          weights.push(body.weights[v * 4 + k]);
        }
      });
    }
    if (positions.length === 0) return null;
    const built = new Mesh(meshName, scene);
    const data = new VertexData();
    data.positions = positions;
    data.normals = normals;
    data.indices = Array.from({ length: positions.length / 3 }, (_, i) => i);
    data.matricesIndices = joints;
    data.matricesWeights = weights;
    if (uvs.length > 0) data.uvs = uvs;
    data.applyToMesh(built);
    built.numBoneInfluencers = 4;
    built.skeleton = skeleton;
    return built;
  }
  const mesh = timed("7 body vertex data + mesh", () => build(name, -1, (corner) => (atlas ? [atlas.uvs[corner * 2], atlas.uvs[corner * 2 + 1]] : null), false)!);
  const materials: Material[] = [];
  const textures: RawTexture[] = [];
  const prepare = (material: StandardMaterial, specular: number): void => {
    material.specularColor = new Color3(specular, specular, specular);
    material.specularPower = 16 + 48 * specular;
    // The sky and the sun, and the few house lights nearest it (lighting/playerLights.ts).
    material.maxSimultaneousLights = 6;
    // Wound counter-clockwise seen from outside, in the right-handed sense (bodyMesh.ts), which
    // Babylon's left-handed view sees as clockwise - as buildings are (buildingMesh.ts).
    material.backFaceCulling = true;
    material.sideOrientation = Material.ClockWiseSideOrientation;
    materials.push(material);
  };

  const material = new StandardMaterial(`${name}Material`, scene);
  if (atlas) {
    const texture = timed("8 atlas RawTexture (upload + mips)", () => RawTexture.CreateRGBATexture(atlas.pixels, atlas.size, atlas.size, scene, !atlas.nearest, false, atlas.nearest ? Texture.NEAREST_SAMPLINGMODE : Texture.TRILINEAR_SAMPLINGMODE));
    texture.name = `${name}Atlas`;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    textures.push(texture);
    material.diffuseTexture = texture;
  } else {
    material.diffuseColor = new Color3(..."color" in skin ? skin.color : [1, 1, 1]);
  }
  prepare(material, 0.05);
  mesh.material = material;

  // Gear: a mesh per material and colour, on the same skeleton, moving with the body. Its texture
  // tiles by the material's size, its colour the gear's tint.
  const meshes: Mesh[] = [mesh];
  const held: string[] = [];
  body.layers.forEach((layer, i) => {
    // A piece with a texture of its own has its places in it; the rest tile a material in metres.
    const own = layer.texture !== undefined ? body.pieceTextures[layer.texture] : undefined;
    const painted = own?.pixels ? own : undefined;
    const baked = painted ? undefined : gear?.get(layer.material);
    const size = baked?.def.size ?? 1;
    const part = timed("9 gear layer vertex data + mesh", () => build(`${name}Gear${i}`, i, painted ? (corner) => [body.gearUVs[corner * 2], body.gearUVs[corner * 2 + 1]] : (corner) => [body.gearUVs[corner * 2] / size, body.gearUVs[corner * 2 + 1] / size], layer.flat));
    if (!part) return;
    part.parent = mesh;
    const gearMaterial = new StandardMaterial(`${name}Gear${i}Material`, scene);
    // The race's own pieces (an elf's ears) are in the character's skin, whatever it is.
    gearMaterial.diffuseColor = painted ? new Color3(1, 1, 1) : new Color3(...(layer.material === "skin" && skinColor ? skinColor : layer.tint));
    if (painted) {
      const id = `piece:${layer.texture}:${identityOf(painted.pixels!)}`;
      if (!held.includes(id)) held.push(id);
      gearMaterial.diffuseTexture = holdPieceTexture(scene, `piece:${layer.texture}`, painted.pixels!, painted.size);
    } else if (baked) {
      if (!held.includes(layer.material)) held.push(layer.material);
      gearMaterial.diffuseTexture = holdTile(scene, layer.material, baked);
    }
    prepare(gearMaterial, baked?.def.shine ?? 0.05);
    part.material = gearMaterial;
    meshes.push(part);
  });

  const turn = new Quaternion();
  return {
    mesh,
    meshes,
    skeleton,
    setPose(pose, offset) {
      if (babylonBones[0]) babylonBones[0].setPosition(offset ? restPositions[0].add(new Vector3(...offset)) : restPositions[0]);
      body.bones.forEach((def, i) => {
        const angles = pose[def.name];
        if (angles) {
          Quaternion.FromEulerAnglesToRef(angles[0], angles[1], angles[2], turn);
          babylonBones[i].setRotationQuaternion(rests[i].multiply(turn));
        } else {
          babylonBones[i].setRotationQuaternion(rests[i]);
        }
      });
    },
    dispose() {
      for (const texture of textures) texture.dispose();
      for (const id of held) releaseTile(scene, id);
      for (const m of materials) m.dispose();
      for (const m of meshes) m.dispose();
      skeleton.dispose();
    },
  };
}

/** A bone's frame in the character's space, as a Babylon matrix: rows x, y (along it), z (its
 *  front), then its head. */
function boneMatrix(def: BoneDef): Matrix {
  const along = sub(def.tail, def.head);
  const frame = frameFor(along, [0, 0, 1]);
  const y = frame.along;
  const z = frame.front;
  const x = cross(y, z);
  return Matrix.FromArray([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, def.head[0], def.head[1], def.head[2], 1]);
}

/** A gear material's tile as a texture: one per scene however many bodies wear it - the bodies hold
 *  it, and the last to let go disposes it. (A tile is 1024 texels a side: 5.6 MB with its mips.) */
const tiles = new WeakMap<Scene, Map<string, { texture: RawTexture; holders: number; source: Uint8Array }>>();

function holdTile(scene: Scene, id: string, baked: BakedGearMaterial): RawTexture {
  let inScene = tiles.get(scene);
  if (!inScene) tiles.set(scene, (inScene = new Map()));
  let tile = inScene.get(id);
  // A material baked again (edited in the workbench) is a new buffer, so a new texture.
  if (tile && tile.source !== baked.color) {
    tile.holders = 0;
    inScene.delete(id);
    tile = undefined;
  }
  if (!tile) {
    const texture = timed("10 gear tile RawTexture (1024^2 upload + mips)", () => RawTexture.CreateRGBATexture(baked.color, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE));
    texture.name = `gear-${id}`;
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    inScene.set(id, (tile = { texture, holders: 0, source: baked.color }));
  }
  tile.holders++;
  return tile.texture;
}

function releaseTile(scene: Scene, id: string): void {
  const tile = tiles.get(scene)?.get(id);
  if (!tile || --tile.holders > 0) return;
  tile.texture.dispose();
  tiles.get(scene)!.delete(id);
}

/** A piece's own texture, held as the gear tiles are: one texture however many bodies (of one
 *  default body) wear the piece, a new one when its pixels are painted again. */
function holdPieceTexture(scene: Scene, id: string, pixels: Uint8Array, size: number): RawTexture {
  let inScene = tiles.get(scene);
  if (!inScene) tiles.set(scene, (inScene = new Map()));
  // The pixels are what says it is the same texture, not the index, which is a body's own.
  const key = `${id}:${identityOf(pixels)}`;
  let tile = inScene.get(key);
  if (!tile) {
    const texture = timed("10 piece texture (upload + mips)", () => RawTexture.CreateRGBATexture(pixels, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE));
    texture.name = `piece-${size}`;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    inScene.set(key, (tile = { texture, holders: 0, source: pixels }));
  }
  tile.holders++;
  return tile.texture;
}

const identities = new WeakMap<object, number>();
let nextIdentity = 1;
function identityOf(thing: object): number {
  let id = identities.get(thing);
  if (!id) identities.set(thing, (id = nextIdentity++));
  return id;
}
