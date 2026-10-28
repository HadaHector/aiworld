import type { Action } from "../skills/actions";
import { FLAG_NAMES } from "../skills/flags";
import type { CompiledFormula } from "./formula";
import { formulaText } from "./formulaText";
import type { GameRules } from "./gameRules";
import { changeText, skillNames } from "./ruleIndex";
import type { SkillDef } from "./skillRules";

/**
 * A skill in words (the rule book, PROGRESSION.md): what casting it asks and costs, then what each of
 * its states does - read from its actions, so it is right for any skill in any pack. Plain and a
 * little mechanical; a skill's own description, if packs give one later, would go first.
 */
export function describeSkill(game: GameRules, skill: SkillDef): string[] {
  const names = skillNames(game);
  const f = (formula: CompiledFormula | null | undefined): string => (formula ? formulaText(formula.source, names) : "");
  const lines: string[] = [];
  const facts: string[] = [];
  // An effect other skills put on their targets (a burn, a stun) is not cast by anyone itself.
  const appliedBy = game.skills.filter((other) => other !== skill && other.states.some((st) => [...st.enter, ...st.tick, ...st.exit].some((a) => a.kind === "cast" && (a.data as { skill: number }).skill === skill.index)));
  const applied = appliedBy.length > 0 && skill.cost.length === 0 && skill.cooldown.constant === 0;
  if (applied) facts.push(`An effect ${appliedBy.map((s) => s.name).join(" and ")} ${appliedBy.length > 1 ? "apply" : "applies"}`);
  else if (skill.passive) facts.push("Always on while known");
  else if (skill.target !== "none") facts.push(`Cast at ${{ enemy: "an enemy", ally: "an ally", self: "yourself", point: "a spot on the ground" }[skill.target] ?? skill.target}`);
  if (skill.range) facts.push(`range ${f(skill.range)} m`);
  if (skill.cost.length) facts.push(`costs ${skill.cost.map((c) => `${f(c.amount)} ${game.resources[c.resource].name}`).join(" and ")}`);
  if (skill.cooldown.constant !== 0) facts.push(`cooldown ${f(skill.cooldown)} s`);
  const cast = skill.states.find((s) => s.bar === "cast" && s.length.kind === "fixed");
  if (cast && cast.length.kind === "fixed") facts.push(`${f(cast.length.length)} s to cast${cast.breakOnMove ? ", standing still" : ""}`);
  else if (!skill.passive && skill.target !== "self" && skill.cost.length) facts.push("instant");
  if (facts.length) lines.push(`${facts.join(", ")}.`);

  const group = (index: number): string => {
    const g = skill.groups[index];
    if (!g) return "the target";
    if (g.id === "host") return skill.display !== "hidden" || skill.hostOn === "target" ? "whoever has it" : "you";
    if (g.id === "caster") return "you";
    if (g.id === "target") return "the target";
    const who = g.filter.relation === "enemy" ? "enemies" : g.filter.relation === "ally" ? "allies" : "units";
    const max = g.max ? ` (up to ${f(g.max)})` : "";
    switch (g.from.kind) {
      case "area": {
        const area = skill.areas[g.from.area] as { radius?: CompiledFormula } | undefined;
        return `${who} within ${area?.radius ? f(area.radius) : "?"} m${max}`;
      }
      case "threat":
        return "whoever it hates most";
      case "attacking":
        return "what you are attacking";
      default:
        return `${who}${max}`;
    }
  };

  const describe = (actions: readonly Action[]): string[] =>
    actions.flatMap((action): string[] => {
      const d = action.data as Record<string, unknown>;
      const amount = (key = "amount"): string => f(d[key] as CompiledFormula);
      const to = group(action.group);
      switch (action.kind) {
        case "damage":
          return [`deals ${amount()} damage to ${to}`];
        case "heal":
          return [`heals ${to} for ${amount()}`];
        case "resource": {
          const r = game.resources[d.resource as number]?.name ?? "?";
          return [`gives ${to} ${amount()} ${r}`];
        }
        case "modifier":
          return [`${changeText(d as never, game, names)} ${game.stats[d.stat as number]?.name ?? "?"}${d.perStack ? " a stack" : ""} on ${to}`];
        case "flag":
          return [`${to === "you" ? "you are" : `${to} ${to.endsWith("s") ? "are" : "is"}`} ${(d.flags as number[]).map((i) => FLAG_NAMES[i]).join(" and ")}`];
        case "absorb":
          return [`shields ${to}, absorbing ${amount()} damage`];
        case "cast": {
          const other = game.skills[d.skill as number];
          return [`${d.mode === "cast" ? "casts" : "applies"} ${other?.name ?? "?"} on ${to}`];
        }
        case "stacks":
          return [`adds ${amount()} stacks`];
        case "remove":
          return [`removes ${d.skill as number >= 0 ? game.skills[d.skill as number]?.name : d.dispel || d.tag || "effects"} from ${to}`];
        case "interrupt":
          return [`interrupts ${to}'s cast, locking its school out for ${amount("lockout")} s`];
        case "move":
          return [{ dash: "dashes to the target", leap: "leaps", knockback: `knocks ${to} back`, pull: `pulls ${to} in`, teleport: "teleports" }[d.kind as string] ?? "moves"];
        case "summon":
          return [`summons ${game.templates.get(d.template as string)?.name ?? d.template} for ${amount("duration")} s`];
        case "threat":
          return [d.taunt ? `taunts ${to}` : `adds ${amount()} threat`];
        case "learn":
          return [`teaches ${game.skills[d.skill as number]?.name ?? "?"}`];
        case "xp":
          return [`gives ${amount()} ${String(d.discipline)} XP`];
        case "chance": {
          const then = describe(d.then as Action[]);
          return then.length ? [`with a chance of ${amount("p")}: ${then.join(", ")}`] : [];
        }
        case "if": {
          const then = describe(d.then as Action[]);
          return then.length ? [`sometimes: ${then.join(", ")}`] : [];
        }
        default:
          return [];
      }
    });

  for (const state of skill.states) {
    const length = state.length.kind === "fixed" ? f(state.length.length) : state.length.kind === "travel" ? "" : "";
    const parts: string[] = [];
    const enter = describe(state.enter);
    if (enter.length) parts.push(enter.join(", "));
    const hold = describe(state.hold);
    if (hold.length) parts.push(`${hold.join(", ")}${length && length !== "0" ? ` for ${length} s` : state.length.kind === "forever" ? "" : ""}`);
    const tick = describe(state.tick);
    if (tick.length) parts.push(`every ${f(state.period)} s${length && length !== "0" ? ` for ${length} s` : ""}: ${tick.join(", ")}`);
    if (state.length.kind === "travel") parts.unshift(`flies to the target at ${f(state.length.speed)} m/s`);
    if (parts.length) lines.push(`${capital(parts.join("; "))}.`);
  }
  if (skill.stacking.max.constant !== 1 && skill.stacking.add === "stack") lines.push(`Stacks up to ${f(skill.stacking.max)} times.`);
  return lines;
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
