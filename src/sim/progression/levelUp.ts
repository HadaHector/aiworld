import type { GameRules } from "../rules/gameRules";
import { unlockAt, type ProgressionRules, type UnlockDef } from "../rules/progressionRules";
import { autoStatPoints, statPointTotal, statWeightsOf } from "./progress";

/** What reaching a level gave, worked out from the rules alone (PROGRESSION.md; SKILLBANK.md, the
 *  level-up screen): for the message and the screen. */
export interface LevelGains {
  /** Stats that rose, flat ones: "Stamina +2" - the unlocks' modifiers and automatic stat points. */
  stats: { stat: string; amount: number }[];
  /** Talent points, by how many. */
  points: number;
  /** Stat points this level gave: already placed when automatic, to spend when manual. */
  statPoints: number;
  statMode: "auto" | "manual" | "";
  /** Skills it teaches at once, skills a trainer or a book may now teach, and ranks gained. */
  skills: { skill: number; how: string; rank: number }[];
}

/**
 * What a discipline's level `level` gave over the one before, for a character with these origins:
 * the rise of each flat stat its unlocks' modifiers set (their value at this level less at the last),
 * the stat points of the level (where the class's weights put them, when automatic), the talent
 * points of the unlocks that apply at it, and its skills and ranks.
 */
export function levelGains(game: GameRules, rules: ProgressionRules, origins: readonly number[], discipline: number, level: number): LevelGains {
  const unlocks: UnlockDef[] = [...rules.disciplines[discipline].unlocks];
  for (const index of origins) unlocks.push(...(rules.origins[index]?.unlocks.get(discipline) ?? []));
  const rise = new Map<number, number>();
  let points = 0;
  const skills: LevelGains["skills"] = [];
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
    if (unlockAt(unlock, level)) {
      for (const p of unlock.points) points += p.amount;
      if (unlock.skill >= 0) skills.push({ skill: unlock.skill, how: unlock.how, rank: unlock.spellLevel });
    }
  }
  const config = rules.config.statPoints;
  let statPoints = 0;
  if (config && config.discipline === discipline) {
    statPoints = config.at(level);
    if (config.mode === "auto" && statPoints > 0) {
      const weights = statWeightsOf(rules, origins.filter((o) => o >= 0));
      const now = autoStatPoints(weights, statPointTotal(rules, level));
      const before = autoStatPoints(weights, statPointTotal(rules, level - 1));
      for (const [stat, n] of now) if (n !== before.get(stat)) rise.set(stat, (rise.get(stat) ?? 0) + n - (before.get(stat) ?? 0));
    }
  }
  return {
    stats: [...rise].filter(([, v]) => Math.abs(v) > 1e-9).map(([stat, amount]) => ({ stat: game.stats[stat]?.name ?? "?", amount: Math.round(amount * 100) / 100 })),
    points,
    statPoints,
    statMode: config && config.discipline === discipline ? config.mode : "",
    skills,
  };
}
