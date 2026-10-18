import type { Entity } from "./entity";
import type { GameRules } from "./rules/gameRules";
import { explainStat } from "./stats";

const number = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2));

/**
 * An entity as lines of text: where it is, its resources, and every stat with how its value came
 * about - each modifier kind's total and the modifiers under it, with their sources. What
 * `npm run server -- --inspect` prints (see ENTITIES.md).
 */
export function describeEntity(rules: GameRules, entity: Entity): string[] {
  const lines = [`#${entity.id} ${entity.name} (${entity.template.id}${entity.key ? `, ${entity.key}` : ""}) in ${entity.dimension || "transit"} at ${entity.x.toFixed(1)}, ${entity.y.toFixed(1)}, ${entity.z.toFixed(1)}${entity.inCombat ? " · in combat" : ""}`];
  // A creature (CREATURES.md): its kind and point, and what its brain is doing.
  const creature = entity.creature;
  if (creature) {
    const { brain } = creature;
    const home = Math.hypot(entity.x - creature.home.x, entity.z - creature.home.z);
    const pulled = brain.state === "combat" || brain.state === "flee" ? ` · ${number(Math.hypot(entity.x - brain.pulledAt.x, entity.z - brain.pulledAt.z))} m from the pull` : "";
    lines.push(`  creature ${creature.kind.id} level ${creature.level}${creature.kind.traits.length ? ` (${creature.kind.traits.join(", ")})` : ""} · ${creature.point ? `point ${creature.point.key}` : "loose"} · ${brain.state}${brain.state === "evade" && brain.why ? ` (${brain.why})` : ""} · ${number(home)} m from home${pulled}`);
  }
  const { stats, resources } = entity;
  if (!stats || !resources) return lines;
  lines.push(`  ${resources.has.map((r) => `${rules.resources[r].id} ${number(resources.current[r])}/${number(resources.max[r])}`).join(" · ")}`);
  for (const def of rules.stats) {
    const breakdown = explainStat(stats, def.index);
    const steps = breakdown.steps.map((step) => {
      const kind = rules.modifierKinds[step.kind];
      return `${kind.id} ${number(step.total)} [${step.modifiers.map((m) => `${number(m.value)} ${m.source}`).join(", ")}] → ${number(step.after)}`;
    });
    if (steps.length === 0 && !def.formula && breakdown.value === def.default) continue; // nothing to say
    lines.push(`  ${def.id} ${number(breakdown.value)}: base ${number(breakdown.base)}${def.formula ? " (formula)" : ""}${steps.length ? ` · ${steps.join(" · ")}` : ""}`);
  }
  return lines;
}
