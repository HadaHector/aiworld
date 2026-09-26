import type { ColorTuple, PipelineDef } from "../terrain/pipeline/pipelineTypes";
import type { TextureDef } from "./textureGen";

/** One kind of grass a material grows - see foliage/grassScatter.ts. */
export interface GrassSpec {
  /** A GrassKindDef id. */
  kind: string;
  /** Tufts per square metre where this material has full weight. */
  density: number;
  /** Blade colour, multiplied by the blade texture's own light-to-dark shading. */
  color: ColorTuple;
}

/** A ground surface: its baked texture, and what grows on it. */
export interface MaterialDef {
  id: string;
  name: string;
  texture: TextureDef;
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
