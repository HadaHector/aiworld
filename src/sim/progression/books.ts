import type { ProgressionRules } from "../rules/progressionRules";

/**
 * Who a book can teach (PROGRESSION.md, *Learning*): the origins and disciplines whose unlocks teach a
 * skill `how: "item"`, as "Mage, class level 3" - what a book's tooltip and the message for a refused
 * reading say. Null when no unlock names the skill (a book for nobody).
 */
export function bookRequirement(rules: ProgressionRules, skill: number): string | null {
  const found: string[] = [];
  const at = (u: { at: number[] | null; from: number }): number => u.at?.[0] ?? u.from;
  for (const origin of rules.origins) {
    for (const [discipline, list] of origin.unlocks) {
      for (const u of list) if (u.skill === skill && u.how === "item") found.push(`${origin.name}, ${rules.disciplines[discipline].name.toLowerCase()} level ${at(u)}`);
    }
  }
  for (const d of rules.disciplines) {
    for (const u of d.unlocks) if (u.skill === skill && u.how === "item") found.push(`${d.name} level ${at(u)}`);
  }
  return found.length > 0 ? [...new Set(found)].join(" or ") : null;
}
