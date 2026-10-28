import type { GameRules } from "../rules/gameRules";
import { COMBAT_EVENT_KINDS, EVENT_FLAG, REASONS, type CombatEvent } from "./events";

/**
 * A combat event as a line of a combat log ("Fireball hits Training Dummy for 52 (crit)"), for the
 * client's log, the headless server and the probe. English for now; with localisation these become
 * templates (GAMEPLAY.md, *Interface*). `nameOf` gives a unit's name by id.
 */
export function describeEvent(rules: GameRules, event: CombatEvent, nameOf: (id: number) => string): string {
  const source = event.source ? nameOf(event.source) : "Something";
  const target = event.target ? nameOf(event.target) : "";
  const skill = event.skill >= 0 ? rules.skills[event.skill]?.name ?? `skill ${event.skill}` : "";
  const by = skill ? `${source}'s ${skill}` : source;
  const n = (x: number) => String(Math.round(x));
  const notes: string[] = [];
  if (event.flags & EVENT_FLAG.crit) notes.push("crit");
  if (event.absorbed >= 0.5) notes.push(`${n(event.absorbed)} absorbed`);
  const kind = COMBAT_EVENT_KINDS[event.kind];
  if (event.extra >= 0.5 && kind === "hit") notes.push(`${n(event.extra)} overkill`);
  if (event.extra >= 0.5 && kind === "heal") notes.push(`${n(event.extra)} overheal`);
  const tail = notes.length ? ` (${notes.join(", ")})` : "";
  const reason = REASONS[event.reason] ?? "";
  switch (COMBAT_EVENT_KINDS[event.kind]) {
    case "hit":
      return `${by} hits ${target} for ${n(event.amount)}${tail}`;
    case "miss":
      return event.flags & EVENT_FLAG.immune ? `${by} fails: ${target} is immune` : `${by} misses ${target}`;
    case "heal":
      return `${by} heals ${target} for ${n(event.amount)}${tail}`;
    case "castStart":
      return `${source} begins casting ${skill}${target && event.target !== event.source ? ` at ${target}` : ""}`;
    case "castDone":
      return `${source} casts ${skill}${target && event.target !== event.source ? ` at ${target}` : ""}`;
    case "castFailed":
      return `${skill || "Cast"} failed: ${reason}`;
    case "castStopped":
      return `${source}'s ${skill} stopped${reason ? ` (${reason})` : ""}`;
    case "interrupted":
      return `${source} interrupts ${target}'s ${skill}${event.amount > 0 ? ` (locked out ${n(event.amount)} s)` : ""}`;
    case "auraOn":
      return `${target} gains ${skill}${event.amount > 1 ? ` (${n(event.amount)})` : ""}`;
    case "auraStacks":
      return `${target}'s ${skill} now ${n(event.amount)}`;
    case "auraOff":
      return `${skill} fades from ${target}${reason && reason !== "expired" ? ` (${reason})` : ""}`;
    case "dispelled":
      return `${source} removes ${skill} from ${target}`;
    case "death":
      return event.source ? `${target} is killed by ${source}` : `${target} dies`;
    case "summon":
      return `${source} summons ${target}`;
    case "resisted":
      return `${target} resists ${by}`;
    case "respawn":
      return `${target} comes back to life`;
    case "animation":
      return `${source} ${event.name}s`;
    case "effect":
      return `${event.name} on ${target}`;
    case "levelUp":
      return `${source} reaches ${event.name} level ${n(event.amount)}`;
    default:
      return `event ${event.kind}`;
  }
}
