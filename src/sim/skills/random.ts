import { mulberry32 } from "../../world/rng";

/**
 * A magic's own random stream (see ABILITIES.md, *Principles*): seeded from the world seed, the tick
 * the magic started on, its caster, the caster's cast counter and the magic's id, so the same inputs
 * on any machine give the same rolls - and no roll is ever made on a client.
 */
export function magicRandom(worldSeed: number, tick: number, caster: number, counter: number, magic: number): () => number {
  let h = 0x811c9dc5 ^ (worldSeed >>> 0);
  for (const n of [tick, caster, counter, magic]) {
    h = Math.imul(h ^ (n >>> 0), 0x01000193);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  }
  return mulberry32(h >>> 0);
}
