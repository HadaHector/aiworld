import type { Entity } from "../entity";

/**
 * How a class fights in a duel (B7): a priority list of its skills, each with when it is worth
 * casting, and how it moves - closing to melee, holding at range, or kiting. Skills a character does
 * not know yet are passed over, so one list serves every level. These are the tool's guesses at a
 * sensible player, not rules: a rotation that plays a class badly shows as a class that is weak.
 */

/** What a rule's condition can see. Distances are gaps between the two bodies, in metres. */
export interface PolicyView {
  self: Entity;
  foe: Entity;
  gap: number;
  /** Health shares, 0-1. */
  hp: number;
  foeHp: number;
  /** Whether a magic of this skill id runs on the unit (a buff, a debuff, a DoT). */
  has(unit: Entity, skill: string): boolean;
  /** The foe is casting something with a bar. */
  foeCasting: boolean;
  /** The foe holds a crowd-control flag (stunned, rooted). */
  foeHeld: boolean;
}

export interface PolicyRule {
  skill: string;
  /** Cast at the foe (default) or at oneself. */
  at?: "foe" | "self";
  when?: (v: PolicyView) => boolean;
}

export type Movement =
  /** Into melee and stay there. */
  | { kind: "close" }
  /** Into range of its spells (`at`), then stands, whatever comes at it. */
  | { kind: "hold"; at: number }
  /** Keeps the foe between `near` and `far`: backs off while it is nearer and can come on. */
  | { kind: "kite"; near: number; far: number };

export interface ClassPolicy {
  movement: Movement;
  /** How far its main attack reaches: further than this counts as time out of range. */
  reach: number;
  priority: PolicyRule[];
}

const missing = (skill: string, on: "self" | "foe" = "self") => (v: PolicyView) => !v.has(on === "self" ? v.self : v.foe, skill);

export const CLASS_POLICIES: Readonly<Record<string, ClassPolicy>> = {
  warrior: {
    movement: { kind: "close" },
    reach: 5,
    priority: [
      { skill: "charge", when: (v) => v.gap > 8 },
      { skill: "battleShout", at: "self", when: missing("battleShouted") },
      { skill: "shieldWall", at: "self", when: (v) => v.hp < 0.4 },
      { skill: "kick", when: (v) => v.foeCasting },
      { skill: "mortalStrike" },
      { skill: "thunderClap", when: (v) => v.gap < 5 && !v.has(v.foe, "thunderClapSlow") },
      { skill: "heroicStrike" },
    ],
  },
  ranger: {
    movement: { kind: "kite", near: 10, far: 28 },
    reach: 30,
    priority: [
      { skill: "hawkEye", at: "self", when: missing("hawkEye") },
      { skill: "disengage", when: (v) => v.gap < 4 },
      { skill: "entanglingShot", when: (v) => v.gap < 10 && !v.foeHeld },
      { skill: "concussiveShot", when: (v) => v.gap < 20 && !v.has(v.foe, "dazed") },
      { skill: "rapidFire" },
      { skill: "poisonArrow", when: missing("poison", "foe") },
      { skill: "steadyShot" },
    ],
  },
  mage: {
    movement: { kind: "hold", at: 28 },
    reach: 30,
    priority: [
      { skill: "arcaneIntellect", at: "self", when: missing("arcaneIntellect") },
      { skill: "frostNova", when: (v) => v.gap < 5 },
      { skill: "searingTotem", at: "self", when: (v) => v.gap < 20 },
      { skill: "fireBlast", when: (v) => v.has(v.foe, "burn") },
      { skill: "frostbolt", when: (v) => !v.has(v.foe, "chilled") },
      { skill: "fireball" },
    ],
  },
  priest: {
    movement: { kind: "hold", at: 28 },
    reach: 30,
    priority: [
      { skill: "fortitude", at: "self", when: missing("fortitude") },
      { skill: "shield", at: "self", when: (v) => v.hp < 0.9 && !v.has(v.self, "shield") && !v.has(v.self, "weakenedSoul") },
      { skill: "heal", at: "self", when: (v) => v.hp < 0.45 },
      { skill: "renew", at: "self", when: (v) => v.hp < 0.8 && !v.has(v.self, "renew") },
      { skill: "holyNova", when: (v) => v.gap < 4 },
      { skill: "holyFire", when: missing("holyFire", "foe") },
      { skill: "smite" },
    ],
  },
};

/** A class the tool has no policy for fights as its template's distance says, with its skills in the order it knows them. */
export function policyFor(classId: string, distance: string, skills: readonly string[]): ClassPolicy {
  const known = CLASS_POLICIES[classId];
  if (known) return known;
  const movement: Movement = distance === "closes" ? { kind: "close" } : distance === "kites" ? { kind: "kite", near: 10, far: 28 } : { kind: "hold", at: 28 };
  return { movement, reach: movement.kind === "close" ? 5 : 30, priority: skills.filter((s) => s !== "autoAttack").map((skill) => ({ skill })) };
}
