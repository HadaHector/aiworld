/**
 * Combat events (see ABILITIES.md, *Messages*): everything that happens in a fight, as one flat
 * record each - for the HUD and the combat log now, for quests and floating text later. The server
 * makes them; the clients that see the source or the target are told them.
 */
export const COMBAT_EVENT_KINDS = [
  "hit", "miss", "heal", "castStart", "castDone", "castFailed", "castStopped", "interrupted",
  "auraOn", "auraOff", "auraStacks", "dispelled", "death", "summon", "animation", "effect", "resisted", "respawn",
  // A character's discipline went up a level (PROGRESSION.md): `amount` the level, `name` the discipline.
  "levelUp",
] as const;
export type CombatEventKind = (typeof COMBAT_EVENT_KINDS)[number];
export const EVENT_KIND: Readonly<Record<CombatEventKind, number>> = Object.fromEntries(COMBAT_EVENT_KINDS.map((k, i) => [k, i])) as Record<CombatEventKind, number>;

/** Bits of `flags`. */
export const EVENT_FLAG = { crit: 1, periodic: 2, immune: 4 } as const;

/** Why a cast failed or stopped, or why an aura went: `reason`. */
export const REASONS = [
  "", "unknown", "passive", "dead", "cannot", "locked", "requires", "blocked", "gcd", "busy", "cooldown",
  "noTarget", "badTarget", "range", "tooClose", "facing", "sight", "cost", "moved", "stopped", "expired",
  "dispelled", "replaced", "died", "left",
] as const;
export type Reason = (typeof REASONS)[number];
export const REASON: Readonly<Record<Reason, number>> = Object.fromEntries(REASONS.map((r, i) => [r, i])) as Record<Reason, number>;

export interface CombatEvent {
  kind: number;      // u8: COMBAT_EVENT_KINDS
  source: number;    // u32 entity id, 0 for none
  target: number;    // u32 entity id, 0 for none
  skill: number;     // u16 skill index, -1 for none (an i16 on the wire)
  amount: number;    // f64: damage, healing, a cast's length, a stack count
  extra: number;     // f64: overkill, or how much was mitigated
  absorbed: number;  // f64
  flags: number;     // u8: EVENT_FLAG bits
  reason: number;    // u8: REASONS
  name: string;      // short string: an animation's or an effect's name, else ""
  time: number;      // f64: server time
}
