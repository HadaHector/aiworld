import type { Entity } from "../entity";
import { PLAYERS_FACTION, standingBetween } from "../factions";
import type { Relation, SkillMatch } from "../rules/skillRules";
import { createFlagBlock, FLAG, hasFlag } from "./flags";
import type { CombatPart, Magic, Sys } from "./types";

/** A fresh combat part. Templates with `threat: true` keep a table. */
export function createCombatPart(threat: boolean): CombatPart {
  return {
    spells: [],
    gcdUntil: 0,
    categories: new Map(),
    queued: null,
    magics: [],
    flags: createFlagBlock(),
    lockouts: [],
    absorbs: [],
    threat: threat ? new Map() : null,
    target: 0,
    attacking: false,
    owner: 0,
    summons: [],
    casting: null,
    castCounter: 0,
    lastHostile: -Infinity,
    forceCombat: false,
    dead: false,
    killers: [],
    expires: Infinity,
    moved: false,
  };
}

export const isAlive = (unit: Entity): boolean => unit.combat !== undefined && !unit.combat.dead;

/** What a unit stands with: its owner's faction and standing for a summon, else its own. */
function sideOf(sys: Sys, unit: Entity, depth = 0): Entity {
  const owner = unit.combat?.owner ?? 0;
  if (owner && depth < 4) {
    const o = sys.world.entity(owner);
    if (o) return sideOf(sys, o, depth + 1);
  }
  return unit;
}

/** On the players' side: a player, or anything of their faction. */
const isPlayer = (unit: Entity): boolean => (unit.faction ?? unit.template.faction) === PLAYERS_FACTION;

/** How `b`'s side and `a`'s stand to each other, on the factions' scale (NPCS.md, *Factions*). */
export function standingOf(sys: Sys, a: Entity, b: Entity): number {
  const sa = sideOf(sys, a);
  const sb = sideOf(sys, b);
  if (sa === sb) return Infinity;
  return standingBetween(sys.rules.factions, { faction: sa.faction ?? sa.template.faction, standing: sa.standing }, { faction: sb.faction ?? sb.template.faction, standing: sb.standing });
}

/** How `b` stands to `a`: an ally (one side, or standing at the factions' `ally` or above), an
 *  enemy (a player and anything it is not allied with, or standing below `hostile`), or neither
 *  (creatures that leave each other alone). */
export function relation(sys: Sys, a: Entity, b: Entity): "ally" | "enemy" | "none" {
  if (a === b) return "ally";
  const standing = standingOf(sys, a, b);
  if (standing >= sys.rules.factions.ally) return "ally";
  if (standing < sys.rules.factions.hostile) return "enemy";
  return isPlayer(sideOf(sys, a)) || isPlayer(sideOf(sys, b)) ? "enemy" : "none";
}

export function relationIs(sys: Sys, a: Entity, b: Entity, wanted: Relation): boolean {
  if (wanted === "any") return true;
  return relation(sys, a, b) === wanted;
}

/** Whether a hostile unit can see it: stealth hides it from its enemies. */
export const hiddenFrom = (sys: Sys, unit: Entity, viewer: Entity): boolean =>
  hasFlag(unit.combat?.flags, FLAG.stealthed) && relation(sys, viewer, unit) === "enemy";

export const radiusOf = (unit: Entity): number => unit.template.look.radius;

/** Centre to centre, less both radii: how ranges are measured. */
export function gap(a: Entity, b: Entity): number {
  return Math.max(0, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - radiusOf(a) - radiusOf(b));
}

/** Whether `b` is in front of `a`: within 90° either side of its facing. */
export function inFront(a: Entity, b: Entity): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 1e-6) return true;
  return Math.sin(a.facing) * dx + Math.cos(a.facing) * dz >= 0;
}

/** Whether a magic's skill matches: by skill, or by a tag it carries. */
export const matchesSkill = (match: SkillMatch, magic: Magic): boolean =>
  match.skill >= 0 ? magic.skill.index === match.skill : magic.skill.tags.includes(match.tag);

/** Whether any magic hosted on the unit matches any of these. */
export function hasMagic(unit: Entity, matches: readonly SkillMatch[]): boolean {
  const magics = unit.combat?.magics ?? [];
  return matches.some((m) => magics.some((magic) => !magic.ended && matchesSkill(m, magic)));
}
