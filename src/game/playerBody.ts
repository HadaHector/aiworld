import type { Scene } from "@babylonjs/core";
import type { PackSource } from "../world/content/resolveContent";
import { createBodyKit, createCharacterBody, type BodyLook, type CharacterBody } from "./characterBody";
import type { EntityAppearance } from "../sim/protocol";

/**
 * Who the player is, as far as their body goes. Character creation and saves come later (see
 * GAMEPLAY.md), so for the spike it comes from the page's address: `?race=dwarf&outfit=knight&sex=
 * female&look=7` - the look being the character's seed. Sent in Hello, so others see the same body.
 */
export type PlayerLook = BodyLook;

export function lookFromUrl(search = location.search): PlayerLook {
  const params = new URLSearchParams(search);
  const sex = params.get("sex");
  return {
    race: params.get("race") ?? "human",
    outfit: params.get("outfit") ?? "scout",
    sex: sex === "male" || sex === "female" ? sex : undefined,
    seed: Number(params.get("look")) || 7,
  };
}

/** The player's look as Hello carries it. */
export function appearanceOf(look: PlayerLook): EntityAppearance {
  return { seed: look.seed >>> 0, race: look.race, outfit: look.outfit, sex: look.sex ?? "" };
}

/** The player's body (CHARACTERS.md, build step 6): drawn where the server has the player. */
export type PlayerBody = CharacterBody;

/** Builds the player's body from the packs - race, outfit and looks as `look` says - and draws it in
 *  place of the capsule. */
export function createPlayerBody(scene: Scene, packs: PackSource[], look: PlayerLook, worldSeed: number): Promise<PlayerBody> {
  return createCharacterBody(scene, "playerBody", createBodyKit(packs), look, worldSeed);
}
