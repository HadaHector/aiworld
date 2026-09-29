import type { ColorTuple, PipelineDef } from "../terrain/pipeline/pipelineTypes";
import type { TextureDef } from "./textureGen";
import type { ColorAdjust } from "./colorAdjust";

/** One kind of grass a material grows - see foliage/grassScatter.ts. */
export interface GrassSpec {
  /** A GrassKindDef id. */
  kind: string;
  /** Tufts per square metre where this material has full weight. */
  density: number;
  /** Blade colour, multiplied by the blade texture's own light-to-dark shading. */
  color: ColorTuple;
}

/** A ground surface: its baked texture, how that is recoloured, and what grows on it. */
export interface MaterialDef {
  id: string;
  name: string;
  /**
   * Whose bake this material draws: its own id, or - for a material authored with `textureFrom` -
   * the material it borrows from. The bake is seeded by and cached under this id, and the texture
   * atlas holds one layer per distinct textureId, however many materials draw it.
   */
  textureId: string;
  /** The texture baked under `textureId` - this material's own, or the one it borrows. */
  texture: TextureDef;
  /** How the shader recolours the texture for this material (NO_ADJUST for none). */
  adjust: ColorAdjust;
  /** Set only on an area's variant of the material (see materialBlend.ts): the area's own
   *  recolourings of it - its ground's, then its tints' for this material's family - applied in
   *  order after `adjust`. The grass it grows is recoloured by them too. */
  areaAdjusts?: ColorAdjust[];
  /** Which family of materials this is (e.g. "grassland"), for a biome's `ground.tints`, which
   *  recolour a whole family at once and leave the rest of the ground alone. */
  family?: string;
  /** What grows on this material. A point's grass is every material's specs scaled by that
   *  material's weight there, so blends between materials thin one kind out as the next thickens. */
  grass: GrassSpec[];
  /**
   * How strongly this material clears grass, rather than merely growing none - 0 for most.
   *
   * Not growing any is not enough for a road: layer weights are normalised to sum to 1, and a road
   * cut is where other layers fire too (valley layers, river-bank grass), so even at its centre the
   * road is only some 60-70% of the blend. A clearing material thins everything by strength x its
   * own weight instead: at 2, grass is gone wherever the road is half the blend or more.
   */
  clearsGrass: number;
  /** The close-up pass (see materialLibrary.ts): the texture again, `scale` times smaller, deepening
   *  its light and dark and its bumps by `strength` (0 turns it off). */
  detail: MaterialDetail;
  /** How many times smaller the texture is laid on the ground than the usual 50 m tile - 2 covers
   *  25 m with it, so the same features author at twice the size get twice the texels (a road's
   *  cobbles, sharp up close). The far-off broad pass keeps the world's scale. */
  uvScale: number;
}

export interface MaterialDetail {
  scale: number;
  strength: number;
}

/**
 * A rule tying one material to a weight pipeline. Several layers may name the same material (the
 * two snow layers, say) - the material and the rule that selects it are deliberately separate.
 *
 * `id` also seeds the layer's noise, so two layers with the same pipeline still wobble differently.
 */
export interface MaterialLayer {
  id: string;
  materialId: string;
  weight: PipelineDef;
}
