import { attachRun, type LearnData, type XpData } from "../skills/actions";
import { evaluate } from "../skills/magic";
import type { Sys } from "../skills/types";
import { learn } from "./progress";
import type { ProgressionSystem } from "./system";

/**
 * Progression's action kinds (PROGRESSION.md, *Actions*), read by actions.ts and given their effect
 * here, as runs.ts gives core's theirs. A skill system runs them for the progression system bound to
 * it; with none (a server without progression), they do nothing.
 */
const systems = new WeakMap<Sys, ProgressionSystem>();

export function bindProgression(sys: Sys, system: ProgressionSystem): void {
  systems.set(sys, system);
}

attachRun<LearnData>("learn", {
  run(sys, _magic, data, targets) {
    const system = systems.get(sys);
    if (!system) return;
    for (const target of targets) if (target.progress) learn(system.ctx, target, data.skill, "item");
  },
});

attachRun<XpData>("xp", {
  run(sys, magic, data, targets) {
    const system = systems.get(sys);
    const discipline = system?.rules.disciplineIndex.get(data.discipline);
    if (!system || discipline === undefined) return;
    for (const target of targets) if (target.progress) system.award(target, "skill", evaluate(sys, magic, data.amount, target), discipline);
  },
});
