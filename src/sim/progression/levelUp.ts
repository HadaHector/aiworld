import type { GameRules } from "../rules/gameRules";
import { unlockAt, type ProgressionRules, type UnlockDef } from "../rules/progressionRules";

/** What reaching a level gave, worked out from the rules alone (PROGRESSION.md): for the message. */
export interface LevelGains {
  /** Stats that rose, flat ones: "Stamina +2". */
  stats: { stat: string; amount: number }[];
  /** Talent points, by how many. */
  points: number;
}

/**
 * What a discipline's level `level` gave over the one before, for a character with these origins:
 * the rise of each flat stat its unlocks' modifiers set (their value at this level less at the last),
 * and the talent points of the unlocks that apply at it. Skills are not here - the events say those.
 */
export function levelGains(game: GameRules, rules: ProgressionRules, origins: readonly number[], discipline: number, level: number): LevelGains {
  const unlocks: UnlockDef[] = [...rules.disciplines[discipline].unlocks];
  for (const index of origins) unlocks.push(...(rules.origins[index]?.unlocks.get(discipline) ?? []));
  const rise = new Map<number, number>();
  let points = 0;
  for (const unlock of unlocks) {
    const first = unlock.at ? Math.min(...unlock.at) : unlock.from;
    if (level >= first) {
      for (const m of unlock.modifiers) {
        if (game.modifierKinds[m.kind]?.id !== "flat") continue;
        const before = level - 1 >= first ? m.value.run([level - 1]) : 0;
        const now = m.value.run([level]);
        if (now !== before) rise.set(m.stat, (rise.get(m.stat) ?? 0) + now - before);
      }
    }
    if (unlockAt(unlock, level)) for (const p of unlock.points) points += p.amount;
  }
  return { stats: [...rise].filter(([, v]) => Math.abs(v) > 1e-9).map(([stat, amount]) => ({ stat: game.stats[stat]?.name ?? "?", amount: Math.round(amount * 100) / 100 })), points };
}
