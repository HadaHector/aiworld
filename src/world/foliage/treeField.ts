import {
  Color3,
  Matrix,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  Vector3,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import type { TreePlacement } from "./treeScatter";
import {
  TRUNK_HEIGHT,
  TRUNK_DIAMETER_BOTTOM,
  TRUNK_DIAMETER_TOP,
  TRUNK_SIDES,
  CANOPY_CENTRE_Y,
  CANOPY_RADIUS,
  CANOPY_HEIGHT_RATIO,
} from "./foliageConfig";

export interface TreeField {
  /** Replaces whatever trees were registered under this key. */
  setChunk: (key: string, trees: TreePlacement[]) => void;
  clearChunk: (key: string) => void;
  /** Republishes the instance buffers if anything changed since the last call. Cheap when nothing did. */
  flush: () => void;
  setVisible: (visible: boolean) => void;
  readonly treeCount: number;
  dispose: () => void;
}

const TRUNK_COLOUR = new Color3(0.32, 0.23, 0.15);
// The two ends of the canopy palette a tree's tint mixes between.
const CANOPY_DARK = new Color3(0.15, 0.33, 0.13);
const CANOPY_LIGHT = new Color3(0.38, 0.56, 0.21);

/** Instances are allocated in powers of two from here, so a walk across the world does not
 *  reallocate on every chunk - only on the rare crossing of a power of two. */
const MIN_CAPACITY = 1024;

/** One chunk's trees, already in the form the GPU wants them. */
interface ChunkBlock {
  count: number;
  matrices: Float32Array;
  colours: Float32Array;
}

function foliageMaterial(scene: Scene, name: string, colour: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = colour;
  // The scene is lit by a single hemispheric light; a specular highlight on a placeholder trunk
  // just reads as plastic.
  material.specularColor = Color3.Black();
  return material;
}

/**
 * The placeholder tree, and the one draw call that draws all of them.
 *
 * Both parts are built with the base of the trunk at the model origin and the canopy already
 * lifted into place, so a tree is a single transform - position, uniform scale, a spin about Y -
 * and the *same* matrix drives both meshes. That is what makes this two thin-instance buffers
 * rather than a parent/child hierarchy per tree: at a 2000-unit draw distance the world holds
 * several thousand trees, and each one being a scene node would cost more in traversal than the
 * geometry costs to draw.
 *
 * A tree's matrix is composed once, when its chunk is built, and from then on is only ever copied.
 * Recomposing every tree on every chunk event instead cost 18.5ms at a 1200-unit draw distance -
 * a dropped frame every time a chunk came or went, which while walking is most of them.
 */
export function createTreeField(scene: Scene): TreeField {
  const trunk = MeshBuilder.CreateCylinder(
    "treeTrunk",
    {
      height: TRUNK_HEIGHT,
      diameterBottom: TRUNK_DIAMETER_BOTTOM,
      diameterTop: TRUNK_DIAMETER_TOP,
      tessellation: TRUNK_SIDES,
    },
    scene,
  );
  trunk.bakeTransformIntoVertices(Matrix.Translation(0, TRUNK_HEIGHT / 2, 0));
  trunk.material = foliageMaterial(scene, "treeTrunkMaterial", TRUNK_COLOUR);

  const canopy = MeshBuilder.CreateIcoSphere("treeCanopy", { radius: 1, subdivisions: 2 }, scene);
  canopy.bakeTransformIntoVertices(
    Matrix.Scaling(CANOPY_RADIUS, CANOPY_RADIUS * CANOPY_HEIGHT_RATIO, CANOPY_RADIUS).multiply(
      Matrix.Translation(0, CANOPY_CENTRE_Y, 0),
    ),
  );
  // Faceted rather than smooth: a low-poly sphere shaded smooth reads as a balloon, shaded flat it
  // reads as stylised foliage, which is much closer to what this is standing in for.
  canopy.convertToFlatShadedMesh();
  canopy.material = foliageMaterial(scene, "treeCanopyMaterial", Color3.White());

  // The instances cover every chunk that is loaded, which is a disc centred on the player - so the
  // master mesh is in view whenever anything is, and asking whether its bounding box intersects the
  // frustum can only ever answer yes. Computing that box meant transforming every instance on every
  // chunk event (3.8ms at 6236 trees) to learn nothing.
  trunk.alwaysSelectAsActiveMesh = true;
  canopy.alwaysSelectAsActiveMesh = true;

  const chunks = new Map<string, ChunkBlock>();
  let count = 0;
  let dirty = false;

  let capacity = 0;
  let matrices = new Float32Array(0);
  let colours = new Float32Array(0);
  let published = false;

  const scaling = new Vector3();
  const rotation = new Quaternion();
  const position = new Vector3();
  const matrix = new Matrix();

  function toBlock(trees: TreePlacement[]): ChunkBlock {
    const block: ChunkBlock = {
      count: trees.length,
      matrices: new Float32Array(trees.length * 16),
      colours: new Float32Array(trees.length * 4),
    };
    for (let i = 0; i < trees.length; i++) {
      const tree = trees[i];
      scaling.set(tree.scale, tree.scale, tree.scale);
      Quaternion.RotationYawPitchRollToRef(tree.rotation, 0, 0, rotation);
      position.set(tree.x, tree.y, tree.z);
      Matrix.ComposeToRef(scaling, rotation, position, matrix);
      matrix.copyToArray(block.matrices, i * 16);

      block.colours[i * 4] = CANOPY_DARK.r + (CANOPY_LIGHT.r - CANOPY_DARK.r) * tree.tint;
      block.colours[i * 4 + 1] = CANOPY_DARK.g + (CANOPY_LIGHT.g - CANOPY_DARK.g) * tree.tint;
      block.colours[i * 4 + 2] = CANOPY_DARK.b + (CANOPY_LIGHT.b - CANOPY_DARK.b) * tree.tint;
      block.colours[i * 4 + 3] = 1;
    }
    return block;
  }

  /** Returns true if the buffers moved and so have to be handed to the meshes again. */
  function ensureCapacity(needed: number): boolean {
    if (needed <= capacity) return false;
    let next = Math.max(MIN_CAPACITY, capacity);
    while (next < needed) next *= 2;
    capacity = next;
    matrices = new Float32Array(capacity * 16);
    colours = new Float32Array(capacity * 4);
    return true;
  }

  function setInstanceBuffer(mesh: Mesh, kind: string, data: Float32Array, stride: number): void {
    // staticBuffer false: the contents are rewritten whenever a chunk comes or goes, and the whole
    // point of holding capacity is to refill this buffer in place rather than build a new one.
    mesh.thinInstanceSetBuffer(kind, data, stride, false);
  }

  function flush(): void {
    if (!dirty) return;
    dirty = false;

    let total = 0;
    for (const block of chunks.values()) total += block.count;
    count = total;

    if (total === 0 && !published) return;

    const moved = ensureCapacity(total);

    let at = 0;
    for (const block of chunks.values()) {
      matrices.set(block.matrices, at * 16);
      colours.set(block.colours, at * 4);
      at += block.count;
    }

    if (moved || !published) {
      // The colour buffer goes first: setting a buffer republishes the instance count from its
      // length, so the matrix buffer - which is what actually decides how many trees are drawn -
      // has to be the one that lands last.
      setInstanceBuffer(canopy, "color", colours, 4);
      setInstanceBuffer(canopy, "matrix", matrices, 16);
      setInstanceBuffer(trunk, "matrix", matrices, 16);
      published = true;
    } else {
      canopy.thinInstanceBufferUpdated("color");
      canopy.thinInstanceBufferUpdated("matrix");
      trunk.thinInstanceBufferUpdated("matrix");
    }

    // Held capacity means the buffers are longer than the number of trees in them, so the count
    // has to be stated rather than inferred from their length.
    canopy.thinInstanceCount = total;
    trunk.thinInstanceCount = total;
  }

  return {
    setChunk(key, trees) {
      if (trees.length === 0) {
        if (chunks.delete(key)) dirty = true;
        return;
      }
      chunks.set(key, toBlock(trees));
      dirty = true;
    },
    clearChunk(key) {
      if (chunks.delete(key)) dirty = true;
    },
    flush,
    setVisible(visible) {
      trunk.setEnabled(visible);
      canopy.setEnabled(visible);
    },
    get treeCount() {
      return count;
    },
    dispose() {
      chunks.clear();
      trunk.dispose();
      canopy.dispose();
    },
  };
}
