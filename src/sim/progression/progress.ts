import type { Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import { unlockAt, type DisciplineDef, type How, type ProgressionRules, type UnlockDef, type UnlockModifier } from "../rules/progressionRules";
import { addModifier, removeSource, setBase, statValues } from "../stats";
import { addResource } from "../resources";

/**
 * A character's progress (see PROGRESSION.md, *The character's progress*): its origins, every
 * discipline's level and XP, its talent ranks, what it has learned and what it may learn. The rest -
 * points left, the modifiers and abilities its levels give - is worked out from these, so loading a
 * save is the same code as levelling up. Pure functions over an entity; the system calls them.
 */
export interface ProgressPart {
  /** Slot id to origin index. */
  origins: Map<string, number>;
  /** By discipline index: only the ones it has. */
  disciplines: Map<number, DisciplineProgress>;
  /** Tree index to node index to rank. */
  talents: Map<number, Map<number, number>>;
  /** Skill index to how it was learned - only what an unlock or a node taught, not a template's. */
  learned: Map<number, How>;
  /** Skills unlocked to be taught (by a trainer or a book), to the unlock that made them so. */
  available: Map<number, UnlockDef>;
  knows: Set<string>;
  /** Worked out: every point pool's total from levels and nodes, and what is left of it. */
  totals: Map<string, number>;
  left: Map<string, number>;
  /** Trees it has: its origins' and its disciplines'. */
  trees: number[];
  /** Skills each slot's origin gives or unlocks - what a `cast` source's `spellSource: "origin:<slot>"` matches. */
  originSkills: Map<string, Set<number>>;
  /** What happened since the system last drained it. */
  events: ProgressEvent[];
  /** Set by any change the owner should be told of. */
  dirty: boolean;
}

export interface DisciplineProgress {
  level: number;
  /** Towards the next level. */
  xp: number;
  /** Earned past the cap with `overflow: "keep"`: spent when the cap rises. */
  banked: number;
}

export const PROGRESS_EVENT_KINDS = ["xp", "levelUp", "learned", "unlocked", "talent", "refused"] as const;
export type ProgressEventKind = (typeof PROGRESS_EVENT_KINDS)[number];

export interface ProgressEvent {
  kind: ProgressEventKind;
  /** Discipline index, -1 for none. */
  discipline: number;
  amount: number;
  level: number;
  /** Skill index, -1 for none. */
  skill: number;
  /** What gave the XP ("kill", "hitTaken"...), a reason for a refusal, a tree's id for a talent. */
  source: string;
}

/** What the progress functions need from the rest of the server: the rules, and the ability
 *  system's grant and revoke (ABILITIES.md, *Spells*). */
export interface ProgressContext {
  game: GameRules;
  rules: ProgressionRules;
  grant(entity: Entity, skill: number, level: number, source: string): void;
  revoke(entity: Entity, source: string): void;
}

/** The modifier and spell source of a discipline's unlocks, and of a tree's nodes. */
export const disciplineSource = (d: DisciplineDef): string => `disc:${d.id}`;
export const treeSource = (rules: ProgressionRules, tree: number): string => `talent:${rules.trees[tree].id}`;
export const learnSource = (how: How): string => `learn:${how}`;

/**
 * A new character's progress, for its origins: every discipline it starts with, at its start level,
 * with everything those levels unlock. The entity's template is already the origins' (PROGRESSION.md,
 * *Origins*), so their stats, spells and resources are in place.
 */
export function createProgress(ctx: ProgressContext, entity: Entity, origins: Map<string, number>): ProgressPart {
  const part: ProgressPart = {
    origins,
    disciplines: new Map(),
    talents: new Map(),
    learned: new Map(),
    available: new Map(),
    knows: new Set(),
    totals: new Map(),
    left: new Map(),
    trees: [],
    originSkills: new Map(),
    events: [],
    dirty: true,
  };
  entity.progress = part;
  const { rules } = ctx;
  for (const [slot, index] of origins) {
    const origin = rules.origins[index];
    const skills = new Set<number>();
    for (const s of Array.isArray(origin.raw.spells) ? origin.raw.spells : []) {
      const id = typeof s === "object" && s !== null ? (s as { skill?: unknown }).skill : s;
      const skill = ctx.game.skillIndex.get(String(id));
      if (skill !== undefined) skills.add(skill);
    }
    for (const list of origin.unlocks.values()) for (const u of list) if (u.skill >= 0) skills.add(u.skill);
    part.originSkills.set(slot, skills);
    for (const tree of origin.trees) if (!part.trees.includes(tree)) part.trees.push(tree);
  }
  // Trees a discipline owns come with the discipline.
  const starts = new Map<number, number>();
  for (const d of rules.disciplines) if (d.start > 0) starts.set(d.index, d.start);
  for (const index of origins.values()) {
    for (const { discipline, level } of rules.origins[index].disciplines) starts.set(discipline, Math.max(starts.get(discipline) ?? 0, level));
  }
  for (const [discipline, level] of [...starts].sort((a, b) => a[0] - b[0])) startDiscipline(ctx, entity, discipline, level);
  recount(ctx, entity);
  // What the starting levels gave is where a character starts, not news.
  part.events.length = 0;
  return part;
}

/** Gives a character a discipline it did not have, at a level, with what every level up to it unlocks. */
export function startDiscipline(ctx: ProgressContext, entity: Entity, discipline: number, level: number): void {
  const part = entity.progress!;
  const existing = part.disciplines.get(discipline);
  if (existing && existing.level >= level) return;
  const from = existing ? existing.level + 1 : 1;
  if (!existing) part.disciplines.set(discipline, { level, xp: 0, banked: 0 });
  else existing.level = level;
  for (const tree of ctx.rules.trees) if (tree.discipline === discipline && !part.trees.includes(tree.index)) part.trees.push(tree.index);
  for (let l = from; l <= level; l++) applyLevel(ctx, entity, discipline, l);
  syncDiscipline(ctx, entity, discipline);
  part.dirty = true;
}

/** Every unlock of a discipline's - its own, and its origins' for it. */
export function unlocksOf(ctx: ProgressContext, part: ProgressPart, discipline: number): UnlockDef[] {
  const list = [...ctx.rules.disciplines[discipline].unlocks];
  for (const index of part.origins.values()) list.push(...(ctx.rules.origins[index].unlocks.get(discipline) ?? []));
  return list;
}

/** What one level of a discipline gives, the moment it is reached. Modifiers are not here: they are
 *  worked out whole for the level (`syncDiscipline`). */
function applyLevel(ctx: ProgressContext, entity: Entity, discipline: number, level: number): void {
  const part = entity.progress!;
  for (const unlock of unlocksOf(ctx, part, discipline)) {
    if (!unlockAt(unlock, level)) continue;
    if (unlock.skill >= 0 && !part.learned.has(unlock.skill)) {
      if (unlock.how === "auto") learnSkill(ctx, entity, unlock.skill, "auto", unlock.spellLevel);
      else if (unlock.how !== "talent" && !part.available.has(unlock.skill)) {
        part.available.set(unlock.skill, unlock);
        part.events.push({ kind: "unlocked", discipline, amount: unlock.cost, level, skill: unlock.skill, source: unlock.how });
      }
    }
    if (unlock.resource >= 0 && entity.stats && entity.resources) addResource(entity.resources, entity.stats, unlock.resource);
    for (const knows of unlock.knows) part.knows.add(knows);
    for (const d of unlock.disciplines) startDiscipline(ctx, entity, d.discipline, d.level);
  }
}

/** Sets a discipline's stat to its level and its unlocks' modifiers to their value at it. */
function syncDiscipline(ctx: ProgressContext, entity: Entity, discipline: number): void {
  const part = entity.progress!;
  const def = ctx.rules.disciplines[discipline];
  const level = part.disciplines.get(discipline)?.level ?? 0;
  if (!entity.stats) return;
  if (def.stat >= 0) setBase(entity.stats, def.stat, level);
  const source = disciplineSource(def);
  removeSource(entity.stats, source);
  const own = [level];
  for (const unlock of unlocksOf(ctx, part, discipline)) {
    // An entry's modifiers hold from the first level it applies at.
    const first = unlock.at ? Math.min(...unlock.at) : unlock.from;
    if (level < first) continue;
    for (const m of unlock.modifiers) addModifier(entity.stats, { stat: m.stat, kind: m.kind, value: m.value.run(own), source });
  }
}

/** The values a discipline's `cap` and `next` read. */
function disciplineValues(ctx: ProgressContext, entity: Entity, def: DisciplineDef, level: number): Float64Array {
  const scope = ctx.rules.disciplineScope;
  const values = new Float64Array(scope.size);
  if (entity.stats) values.set(statValues(entity.stats), scope.stats);
  values[scope.own] = level;
  for (const [d, p] of entity.progress!.disciplines) values[scope.levels + d] = p.level;
  def.vars.forEach((v, i) => (values[scope.vars + i] = v));
  return values;
}

export function capOf(ctx: ProgressContext, entity: Entity, discipline: number): number {
  const def = ctx.rules.disciplines[discipline];
  const level = entity.progress!.disciplines.get(discipline)?.level ?? 0;
  return Math.max(0, Math.min(Math.floor(def.cap.run(disciplineValues(ctx, entity, def, level))), 1000));
}

export function nextOf(ctx: ProgressContext, entity: Entity, discipline: number): number {
  const def = ctx.rules.disciplines[discipline];
  const level = entity.progress!.disciplines.get(discipline)?.level ?? 0;
  return Math.max(1, def.next.run(disciplineValues(ctx, entity, def, level)));
}

/**
 * Gives XP to one discipline - multiplied by its `rate` stat - and levels it up as often as the XP
 * reaches the next level, up to its cap; past the cap it is lost or banked, as the discipline says.
 * Returns the XP it took. A character without the discipline takes none.
 */
export function addXp(ctx: ProgressContext, entity: Entity, discipline: number, amount: number, source: string): number {
  const part = entity.progress;
  const progress = part?.disciplines.get(discipline);
  if (!part || !progress || !(amount > 0)) return 0;
  const def = ctx.rules.disciplines[discipline];
  if (def.rate >= 0 && entity.stats) amount *= Math.max(0, statValues(entity.stats)[def.rate]);
  if (!(amount > 0)) return 0;
  const taken = gain(ctx, entity, discipline, amount, source);
  if (taken > 0) part.events.push({ kind: "xp", discipline, amount: taken, level: progress.level, skill: -1, source });
  part.dirty = true;
  return taken;
}

function gain(ctx: ProgressContext, entity: Entity, discipline: number, amount: number, source: string): number {
  const part = entity.progress!;
  const progress = part.disciplines.get(discipline)!;
  const def = ctx.rules.disciplines[discipline];
  let left = amount;
  let lost = 0;
  let levelled = false;
  while (left > 0) {
    if (progress.level >= capOf(ctx, entity, discipline)) {
      if (def.overflow === "keep") progress.banked += left;
      else lost = left;
      left = 0;
      break;
    }
    const need = nextOf(ctx, entity, discipline) - progress.xp;
    if (left < need) {
      progress.xp += left;
      left = 0;
      break;
    }
    left -= need;
    progress.xp = 0;
    progress.level++;
    applyLevel(ctx, entity, discipline, progress.level);
    syncDiscipline(ctx, entity, discipline);
    part.events.push({ kind: "levelUp", discipline, amount: 0, level: progress.level, skill: -1, source });
    levelled = true;
  }
  if (levelled) {
    recount(ctx, entity);
    flowBanked(ctx, entity, discipline);
  }
  return amount - lost;
}

/** A cap that follows other levels may have risen: banked XP flows on into its discipline. */
function flowBanked(ctx: ProgressContext, entity: Entity, except: number): void {
  for (const [other, p] of entity.progress!.disciplines) {
    if (p.banked <= 0 || other === except || p.level >= capOf(ctx, entity, other)) continue;
    const banked = p.banked;
    p.banked = 0;
    gain(ctx, entity, other, banked, "banked");
  }
}

/** Sets a discipline to a level outright (debug, and loading a save): what each level between gives. */
export function setLevel(ctx: ProgressContext, entity: Entity, discipline: number, level: number): void {
  const part = entity.progress!;
  const progress = part.disciplines.get(discipline);
  if (!progress) {
    if (level > 0) startDiscipline(ctx, entity, discipline, level);
    recount(ctx, entity);
    return;
  }
  for (let l = progress.level + 1; l <= level; l++) {
    progress.level = l;
    applyLevel(ctx, entity, discipline, l);
    part.events.push({ kind: "levelUp", discipline, amount: 0, level: l, skill: -1, source: "debug" });
  }
  if (level < progress.level) progress.level = Math.max(1, level);
  progress.xp = 0;
  syncDiscipline(ctx, entity, discipline);
  recount(ctx, entity);
  flowBanked(ctx, entity, discipline);
  part.dirty = true;
}

// --- learning ---

/** Grants a skill under its way of learning, and remembers it. */
function learnSkill(ctx: ProgressContext, entity: Entity, skill: number, how: How, level: number): void {
  const part = entity.progress!;
  part.learned.set(skill, how);
  part.available.delete(skill);
  ctx.grant(entity, skill, level, learnSource(how));
  part.events.push({ kind: "learned", discipline: -1, amount: 0, level, skill, source: how });
  part.dirty = true;
}

/** Why a character cannot learn a skill this way, or "" if it can. */
export function whyNotLearn(entity: Entity, skill: number, how: How): string {
  const part = entity.progress;
  if (!part) return "cannot";
  if (part.learned.has(skill) || entity.combat?.spells.some((s) => s.skill === skill)) return "known";
  const unlock = part.available.get(skill);
  if (!unlock || unlock.how !== how) return "notYet";
  return "";
}

/** Learns an available skill this way - a trainer's or a book's. Returns why not, or "". */
export function learn(ctx: ProgressContext, entity: Entity, skill: number, how: How): string {
  const why = whyNotLearn(entity, skill, how);
  if (why) {
    entity.progress?.events.push({ kind: "refused", discipline: -1, amount: 0, level: 0, skill, source: why });
    return why;
  }
  learnSkill(ctx, entity, skill, how, entity.progress!.available.get(skill)!.spellLevel);
  return "";
}

// --- talents and points ---

/** Points spent in a tree. */
export function spentIn(ctx: ProgressContext, part: ProgressPart, tree: number): number {
  const ranks = part.talents.get(tree);
  if (!ranks) return 0;
  let spent = 0;
  for (const [node, rank] of ranks) spent += rank * ctx.rules.trees[tree].nodes[node].cost;
  return spent;
}

/** Works out every pool's points from the levels reached and the nodes taken. */
export function recount(ctx: ProgressContext, entity: Entity): void {
  const part = entity.progress!;
  const totals = new Map<string, number>();
  const add = (list: { pool: string; amount: number }[], times = 1): void => {
    for (const p of list) totals.set(p.pool, (totals.get(p.pool) ?? 0) + p.amount * times);
  };
  for (const [discipline, progress] of part.disciplines) {
    for (const unlock of unlocksOf(ctx, part, discipline)) {
      if (unlock.points.length === 0) continue;
      let times = 0;
      for (let l = 1; l <= progress.level; l++) if (unlockAt(unlock, l)) times++;
      add(unlock.points, times);
    }
  }
  const spent = new Map<string, number>();
  for (const [tree, ranks] of part.talents) {
    const def = ctx.rules.trees[tree];
    for (const [node, rank] of ranks) {
      add(def.nodes[node].points, rank);
      spent.set(def.points, (spent.get(def.points) ?? 0) + rank * def.nodes[node].cost);
    }
  }
  part.totals = totals;
  part.left = new Map(ctx.rules.pools.map((pool) => [pool, (totals.get(pool) ?? 0) - (spent.get(pool) ?? 0)]));
  part.dirty = true;
}

/** Why a talent node cannot be taken one rank further, or "". */
export function whyNotPick(ctx: ProgressContext, entity: Entity, tree: number, node: number): string {
  const part = entity.progress;
  const def = ctx.rules.trees[tree];
  if (!part || !def || !part.trees.includes(tree)) return "noTree";
  const n = def.nodes[node];
  if (!n) return "noNode";
  const ranks = part.talents.get(tree) ?? new Map<number, number>();
  const rank = ranks.get(node) ?? 0;
  if (rank >= n.ranks) return "maxed";
  const tier = def.tiers[n.tier];
  if (spentIn(ctx, part, tree) < tier.requires) return "tierLocked";
  if (tier.level > 0 && (part.disciplines.get(def.discipline)?.level ?? 0) < tier.level) return "level";
  if (rank === 0) {
    let taken = 0;
    for (const [other, r] of ranks) if (r > 0 && def.nodes[other].tier === n.tier) taken++;
    if (taken >= tier.pick) return "picked";
  }
  for (const r of n.requires) if ((ranks.get(r) ?? 0) < def.nodes[r].ranks) return "requires";
  if ((part.left.get(def.points) ?? 0) < n.cost) return "points";
  return "";
}

/** Takes a node one rank further. Returns why not, or "". */
export function pickTalent(ctx: ProgressContext, entity: Entity, tree: number, node: number): string {
  const why = whyNotPick(ctx, entity, tree, node);
  const part = entity.progress;
  if (why) {
    part?.events.push({ kind: "refused", discipline: -1, amount: 0, level: 0, skill: -1, source: why });
    return why;
  }
  let ranks = part!.talents.get(tree);
  if (!ranks) part!.talents.set(tree, (ranks = new Map()));
  const rank = (ranks.get(node) ?? 0) + 1;
  ranks.set(node, rank);
  applyTree(ctx, entity, tree);
  const n = ctx.rules.trees[tree].nodes[node];
  if (n.resource >= 0 && entity.stats && entity.resources) addResource(entity.resources, entity.stats, n.resource);
  recount(ctx, entity);
  part!.events.push({ kind: "talent", discipline: -1, amount: node, level: rank, skill: n.skill, source: ctx.rules.trees[tree].id });
  return "";
}

/** Sets a tree's modifiers and abilities to its ranks: all of them again, under the tree's source. */
function applyTree(ctx: ProgressContext, entity: Entity, tree: number): void {
  const part = entity.progress!;
  const def = ctx.rules.trees[tree];
  const source = treeSource(ctx.rules, tree);
  if (entity.stats) removeSource(entity.stats, source);
  ctx.revoke(entity, source);
  const ranks = part.talents.get(tree);
  if (!ranks) return;
  for (const [node, rank] of [...ranks].sort((a, b) => a[0] - b[0])) {
    if (rank <= 0) continue;
    const n = def.nodes[node];
    if (entity.stats) for (const m of n.modifiers) addModifier(entity.stats, nodeModifier(m, rank, source));
    if (n.skill >= 0) ctx.grant(entity, n.skill, rank, source);
  }
}

const nodeModifier = (m: UnlockModifier, rank: number, source: string) => ({ stat: m.stat, kind: m.kind, value: m.value.run([rank]), source });

/** Takes every rank of a tree back: its points return, its modifiers and abilities go. */
export function resetTree(ctx: ProgressContext, entity: Entity, tree: number): void {
  const part = entity.progress;
  if (!part || !part.talents.has(tree)) return;
  part.talents.delete(tree);
  applyTree(ctx, entity, tree);
  recount(ctx, entity);
  part.events.push({ kind: "talent", discipline: -1, amount: -1, level: 0, skill: -1, source: ctx.rules.trees[tree].id });
}

/** Grants every talent's ranks again - after loading a save. */
export function applyTalents(ctx: ProgressContext, entity: Entity): void {
  for (const tree of entity.progress!.talents.keys()) applyTree(ctx, entity, tree);
  recount(ctx, entity);
}

/** Learns a skill outright under a way of learning, with no unlock needed - loading a save, debug. */
export function teach(ctx: ProgressContext, entity: Entity, skill: number, how: How, level = 1): void {
  if (entity.progress?.learned.has(skill)) return;
  learnSkill(ctx, entity, skill, how, level);
}
