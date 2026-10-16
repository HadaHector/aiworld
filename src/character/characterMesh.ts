import { Bone, Color3, Material, Matrix, Mesh, Quaternion, RawTexture, Skeleton, StandardMaterial, Texture, Vector3, VertexData, type Scene } from "@babylonjs/core";
import type { BodyGeometry } from "./bodyMesh";
import { smoothNormals } from "./atlas";
import { cross, frameFor, sub, type BoneDef } from "./skeleton";

/** A pose: per bone name, a turn about the bone's own axes - x across it (bending forward and
 *  back), y along it (twisting), z toward its front (swinging out and in) - in radians. */
export type Pose = Record<string, [number, number, number]>;

/** How a body is coloured: one colour all over, or a painted atlas (atlas.ts, paint.ts) - its
 *  pixels, its size, and where each triangle corner is in it. */
export type BodySkin =
  | { color: [number, number, number] }
  | { pixels: Uint8Array; size: number; uvs: Float32Array; nearest: boolean };

export interface CharacterMesh {
  mesh: Mesh;
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
export function createCharacterMesh(scene: Scene, name: string, body: BodyGeometry, skin: BodySkin): CharacterMesh {
  const skeleton = new Skeleton(`${name}Skeleton`, `${name}Skeleton`, scene);
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

  // Every triangle its own vertices (a corner's atlas place is its own), the normals smooth.
  const P = body.positions;
  const smooth = smoothNormals(body);
  const positions: number[] = [];
  const normals: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const uvs: number[] = [];
  const atlas = "uvs" in skin ? skin : null;
  for (let t = 0; t < body.indices.length; t += 3) {
    const [a, b, c] = [body.indices[t], body.indices[t + 1], body.indices[t + 2]];
    for (const [corner, v] of [a, b, c].entries()) {
      if (atlas) uvs.push(atlas.uvs[(t + corner) * 2], atlas.uvs[(t + corner) * 2 + 1]);
      positions.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      normals.push(smooth[v * 3], smooth[v * 3 + 1], smooth[v * 3 + 2]);
      for (let k = 0; k < 4; k++) {
        joints.push(body.joints[v * 4 + k]);
        weights.push(body.weights[v * 4 + k]);
      }
    }
  }
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.indices = Array.from({ length: positions.length / 3 }, (_, i) => i);
  data.matricesIndices = joints;
  data.matricesWeights = weights;
  if (atlas) data.uvs = uvs;
  data.applyToMesh(mesh);
  mesh.numBoneInfluencers = 4;
  mesh.skeleton = skeleton;

  const material = new StandardMaterial(`${name}Material`, scene);
  let texture: RawTexture | null = null;
  if (atlas) {
    texture = RawTexture.CreateRGBATexture(atlas.pixels, atlas.size, atlas.size, scene, !atlas.nearest, false, atlas.nearest ? Texture.NEAREST_SAMPLINGMODE : Texture.TRILINEAR_SAMPLINGMODE);
    texture.name = `${name}Atlas`;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    material.diffuseTexture = texture;
  } else {
    material.diffuseColor = new Color3(..."color" in skin ? skin.color : [1, 1, 1]);
  }
  material.specularColor = new Color3(0.05, 0.05, 0.05);
  // The sky and the sun, and the few house lights nearest it (lighting/playerLights.ts).
  material.maxSimultaneousLights = 6;
  // Wound counter-clockwise seen from outside, in the right-handed sense (bodyMesh.ts), which
  // Babylon's left-handed view sees as clockwise - as buildings are (buildingMesh.ts).
  material.backFaceCulling = true;
  material.sideOrientation = Material.ClockWiseSideOrientation;
  mesh.material = material;

  const turn = new Quaternion();
  return {
    mesh,
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
      texture?.dispose();
      material.dispose();
      mesh.dispose();
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
