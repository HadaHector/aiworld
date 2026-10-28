import type { Entity } from "../entity";
import { HOWS, type How } from "../rules/progressionRules";
import { applyTalents, recount, setLevel, startDiscipline, teach, type ProgressContext } from "./progress";

/**
 * A character's progress as it will be saved (GAMEPLAY.md, *Saved state*; PROGRESSION.md): ids and
 * numbers only, so a save outlives packs being reordered. Points, unlocks and modifiers are not in
 * it - they are worked out again on loading.
 */
export interface SavedProgress {
  origins: Record<string, string>;
  disciplines: Record<string, { level: number; xp: number; banked?: number }>;
  talents: Record<string, Record<string, number>>;
  learned: Record<string, string>;
  knows: string[];
}

export function exportProgress(ctx: ProgressContext, entity: Entity): SavedProgress | null {
  const part = entity.progress;
  if (!part) return null;
  const { rules, game } = ctx;
  const saved: SavedProgress = { origins: {}, disciplines: {}, talents: {}, learned: {}, knows: [...part.knows].sort() };
  for (const [slot, origin] of part.origins) saved.origins[slot] = rules.origins[origin].id;
  for (const [d, p] of part.disciplines) saved.disciplines[rules.disciplines[d].id] = p.banked > 0 ? { level: p.level, xp: p.xp, banked: p.banked } : { level: p.level, xp: p.xp };
  for (const [tree, ranks] of part.talents) {
    const def = rules.trees[tree];
    saved.talents[def.id] = Object.fromEntries([...ranks].map(([node, rank]) => [def.nodes[node].id, rank]));
  }
  for (const [skill, how] of part.learned) if (how !== "talent") saved.learned[game.skills[skill].id] = how;
  return saved;
}

/**
 * Loads a save into a character just made with the same origins (`createProgress`): every discipline
 * to its level, with what those levels unlock, then its talents, then what it learned. Ids the packs
 * no longer have are skipped and returned, never an error that stops a load.
 */
export function importProgress(ctx: ProgressContext, entity: Entity, saved: SavedProgress): string[] {
  const part = entity.progress;
  if (!part) return ["no progress part"];
  const { rules, game } = ctx;
  const skipped: string[] = [];
  for (const [id, p] of Object.entries(saved.disciplines ?? {})) {
    const d = rules.disciplineIndex.get(id);
    if (d === undefined) {
      skipped.push(`discipline ${id}`);
      continue;
    }
    if (!part.disciplines.has(d)) startDiscipline(ctx, entity, d, Math.max(1, p.level));
    else setLevel(ctx, entity, d, p.level);
    const progress = part.disciplines.get(d)!;
    progress.xp = Math.max(0, p.xp ?? 0);
    progress.banked = Math.max(0, p.banked ?? 0);
  }
  for (const [treeId, ranks] of Object.entries(saved.talents ?? {})) {
    const tree = rules.treeIndex.get(treeId);
    if (tree === undefined) {
      skipped.push(`tree ${treeId}`);
      continue;
    }
    const def = rules.trees[tree];
    const map = new Map<number, number>();
    for (const [nodeId, rank] of Object.entries(ranks)) {
      const node = def.nodes.find((n) => n.id === nodeId);
      if (!node) skipped.push(`node ${treeId}.${nodeId}`);
      else map.set(node.index, Math.min(node.ranks, Math.max(0, Math.floor(rank))));
    }
    part.talents.set(tree, map);
  }
  applyTalents(ctx, entity);
  for (const [skillId, how] of Object.entries(saved.learned ?? {})) {
    const skill = game.skillIndex.get(skillId);
    if (skill === undefined || !(HOWS as readonly string[]).includes(how)) skipped.push(`learned ${skillId}`);
    else teach(ctx, entity, skill, how as How);
  }
  for (const knows of saved.knows ?? []) part.knows.add(knows);
  recount(ctx, entity);
  part.events.length = 0;
  part.dirty = true;
  return skipped;
}
