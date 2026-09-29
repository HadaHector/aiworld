import { Constants, Matrix, Quaternion, RawTexture, ShaderMaterial, Vector3, type Mesh } from "@babylonjs/core";
import type { CascadedShadowGenerator, Scene } from "@babylonjs/core";
import type { TreePlacement } from "./treeScatter";
import { surfaceTexture, type TreeKindDef } from "./foliageConfig";
import { createTreeModels, type BakedBark, type TreeModel } from "./treeModels";
import { bakeMaterialTextures } from "../materials/textureBakePool";
import { TEXTURE_RESOLUTION } from "../materials/textureGen";
import type { LitShading } from "../materials/litShading";
import { applyColorMatrix, type ColorMatrix } from "../materials/colorAdjust";
import { TREE_TINT_WIDTH } from "./treeShaders";
import type { TreeShade, TreeTintRule } from "./treeTints";

const IDENTITY: ColorMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function speciesKey(kind: string, variant: number, far: boolean): string {
  return `${kind}#${variant}${far ? "~far" : ""}`;
}

export interface TreeField {
  /** Replaces whatever trees were registered under this key. `level` is the chunk's level of detail
   *  (0 the finest): beyond the first, trees are drawn with their cheaper far model, if they have one. */
  setChunk: (key: string, trees: TreePlacement[], level: number) => void;
  clearChunk: (key: string) => void;
  /** Republishes the instance buffers if anything changed since the last call. Cheap when nothing did. */
  flush: () => void;
  setVisible: (visible: boolean) => void;
  /** How far a kind's widest model reaches from its trunk, and how tall its tallest stands, at
   *  scale 1 - for laying specimens out side by side (the workbench). */
  sizeOf: (kind: string) => { radius: number; height: number };
  readonly treeCount: number;
  dispose: () => void;
}

function meshesOf(model: TreeModel): Mesh[] {
  return model.trunk ? [model.trunk, model.canopy] : [model.canopy];
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
/**
 * Every generated kind's bark and every boulder's stone, by kind id - each a texture graph, baked on
 * the same worker pool as the ground materials, all at once. TEXTURE_RESOLUTION² RGBA each. A stone
 * drawn from a material is baked under the material's id, so it is that material's own texture.
 */
export async function bakeBarks(treeKinds: TreeKindDef[], seed: number): Promise<Map<string, BakedBark>> {
  const barkKinds = treeKinds.filter((def) => surfaceTexture(def) !== null);
  const layer = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4;
  const barkColors = new Uint8Array(layer * barkKinds.length);
  const barkNormals = new Uint8Array(layer * barkKinds.length);
  await bakeMaterialTextures(
    barkKinds.map((def) => {
      const surface = surfaceTexture(def)!;
      const material = "material" in surface ? surface.material : undefined;
      return { id: material ?? `${def.shape.model === "boulder" ? "stone" : "bark"}-${def.id}`, texture: surface.texture };
    }),
    seed,
    barkColors,
    barkNormals,
  );
  return new Map<string, BakedBark>(
    barkKinds.map((def, i) => [def.id, { color: barkColors.subarray(i * layer, (i + 1) * layer), normal: barkNormals.subarray(i * layer, (i + 1) * layer) }]),
  );
}

export async function createTreeField(
  scene: Scene,
  shadowGenerator: CascadedShadowGenerator,
  treeKinds: TreeKindDef[],
  seed: number,
  litShading: LitShading,
  /** Barks and leaf atlases already baked for these kinds and this seed, by kind id - the
   *  workbench keeps its bakes. Anything missing is baked here. */
  prebaked?: { barks?: Map<string, BakedBark>; atlases?: Map<string, Uint8Array> },
  /** Each area's tree colour rules, by area id (TreePlacement.area - see treeTints.ts); a tree no
   *  rule is for keeps its kind's own colours. */
  areaTints: readonly (readonly TreeTintRule[])[] = [],
): Promise<TreeField> {
  const missingBark = treeKinds.filter((def) => !prebaked?.barks?.has(def.id));
  const bakedBark = new Map([...(prebaked?.barks ?? []), ...(await bakeBarks(missingBark, seed))]);

  // One "species" per model: a primitive kind has one, a branching kind one per variant, and each is
  // its own pair of master meshes with its own instances.
  const species = new Map<string, Species>();
  const variantCount = new Map<string, number>();
  const models = treeKinds.flatMap((def) => {
    const kindModels = createTreeModels(scene, def, seed, bakedBark.get(def.id), litShading, prebaked?.atlases?.get(def.id));
    variantCount.set(def.id, kindModels.length);
    return kindModels.flatMap((model, variant) => [
      { key: speciesKey(def.id, variant, false), model },
      ...(model.far ? [{ key: speciesKey(def.id, variant, true), model: model.far }] : []),
    ]);
  });
  // Row 0 changes nothing; then every area's every rule's shades, one row each. A tree names its row
  // in its instance colour's alpha.
  const tintRows: TreeShade[] = [{ leaves: IDENTITY, bark: IDENTITY, stone: IDENTITY, snow: 0 }];
  const areaRules = areaTints.map((rules) =>
    rules.map((rule) => {
      const first = tintRows.length;
      tintRows.push(...rule.shades);
      return { kinds: rule.kinds, first, count: rule.shades.length };
    }),
  );
  const tintTable = new Float32Array(tintRows.length * TREE_TINT_WIDTH * 4);
  tintRows.forEach(({ leaves, bark, stone, snow }, row) => {
    [leaves, bark, stone].forEach((m, part) => {
      for (let column = 0; column < 3; column++) tintTable.set([m[column], m[3 + column], m[6 + column], 0], (row * TREE_TINT_WIDTH + part * 3 + column) * 4);
    });
    // The snow rides in the row's first texel's otherwise unused alpha (see treeShaders.ts's treeSnow).
    tintTable[row * TREE_TINT_WIDTH * 4 + 3] = snow;
  });
  const tintTexture = new RawTexture(tintTable, TREE_TINT_WIDTH, tintRows.length, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
  for (const { model } of models) {
    if (!model.shaderTint) continue;
    for (const mesh of meshesOf(model)) {
      if (mesh.material instanceof ShaderMaterial) mesh.material.setTexture("treeTints", tintTexture);
    }
  }
  /** The first of its area's rules for its kind, and the shade its roll picks there. */
  const tintRowOf = (tree: TreePlacement): number => {
    const rules = tree.area !== undefined ? areaRules[tree.area] : undefined;
    const rule = rules?.find((r) => r.kinds === null || r.kinds.includes(tree.kind));
    if (!rule) return 0;
    return rule.first + Math.min(rule.count - 1, Math.floor((tree.shade ?? 0) * rule.count));
  };

  for (const { key: kind, model } of models) {
    // The instances cover every chunk that is loaded, which is a disc centred on the player - so a
    // master mesh is in view whenever anything is, and asking whether its bounding box intersects
    // the frustum can only ever answer yes. Computing that box meant transforming every instance on
    // every chunk event (3.8ms at 6236 trees) to learn nothing.
    const meshes = meshesOf(model);
    for (const mesh of meshes) mesh.alwaysSelectAsActiveMesh = true;
    // Cast once, for the life of the app - unlike terrain, an archetype's master meshes never come
    // or go, only how many instances they hold. Receive too: a primitive tree's StandardMaterial
    // is shadowed by the scene light; a branching tree's shaders do it through the shared lighting.
    for (const mesh of meshes) {
      shadowGenerator.addShadowCaster(mesh);
      mesh.receiveShadows = true;
    }
    // Starts disabled - see flushSpecies's own setEnabled call for why. A species with nothing
    // loaded yet would otherwise render its bare master mesh once, at its own default transform:
    // the world origin, full size, untinted, because the per-instance colour buffer was never
    // bound either. A phantom tree at (0,0,0) for any species the player hadn't walked near yet.
    for (const mesh of meshes) mesh.setEnabled(false);
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
  const chunks = new Map<string, Map<string, Block>>();
  let count = 0;
  let dirty = false;
  // The "Trees" settings-panel toggle and "this species has nothing loaded" are two independent
  // reasons a master mesh should be disabled, tracked separately so neither can undo the other -
  // toggling trees back on must not resurrect a phantom, and a species gaining its first instance
  // must not stay hidden just because the toggle happened to be off at the time.
  let globallyVisible = true;

  const scaling = new Vector3();
  const rotation = new Quaternion();
  const position = new Vector3();
  const matrix = new Matrix();
  const groundNormal = new Vector3();
  const tipped = new Quaternion();

  /** Which of its kind's models a tree is drawn with: hashed from where it stands, so it is the same
   *  tree every time its chunk is built. */
  function keyOf(tree: TreePlacement, far: boolean): string {
    const variants = variantCount.get(tree.kind) ?? 1;
    const hash = (Math.imul(Math.floor(tree.x * 8), 0x27d4eb2d) ^ Math.imul(Math.floor(tree.z * 8), 0x165667b1)) >>> 0;
    const variant = tree.variant !== undefined ? tree.variant % variants : variants === 1 ? 0 : (hash >>> 7) % variants;
    const key = speciesKey(tree.kind, variant, far);
    return species.has(key) ? key : speciesKey(tree.kind, variant, false);
  }

  function toBlocks(trees: TreePlacement[], far: boolean): Map<string, Block> {
    const keys = trees.map((tree) => keyOf(tree, far));
    const tally = new Map<string, number>();
    for (const key of keys) tally.set(key, (tally.get(key) ?? 0) + 1);

    const blocks = new Map<string, Block>();
    const filled = new Map<string, number>();
    for (const [kind, total] of tally) {
      blocks.set(kind, { count: total, matrices: new Float32Array(total * 16), colours: new Float32Array(total * 4) });
      filled.set(kind, 0);
    }

    trees.forEach((tree, index) => {
      const key = keys[index];
      const block = blocks.get(key)!;
      const at = filled.get(key)!;
      filled.set(key, at + 1);

      scaling.set(tree.scale, tree.scale, tree.scale);
      Quaternion.RotationYawPitchRollToRef(tree.rotation, 0, 0, rotation);
      if (tree.lean) {
        // Spun about its own up first, then tipped so that up is the ground's normal.
        groundNormal.set(-tree.lean[0], 1, -tree.lean[1]).normalize();
        Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, groundNormal, tipped);
        tipped.multiplyToRef(rotation, rotation);
      }
      position.set(tree.x, tree.y, tree.z);
      Matrix.ComposeToRef(scaling, rotation, position, matrix);
      matrix.copyToArray(block.matrices, at * 16);

      const { tintDark, tintLight, shaderTint } = species.get(key)!.model;
      let colour: [number, number, number] = [
        tintDark.r + (tintLight.r - tintDark.r) * tree.tint,
        tintDark.g + (tintLight.g - tintDark.g) * tree.tint,
        tintDark.b + (tintLight.b - tintDark.b) * tree.tint,
      ];
      const row = tintRowOf(tree);
      // A primitive canopy is its instance colour and nothing else, so its area's matrix is applied
      // here; every other kind's shaders apply it to the finished colour, from the row in alpha.
      if (!shaderTint && row > 0) colour = applyColorMatrix(tintRows[row].leaves, colour);
      block.colours.set(colour, at * 4);
      block.colours[at * 4 + 3] = shaderTint ? row : 1;
    });
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

  function flushSpecies(kind: string, entry: Species): void {
    let total = 0;
    for (const blocks of chunks.values()) total += (blocks.get(kind) ?? EMPTY).count;
    entry.count = total;

    const { trunk, canopy } = entry.model;
    // hasThinInstances - and therefore whether Babylon draws this mesh via its thin-instance path
    // at all, rather than as a single ordinary mesh at its own base transform - is defined as
    // "thinInstanceCount > 0" (see Mesh.hasThinInstances), not "thinInstanceSetBuffer was ever
    // called". A species with zero trees loaded is therefore NOT "using thin instances" by
    // Babylon's own definition, whatever buffers it was handed earlier, and falls back to
    // rendering its master mesh plainly - the phantom this now avoids outright by disabling the
    // mesh instead of trying to make an empty instance buffer do that job.
    trunk?.setEnabled(globallyVisible && total > 0);
    canopy.setEnabled(globallyVisible && total > 0);
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

    if (moved || !entry.published) {
      // The colour buffer goes first: setting a buffer republishes the instance count from its
      // length, so the matrix buffer - which is what actually decides how many trees are drawn -
      // has to be the one that lands last.
      setInstanceBuffer(canopy, "color", entry.colours, 4);
      setInstanceBuffer(canopy, "matrix", entry.matrices, 16);
      // A generated trunk reads its area's row from the same colours; a primitive one is not tinted.
      if (trunk && entry.model.shaderTint) setInstanceBuffer(trunk, "color", entry.colours, 4);
      if (trunk) setInstanceBuffer(trunk, "matrix", entry.matrices, 16);
      entry.published = true;
      setInstanceCount(entry, total);
    } else {
      // The count before the upload: updating the matrix buffer sends only as many matrices as the
      // mesh's count says it holds. Stated after, a species that gained trees - a chunk's trees
      // moving between the near and far models - drew its new ones from matrices the GPU had never
      // been sent, and they vanished until the next chunk event happened to upload them.
      setInstanceCount(entry, total);
      canopy.thinInstanceBufferUpdated("color");
      canopy.thinInstanceBufferUpdated("matrix");
      if (trunk && entry.model.shaderTint) trunk.thinInstanceBufferUpdated("color");
      trunk?.thinInstanceBufferUpdated("matrix");
    }
  }

  /** Held capacity means the buffers are longer than the number of trees in them, so the count
   *  has to be stated rather than inferred from their length. */
  function setInstanceCount(entry: Species, total: number): void {
    entry.model.canopy.thinInstanceCount = total;
    if (entry.model.trunk) entry.model.trunk.thinInstanceCount = total;
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
    setChunk(key, trees, level) {
      if (trees.length === 0) {
        if (chunks.delete(key)) dirty = true;
        return;
      }
      chunks.set(key, toBlocks(trees, level > 0));
      dirty = true;
    },
    clearChunk(key) {
      if (chunks.delete(key)) dirty = true;
    },
    flush,
    setVisible(visible) {
      globallyVisible = visible;
      // Never enables a species with nothing loaded - see flushSpecies's own setEnabled call for
      // why that mesh has to stay disabled regardless of this toggle.
      for (const entry of species.values()) {
        for (const mesh of meshesOf(entry.model)) mesh.setEnabled(visible && entry.count > 0);
      }
    },
    sizeOf(kind) {
      let radius = 0;
      let height = 0;
      for (const [key, entry] of species) {
        if (!key.startsWith(`${kind}#`)) continue;
        // From the vertices, not the bounding box: a canopy's box is left generous on purpose, for
        // the wind to sway it about in (see treeModels.ts).
        for (const mesh of meshesOf(entry.model)) {
          const positions = mesh.getVerticesData("position") ?? [];
          for (let i = 0; i < positions.length; i += 3) {
            radius = Math.max(radius, Math.hypot(positions[i], positions[i + 2]));
            height = Math.max(height, positions[i + 1]);
          }
        }
      }
      return { radius, height };
    },
    get treeCount() {
      return count;
    },
    dispose() {
      chunks.clear();
      tintTexture.dispose();
      for (const { model } of species.values()) {
        for (const mesh of meshesOf(model)) {
          shadowGenerator.removeShadowCaster(mesh);
          mesh.dispose();
        }
      }
      species.clear();
    },
  };
}
