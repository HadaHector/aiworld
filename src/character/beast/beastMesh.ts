import { Bone, Color3, Material, Matrix, Mesh, Quaternion, RawTexture, Skeleton, StandardMaterial, Texture, Vector3, VertexData, type Scene } from "@babylonjs/core";
import type { BeastGeometry } from "./beastBuild";
import type { PaintedBeast } from "./beastPaint";
import type { BeastPose } from "./beastAnim";
import { cross, frameFor, sub } from "../skeleton";

/** A beast drawn: its body and its cards, skinned to one skeleton (BEASTS.md). */
export interface BeastMesh {
  mesh: Mesh;
  meshes: Mesh[];
  skeleton: Skeleton;
  setPose: (pose: BeastPose) => void;
  /** Where a bone's head is in the world now. */
  bonePosition: (bone: number, out: Vector3) => void;
  dispose: () => void;
}

/** A bone's bind frame as a Babylon (row-vector) matrix: rows x, y along it, z its front, then its head. */
function boneMatrix(head: [number, number, number], tail: [number, number, number]): Matrix {
  const frame = frameFor(sub(tail, head), [0, 0, 1]);
  const y = frame.along;
  const z = frame.front;
  const x = cross(y, z);
  return Matrix.FromArray([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, head[0], head[1], head[2], 1]);
}

function rotationOnly(m: Matrix): Matrix {
  const r = m.clone();
  r.setTranslationFromFloats(0, 0, 0);
  return r;
}

export function createBeastMesh(scene: Scene, name: string, body: BeastGeometry, painted: PaintedBeast, options: { nearest?: boolean } = {}): BeastMesh {
  const skeleton = new Skeleton(`${name}Skeleton`, `${name}Skeleton`, scene);
  const absolute = body.bones.map((b) => boneMatrix(b.head, b.tail));
  const babylonBones: Bone[] = [];
  const restLocal: Matrix[] = [];
  const restPositions: Vector3[] = [];
  const parentRot: Matrix[] = [];
  const parentRotInv: Matrix[] = [];
  body.bones.forEach((def, i) => {
    const parent = def.parent >= 0 ? babylonBones[def.parent] : null;
    const local = def.parent >= 0 ? absolute[i].multiply(Matrix.Invert(absolute[def.parent])) : absolute[i].clone();
    babylonBones.push(new Bone(def.name, skeleton, parent, local, local.clone(), local.clone(), i));
    const position = new Vector3();
    local.decompose(undefined, undefined, position);
    restPositions.push(position);
    restLocal.push(rotationOnly(local));
    const p = def.parent >= 0 ? rotationOnly(absolute[def.parent]) : Matrix.Identity();
    parentRot.push(p);
    parentRotInv.push(Matrix.Invert(p));
  });

  const make = (meshName: string, positions: Float32Array, normals: Float32Array, uvs: Float32Array, joints: Float32Array, weights: Float32Array, indices: Uint32Array): Mesh => {
    const mesh = new Mesh(meshName, scene);
    const data = new VertexData();
    data.positions = positions;
    data.normals = normals;
    data.uvs = uvs;
    data.indices = indices;
    data.matricesIndices = joints;
    data.matricesWeights = weights;
    data.applyToMesh(mesh);
    mesh.numBoneInfluencers = 4;
    mesh.skeleton = skeleton;
    return mesh;
  };
  const mesh = make(name, body.positions, body.normals, body.uvs, body.joints, body.weights, body.indices);
  const held: Uint8Array[] = [];
  const materials: Material[] = [];
  const atlas = holdTexture(scene, painted.atlas, painted.size, painted.size, !!options.nearest);
  held.push(painted.atlas);
  const material = new StandardMaterial(`${name}Material`, scene);
  material.diffuseTexture = atlas;
  material.specularColor = new Color3(0.04, 0.04, 0.04);
  material.maxSimultaneousLights = 6;
  // Wound counter-clockwise seen from outside in the right-handed sense, as the humanoids are.
  material.backFaceCulling = true;
  material.sideOrientation = Material.ClockWiseSideOrientation;
  materials.push(material);
  mesh.material = material;
  const meshes = [mesh];

  if (painted.cards && body.cards.indices.length > 0) {
    const c = body.cards;
    const cards = make(`${name}Cards`, c.positions, c.normals, c.uvs, c.joints, c.weights, c.indices);
    cards.parent = mesh;
    const texture = holdTexture(scene, painted.cards.pixels, painted.cards.width, painted.cards.height, false);
    texture.hasAlpha = true;
    held.push(painted.cards.pixels);
    const cardMaterial = new StandardMaterial(`${name}CardMaterial`, scene);
    cardMaterial.diffuseTexture = texture;
    cardMaterial.useAlphaFromDiffuseTexture = true;
    cardMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
    cardMaterial.alphaCutOff = 0.5;
    cardMaterial.backFaceCulling = false;
    cardMaterial.twoSidedLighting = true;
    cardMaterial.specularColor = new Color3(0, 0, 0);
    cardMaterial.maxSimultaneousLights = 6;
    materials.push(cardMaterial);
    cards.material = cardMaterial;
    meshes.push(cards);
  }

  const turn = new Matrix();
  const delta = new Matrix();
  const local = new Matrix();
  const q = new Quaternion();
  const position = new Vector3();
  return {
    mesh,
    meshes,
    skeleton,
    setPose(pose) {
      const r = pose.rotations;
      for (let i = 0; i < babylonBones.length; i++) {
        const x = r[i * 4];
        const y = r[i * 4 + 1];
        const z = r[i * 4 + 2];
        const w = r[i * 4 + 3];
        if (Math.abs(w) > 0.999999) {
          babylonBones[i].setRotationMatrix(restLocal[i]);
        } else {
          // The turn in the body's bind frame, as a row-vector matrix (the transpose of the column one),
          // moved into the parent's bind frame and applied after the bone's own rest.
          const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
          Matrix.FromValuesToRef(1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0, 2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0, 2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0, 0, 0, 0, 1, turn);
          parentRot[i].multiplyToRef(turn, delta);
          delta.multiplyToRef(parentRotInv[i], delta);
          restLocal[i].multiplyToRef(delta, local);
          Quaternion.FromRotationMatrixToRef(local, q);
          babylonBones[i].setRotationQuaternion(q);
        }
      }
      babylonBones[0].setPosition(position.copyFrom(restPositions[0]).addInPlaceFromFloats(pose.offset[0], pose.offset[1], pose.offset[2]));
    },
    bonePosition(bone, out) {
      const b = babylonBones[bone] ?? babylonBones[0];
      b.getAbsolutePositionToRef(mesh, out);
    },
    dispose() {
      for (const pixels of held) releaseTexture(scene, pixels);
      for (const m of materials) m.dispose();
      for (const m of meshes) m.dispose();
      skeleton.dispose();
    },
  };
}

/** A painted texture, one per scene however many beasts share the making it came from: held by count,
 *  disposed by the last to let go. */
const textures = new WeakMap<Scene, Map<Uint8Array, { texture: RawTexture; holders: number }>>();

function holdTexture(scene: Scene, pixels: Uint8Array, width: number, height: number, nearest: boolean): RawTexture {
  let inScene = textures.get(scene);
  if (!inScene) textures.set(scene, (inScene = new Map()));
  let entry = inScene.get(pixels);
  if (!entry) {
    const texture = RawTexture.CreateRGBATexture(pixels, width, height, scene, !nearest, false, nearest ? Texture.NEAREST_SAMPLINGMODE : Texture.TRILINEAR_SAMPLINGMODE);
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    inScene.set(pixels, (entry = { texture, holders: 0 }));
  }
  entry.holders++;
  return entry.texture;
}

function releaseTexture(scene: Scene, pixels: Uint8Array): void {
  const inScene = textures.get(scene);
  const entry = inScene?.get(pixels);
  if (!entry || --entry.holders > 0) return;
  entry.texture.dispose();
  inScene!.delete(pixels);
}
