import { Matrix, Quaternion, Vector3, type Mesh } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import type { TreePlacement } from "./treeScatter";
import { TREE_KINDS, type TreeKind } from "./foliageConfig";
import { createTreeModel, type TreeModel } from "./treeModels";

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

/** Instances are allocated in powers of two from here, so a walk across the world does not
 *  reallocate on every chunk - only on the rare crossing of a power of two. */
const MIN_CAPACITY = 512;

/** One chunk's trees of one archetype, already in the form the GPU wants them. */
interface Block {
  count: number;
  matrices: Float32Array;
  colours: Float32Array;
}

const EMPTY: Block = { count: 0, matrices: new Float32Array(0), colours: new Float32Array(0) };

/** One archetype's masters and the buffer every loaded chunk's instances of it are packed into. */
interface Species {
  model: TreeModel;
  capacity: number;
  matrices: Float32Array;
  colours: Float32Array;
  published: boolean;
  count: number;
}

/**
 * Every tree in the world, in two draw calls per archetype.
 *
 * A tree is a single transform - position, uniform scale, a spin about Y - and its trunk and its
 * canopy are built around a shared origin, so the *same* matrix drives both meshes. That is what
 * makes this thin instances rather than a scene node per tree: at a 2000-unit draw distance the
 * world holds several thousand trees, and traversing them as nodes would cost more than the
 * geometry costs to draw.
 *
 * A tree's matrix is composed once, when its chunk is built, and from then on is only ever copied.
 * Recomposing every tree on every chunk event instead cost 18.5ms at a 1200-unit draw distance -
 * a dropped frame every time a chunk came or went, which while walking is most of them.
 */
export function createTreeField(scene: Scene): TreeField {
  const species = new Map<TreeKind, Species>();
  for (const kind of TREE_KINDS) {
    const model = createTreeModel(scene, kind);
    // The instances cover every chunk that is loaded, which is a disc centred on the player - so a
    // master mesh is in view whenever anything is, and asking whether its bounding box intersects
    // the frustum can only ever answer yes. Computing that box meant transforming every instance on
    // every chunk event (3.8ms at 6236 trees) to learn nothing.
    model.trunk.alwaysSelectAsActiveMesh = true;
    model.canopy.alwaysSelectAsActiveMesh = true;
    species.set(kind, {
      model,
      capacity: 0,
      matrices: new Float32Array(0),
      colours: new Float32Array(0),
      published: false,
      count: 0,
    });
  }

  /** Per chunk, one block per archetype - most of them empty, since a zone grows one kind of tree
   *  and only its borders grow two. */
  const chunks = new Map<string, Map<TreeKind, Block>>();
  let count = 0;
  let dirty = false;

  const scaling = new Vector3();
  const rotation = new Quaternion();
  const position = new Vector3();
  const matrix = new Matrix();

  function toBlocks(trees: TreePlacement[]): Map<TreeKind, Block> {
    const tally = new Map<TreeKind, number>();
    for (const tree of trees) tally.set(tree.kind, (tally.get(tree.kind) ?? 0) + 1);

    const blocks = new Map<TreeKind, Block>();
    const filled = new Map<TreeKind, number>();
    for (const [kind, total] of tally) {
      blocks.set(kind, { count: total, matrices: new Float32Array(total * 16), colours: new Float32Array(total * 4) });
      filled.set(kind, 0);
    }

    for (const tree of trees) {
      const block = blocks.get(tree.kind)!;
      const at = filled.get(tree.kind)!;
      filled.set(tree.kind, at + 1);

      scaling.set(tree.scale, tree.scale, tree.scale);
      Quaternion.RotationYawPitchRollToRef(tree.rotation, 0, 0, rotation);
      position.set(tree.x, tree.y, tree.z);
      Matrix.ComposeToRef(scaling, rotation, position, matrix);
      matrix.copyToArray(block.matrices, at * 16);

      const { canopyDark, canopyLight } = species.get(tree.kind)!.model;
      block.colours[at * 4] = canopyDark.r + (canopyLight.r - canopyDark.r) * tree.tint;
      block.colours[at * 4 + 1] = canopyDark.g + (canopyLight.g - canopyDark.g) * tree.tint;
      block.colours[at * 4 + 2] = canopyDark.b + (canopyLight.b - canopyDark.b) * tree.tint;
      block.colours[at * 4 + 3] = 1;
    }
    return blocks;
  }

  /** Returns true if the buffers moved and so have to be handed to the meshes again. */
  function ensureCapacity(entry: Species, needed: number): boolean {
    if (needed <= entry.capacity) return false;
    let next = Math.max(MIN_CAPACITY, entry.capacity);
    while (next < needed) next *= 2;
    entry.capacity = next;
    entry.matrices = new Float32Array(next * 16);
    entry.colours = new Float32Array(next * 4);
    return true;
  }

  function setInstanceBuffer(mesh: Mesh, kind: string, data: Float32Array, stride: number): void {
    // staticBuffer false: the contents are rewritten whenever a chunk comes or goes, and the whole
    // point of holding capacity is to refill this buffer in place rather than build a new one.
    mesh.thinInstanceSetBuffer(kind, data, stride, false);
  }

  function flushSpecies(kind: TreeKind, entry: Species): void {
    let total = 0;
    for (const blocks of chunks.values()) total += (blocks.get(kind) ?? EMPTY).count;
    entry.count = total;

    if (total === 0 && !entry.published) return;

    const moved = ensureCapacity(entry, total);

    let at = 0;
    for (const blocks of chunks.values()) {
      const block = blocks.get(kind);
      if (!block) continue;
      entry.matrices.set(block.matrices, at * 16);
      entry.colours.set(block.colours, at * 4);
      at += block.count;
    }

    const { trunk, canopy } = entry.model;
    if (moved || !entry.published) {
      // The colour buffer goes first: setting a buffer republishes the instance count from its
      // length, so the matrix buffer - which is what actually decides how many trees are drawn -
      // has to be the one that lands last.
      setInstanceBuffer(canopy, "color", entry.colours, 4);
      setInstanceBuffer(canopy, "matrix", entry.matrices, 16);
      setInstanceBuffer(trunk, "matrix", entry.matrices, 16);
      entry.published = true;
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

  function flush(): void {
    if (!dirty) return;
    dirty = false;

    count = 0;
    for (const [kind, entry] of species) {
      flushSpecies(kind, entry);
      count += entry.count;
    }
  }

  return {
    setChunk(key, trees) {
      if (trees.length === 0) {
        if (chunks.delete(key)) dirty = true;
        return;
      }
      chunks.set(key, toBlocks(trees));
      dirty = true;
    },
    clearChunk(key) {
      if (chunks.delete(key)) dirty = true;
    },
    flush,
    setVisible(visible) {
      for (const { model } of species.values()) {
        model.trunk.setEnabled(visible);
        model.canopy.setEnabled(visible);
      }
    },
    get treeCount() {
      return count;
    },
    dispose() {
      chunks.clear();
      for (const { model } of species.values()) {
        model.trunk.dispose();
        model.canopy.dispose();
      }
      species.clear();
    },
  };
}
