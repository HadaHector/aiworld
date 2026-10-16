import { Bone, Color3, Material, Matrix, Mesh, Quaternion, Skeleton, StandardMaterial, VertexData, type Scene } from "@babylonjs/core";
import type { BodyGeometry } from "./bodyMesh";
import { cross, frameFor, normalize, sub, type BoneDef, type Vec } from "./skeleton";

/** A pose: per bone name, a turn about the bone's own axes - x across it (bending forward and
 *  back), y along it (twisting), z toward its front (swinging out and in) - in radians. */
export type Pose = Record<string, [number, number, number]>;

export interface CharacterMesh {
  mesh: Mesh;
  skeleton: Skeleton;
  /** Puts the body in a pose; bones it leaves out go back to the bind pose. */
  setPose: (pose: Pose) => void;
  dispose: () => void;
}

/**
 * A body drawn: the bind-pose geometry made flat-shaded (each triangle its own three vertices, so
 * the facets read), skinned to a Babylon skeleton built from the same bones. Each bone's own axes
 * run y along it, z toward its front, x across, so a pose can bend a knee about x whichever way
 * the leg points.
 */
export function createCharacterMesh(scene: Scene, name: string, body: BodyGeometry, skin: [number, number, number]): CharacterMesh {
  const skeleton = new Skeleton(`${name}Skeleton`, `${name}Skeleton`, scene);
  const absolute = body.bones.map(boneMatrix);
  const rests: Quaternion[] = [];
  const babylonBones: Bone[] = [];
  body.bones.forEach((def, i) => {
    const parent = def.parent >= 0 ? babylonBones[def.parent] : null;
    const local = def.parent >= 0 ? absolute[i].multiply(Matrix.Invert(absolute[def.parent])) : absolute[i].clone();
    const bone = new Bone(def.name, skeleton, parent, local, local.clone(), local.clone(), i);
    const rotation = new Quaternion();
    local.decompose(undefined, rotation);
    rests.push(rotation);
    babylonBones.push(bone);
  });

  // Flat: every triangle its own vertices, its normal its face's.
  const P = body.positions;
  const positions: number[] = [];
  const normals: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  for (let t = 0; t < body.indices.length; t += 3) {
    const [a, b, c] = [body.indices[t], body.indices[t + 1], body.indices[t + 2]];
    const pa: Vec = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
    const pb: Vec = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]];
    const pc: Vec = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
    const n = normalize(cross(sub(pb, pa), sub(pc, pa)));
    for (const v of [a, b, c]) {
      positions.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      normals.push(n[0], n[1], n[2]);
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
  data.applyToMesh(mesh);
  mesh.numBoneInfluencers = 4;
  mesh.skeleton = skeleton;

  const material = new StandardMaterial(`${name}Material`, scene);
  material.diffuseColor = new Color3(...skin);
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
    setPose(pose) {
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
