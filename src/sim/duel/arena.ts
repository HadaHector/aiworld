import { createEntity, stepResources, type Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import type { ItemRules } from "../rules/itemRules";
import type { ProgressionRules } from "../rules/progressionRules";
import type { CreatureKind, CreatureRules } from "../rules/creatureRules";
import type { ClassTemplate } from "../rules/classGen";
import { createSkillSystem, type SkillSystem } from "../skills/system";
import type { ForcedMotion } from "../skills/types";
import { createItemSystem, type ItemSystem } from "../items/itemSystem";
import { createProgressionSystem, type ProgressionSystem } from "../progression/system";
import { restore, syncMaxima } from "../resources";
import { addModifier, setBase } from "../stats";

/**
 * The duel tool's arena (SLICE.md 3a, B7; DUEL.md): the real skill, item and progression systems
 * round a world of two fighters on a line. No geometry, no bodies: the only space is where each
 * stands on x, so the gap between them, a cast's range, a charge or a kite come out of the numbers.
 * Everything here is the game's own code; what the arena stands in for is movement (the motor and
 * the brain's steering) and sight (always clear).
 */

/** The rules a duel reads: the server's own, as the packs give them. */
export interface DuelRules {
  game: GameRules;
  items: ItemRules;
  progression: ProgressionRules;
  creatures: CreatureRules;
  classes: readonly ClassTemplate[];
}

/** A push (a charge, a leap back) carried out over its time, as a body would. */
interface Motion {
  vx: number;
  until: number;
  stopAt: { x: number; within: number } | null;
}

export interface Arena {
  readonly rules: DuelRules;
  readonly skills: SkillSystem;
  readonly progression: ProgressionSystem;
  readonly items: ItemSystem;
  readonly entities: Map<number, Entity>;
  now(): number;
  /** A character of a class at a level, with its origins' start kit worn, at full health. */
  character(classId: string, level: number, x: number): Entity;
  /** A creature of a kind at a level, as the spawner makes it (perLevel, then the balance curves). */
  creature(kind: CreatureKind, level: number, x: number): Entity;
  /** A training dummy at a level with a role's defence and health (what `applyCreature` gives that role). */
  dummy(level: number, role: string, x: number): Entity;
  /** One step of the clock: forced motions, then the skill system, then resources. */
  step(dt: number): void;
  /** Whether a unit is under a forced motion (it moves by nothing else while it lasts). */
  pushed(entity: Entity): boolean;
}

const DIMENSION = "duel";

export function createArena(rules: DuelRules, seed = 1): Arena {
  const { game } = rules;
  const entities = new Map<number, Entity>();
  const motions = new Map<number, Motion>();
  let time = 0;
  let tick = 0;
  let nextId = 1;

  const skills = createSkillSystem(game, {
    seed,
    time: () => time,
    tick: () => tick,
    entity: (id) => entities.get(id),
    entitiesIn: () => entities.values(),
    lineOfSight: () => true,
    spawn: (_dimension, template, x, z, facing) => spawn(template, x, z, facing),
    despawn: (entity) => {
      skills.leave(entity, true);
      entities.delete(entity.id);
    },
    push(entity, motion: ForcedMotion) {
      if (motion.to) {
        entity.x = motion.to.x;
        return;
      }
      motions.set(entity.id, { vx: motion.vx, until: time + motion.duration, stopAt: motion.stopAt ? { x: motion.stopAt.x, within: motion.stopAt.within } : null });
    },
  });

  const mainHandSlot = rules.items.slotIndex.get("mainHand");
  const items = createItemSystem(
    game,
    rules.items,
    {
      seed,
      time: () => time,
      entity: (id) => entities.get(id),
      entitiesIn: () => entities.values(),
      spawn: () => undefined,
      despawn: (entity) => void entities.delete(entity.id),
    },
    skills.items,
  );
  const progression = createProgressionSystem(game, rules.progression, skills, {
    entity: (id) => entities.get(id),
    mainHand(entity) {
      const id = mainHandSlot === undefined ? null : entity.belongings?.equipment[mainHandSlot];
      const item = id == null ? undefined : items.store.get(id);
      return item ? rules.items.types[item.type] : null;
    },
    pay: () => true,
  });

  function spawn(template: string, x: number, z = 0, facing = 0): Entity | undefined {
    const def = game.templates.get(template);
    if (!def) return undefined;
    const entity = createEntity(game, def, nextId++, { dimension: DIMENSION, x, y: 0, z, facing });
    entities.set(entity.id, entity);
    skills.adopt(entity);
    return entity;
  }

  /** Health and mana full, a resource that starts empty (rage) as its rules start it. */
  function topUp(entity: Entity): void {
    if (!entity.resources || !entity.stats) return;
    syncMaxima(entity.resources, entity.stats);
    for (const r of entity.resources.has) restore(entity.resources, r, game.resources[r].start * entity.resources.max[r] - entity.resources.current[r]);
  }

  const levelStat = game.statIndex.get("level");
  const adventure = rules.progression.disciplineIndex.get("adventure");

  return {
    rules,
    skills,
    progression,
    items,
    entities,
    now: () => time,
    character(classId, level, x) {
      const { origins, template } = progression.originsFor({ class: classId });
      const chosen = rules.progression.origins[origins.get("class") ?? -1];
      if (!chosen || chosen.id !== classId) throw new Error(`no class "${classId}"`);
      const entity = spawn(template, x);
      if (!entity) throw new Error(`no template "${template}"`);
      items.adopt(entity);
      progression.adopt(entity, origins);
      if (adventure !== undefined && level > 1) progression.debugLevel(entity, adventure, level);
      progression.drain();
      topUp(entity);
      return entity;
    },
    creature(kind, level, x) {
      const entity = spawn(kind.id, x);
      if (!entity) throw new Error(`no template "${kind.id}"`);
      // As the spawner does (creatures/system.ts `make`).
      if (entity.stats) {
        if (levelStat !== undefined) setBase(entity.stats, levelStat, level);
        for (const { stat, value } of kind.perLevel) {
          const base = kind.template.stats.find((s) => s.stat === stat)?.value ?? game.stats[stat].default;
          setBase(entity.stats, stat, base + value * (level - 1));
        }
        if (kind.balance && rules.creatures.balance) rules.creatures.balance.applyCreature(entity.stats, game, kind.balance, level);
      }
      topUp(entity);
      return entity;
    },
    dummy(level, role, x) {
      const entity = spawn("trainingDummy", x);
      if (!entity) throw new Error("no trainingDummy template");
      if (entity.stats && rules.creatures.balance) {
        if (levelStat !== undefined) setBase(entity.stats, levelStat, level);
        rules.creatures.balance.applyCreature(entity.stats, game, { role, scale: { health: 1, damage: 1, armour: 1, money: 1, xp: 1 } }, level);
        // Health without end, so every blow of a long fight counts (it never dies, but at 0 a blow takes nothing).
        const maxHealth = game.statIndex.get("maxHealth");
        if (maxHealth !== undefined) addModifier(entity.stats, { stat: maxHealth, kind: game.kindIndex.get("flat") ?? 0, value: 1e7, source: "duel" });
      }
      topUp(entity);
      return entity;
    },
    step(dt) {
      time += dt;
      tick++;
      for (const [id, m] of motions) {
        const e = entities.get(id);
        if (!e || time > m.until + 1e-9) {
          motions.delete(id);
          continue;
        }
        let next = e.x + m.vx * dt;
        if (m.stopAt) {
          const side = Math.sign(m.vx);
          const limit = m.stopAt.x - side * m.stopAt.within;
          if ((side > 0 && next >= limit) || (side < 0 && next <= limit)) {
            next = side > 0 ? Math.max(e.x, limit) : Math.min(e.x, limit);
            motions.delete(id);
          }
        }
        e.x = next;
        if (e.combat) e.combat.moved = true;
      }
      skills.step([{ id: DIMENSION, entities }]);
      stepResources(entities.values(), dt);
    },
    pushed: (entity) => motions.has(entity.id),
  };
}
