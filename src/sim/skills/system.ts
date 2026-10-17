import type { Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import "./runs";
import { castingHooks, expireLockouts, fireQueued, interrupt, requestCast, stopCast, unitMoved, type CastOptions, type CastResult } from "./casting";
import { die, revive } from "./combat";
import type { CombatEvent, Reason } from "./events";
import { endMagic, signal, startMagic, stepMagic } from "./magic";
import type { Magic, SkillWorld, Spell, Sys } from "./types";
import { isAlive } from "./unit";

/**
 * The ability system (see ABILITIES.md) as the server uses it: spells given and taken, casts asked
 * for, and one step a server step that runs every magic in every loaded dimension, fires queued
 * casts, keeps threat tables and works out who is in combat. Events it makes are drained by the
 * server and sent to the clients near them.
 */
export interface SkillSystem {
  /** Gives a new entity its template's spells; passives start. */
  adopt(entity: Entity): void;
  grant(entity: Entity, skill: number, level: number, source: string): Spell | null;
  /** Takes away every spell from a source, ending their passives. */
  revoke(entity: Entity, source: string): void;
  cast(entity: Entity, skill: number, target: number, options?: CastOptions): CastResult;
  stopCast(entity: Entity): void;
  setTarget(entity: Entity, target: number): void;
  setAttacking(entity: Entity, on: boolean): void;
  /** Kills a unit outright (debug). */
  kill(entity: Entity): void;
  /** Back from the dead with full health. */
  revive(entity: Entity): void;
  /** Starts a skill's magic on a host directly, as a `cast` action would (debug, the probe). */
  apply(skill: number, caster: Entity, host: Entity, level?: number): Magic | null;
  interrupt(entity: Entity, lockout: number): boolean;
  /** An entity leaves its dimension or the server: what runs on it ends, and it is off every table.
   *  `gone`: it is despawned, so its passives end too. */
  leave(entity: Entity, gone?: boolean): void;
  /** Runs the magics of every unit in these dimensions; bodies have already moved this step. */
  step(dimensions: Iterable<{ id: string; entities: Map<number, Entity> }>): void;
  /** The events made since the last drain. */
  drainEvents(): { event: CombatEvent; dimension: string; x: number; z: number }[];
  /**
   * What items call (ITEMS.md, *Abilities*: `ItemHooks`), by skill id: using an item casts its skill
   * once as a level-1 spell the unit does not keep; equipping gives the skill as a spell from the
   * slot's source (a passive starts at once); unequipping takes away every spell from that source.
   */
  readonly items: {
    use(user: Entity, item: unknown, skill: string): boolean;
    equip(wearer: Entity, item: unknown, skill: string, source: string): void;
    unequip(wearer: Entity, source: string): void;
  };
  readonly sys: Sys;
}

export function createSkillSystem(rules: GameRules, world: SkillWorld): SkillSystem {
  const sys = {
    rules,
    world,
    events: [],
    pointMagics: new Map(),
    nextMagic: 1,
    ticking: false,
    hooks: null as unknown as Sys["hooks"],
  } as Sys & { hooks: Sys["hooks"] };
  sys.hooks = castingHooks(sys);

  function grant(entity: Entity, skill: number, level: number, source: string): Spell | null {
    const combat = entity.combat;
    const def = rules.skills[skill];
    if (!combat || !def || combat.spells.some((s) => s.skill === skill)) return null;
    const spell: Spell = { skill, level, source, ready: 0, passive: null };
    combat.spells.push(spell);
    if (def.passive) spell.passive = startMagic(sys, { skill: def, caster: entity, host: entity, target: null, level, spell });
    return spell;
  }

  function leave(entity: Entity, gone = false): void {
    const combat = entity.combat;
    if (!combat) return;
    for (const magic of [...combat.magics]) if (gone || !magic.skill.passive) endMagic(sys, magic, "left");
    combat.casting = null;
    combat.queued = null;
    combat.attacking = false;
    combat.target = 0;
    combat.threat?.clear();
    for (const dim of [entity.dimension]) for (const other of world.entitiesIn(dim)) other.combat?.threat?.delete(entity.id);
  }

  function step(dimensions: Iterable<{ id: string; entities: Map<number, Entity> }>): void {
    const now = world.time();
    const { forgetAfter } = rules.combat.threat;
    for (const dimension of dimensions) {
      const units = [...dimension.entities.values()].filter((e) => e.combat);
      // Who moved, lockouts, summons whose time is up.
      for (const unit of units) {
        const combat = unit.combat!;
        if (combat.moved) {
          combat.moved = false;
          unitMoved(sys, unit);
        }
        expireLockouts(sys, unit);
        if (combat.expires <= now) {
          leave(unit, true);
          const owner = world.entity(combat.owner);
          if (owner?.combat) owner.combat.summons = owner.combat.summons.filter((id) => id !== unit.id);
          world.despawn(unit);
        }
      }
      // Magics, in the order their hosts and they started.
      for (const unit of units) {
        const combat = unit.combat!;
        if (dimension.entities.get(unit.id) !== unit) continue; // gone this step
        for (const magic of [...combat.magics]) {
          if (magic.ended) continue;
          if (combat.dead && !magic.skill.keepOnDeath) continue; // a dead unit's passives wait
          magic.dimension = unit.dimension;
          lostTarget(magic);
          stepMagic(sys, magic, now);
        }
      }
      for (const magic of [...(sys.pointMagics.get(dimension.id) ?? [])]) stepMagic(sys, magic, now);
      for (const unit of units) fireQueued(sys, unit);

      // Threat: forget the dead, the gone, and those idle too long; then who is in combat.
      const onTables = new Set<number>();
      for (const unit of units) {
        const table = unit.combat!.threat;
        if (!table) continue;
        for (const [id, entry] of table) {
          const other = world.entity(id);
          if (!other || other.dimension !== unit.dimension || !isAlive(other) || now - entry.last > forgetAfter) table.delete(id);
          else onTables.add(id);
        }
      }
      for (const unit of units) {
        const combat = unit.combat!;
        unit.inCombat =
          combat.forceCombat || (combat.threat?.size ?? 0) > 0 || onTables.has(unit.id) || now - combat.lastHostile < rules.combat.combatTimeout;
      }
    }
  }

  /** A channel whose target has died or left hears `targetLost`, and ends if it has no answer. */
  function lostTarget(magic: Magic): void {
    const state = magic.skill.states[magic.state];
    if (state?.bar !== "channel" || !magic.target) return;
    const target = world.entity(magic.target);
    if (target && target.dimension === magic.dimension && isAlive(target)) return;
    if (!signal(sys, magic, "targetLost")) endMagic(sys, magic, "stopped" as Reason);
  }

  return {
    adopt(entity) {
      for (const { skill, level } of entity.template.spells) grant(entity, skill, level, "template");
    },
    grant,
    revoke(entity, source) {
      const combat = entity.combat;
      if (!combat) return;
      for (const spell of combat.spells.filter((s) => s.source === source)) if (spell.passive) endMagic(sys, spell.passive, "left");
      combat.spells = combat.spells.filter((s) => s.source !== source);
    },
    cast: (entity, skill, target, options) => requestCast(sys, entity, skill, target, options),
    stopCast: (entity) => stopCast(sys, entity),
    setTarget(entity, target) {
      if (!entity.combat) return;
      if (entity.combat.target !== target) entity.combat.attacking = false;
      entity.combat.target = target;
    },
    setAttacking(entity, on) {
      if (entity.combat) entity.combat.attacking = on && entity.combat.target !== 0 && !entity.combat.dead;
    },
    kill(entity) {
      if (!entity.combat || entity.combat.dead || !entity.resources) return;
      entity.resources.current[rules.health] = 0;
      die(sys, entity, undefined, null);
    },
    revive: (entity) => revive(sys, entity),
    apply: (skill, caster, host, level = 1) => startMagic(sys, { skill: rules.skills[skill], caster, host, target: host, level }),
    interrupt: (entity, lockout) => interrupt(sys, entity, undefined, lockout),
    leave,
    step,
    drainEvents() {
      return sys.events.splice(0, sys.events.length);
    },
    items: {
      use(user, _item, id) {
        const skill = rules.skillIndex.get(id);
        if (skill === undefined) return false;
        return requestCast(sys, user, skill, user.combat?.target ?? 0, { transient: { level: 1 } }).ok;
      },
      equip(wearer, _item, id, source) {
        const skill = rules.skillIndex.get(id);
        if (skill !== undefined) grant(wearer, skill, 1, source);
      },
      unequip(wearer, source) {
        const combat = wearer.combat;
        if (!combat) return;
        for (const spell of combat.spells.filter((s) => s.source === source)) if (spell.passive) endMagic(sys, spell.passive, "left");
        combat.spells = combat.spells.filter((s) => s.source !== source);
      },
    },
    sys,
  };
}

