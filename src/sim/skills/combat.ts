import type { Entity } from "../entity";
import type { SkillDef } from "../rules/skillRules";
import { LOCAL } from "../rules/skillRules";
import { restore } from "../resources";
import { statValue, statValues } from "../stats";
import { defenceValues, type StatReader } from "../rules/defenceRules";
import { EVENT_FLAG, EVENT_KIND, type CombatEventKind } from "./events";
import { FLAG, hasFlag, lowerFlag, raiseFlag } from "./flags";
import { endMagic, signal } from "./magic";
import type { Magic, Sys } from "./types";
import { relation } from "./unit";

/** How deep combat triggers may set each other off within one action (a proc of a proc...). */
const MAX_TRIGGER_DEPTH = 6;
let triggerDepth = 0;

export interface EventFields {
  source?: number;
  target?: number;
  skill?: number;
  amount?: number;
  extra?: number;
  absorbed?: number;
  blocked?: number;
  resisted?: number;
  flags?: number;
  reason?: number;
  name?: string;
  /** Where it happened: who hears of it is decided by the units' places. */
  at?: Entity;
}

/** Records a combat event for the clients near it (ABILITIES.md, *Messages*). */
export function emit(sys: Sys, kind: CombatEventKind, f: EventFields): void {
  const at = f.at ?? sys.world.entity(f.source ?? 0) ?? sys.world.entity(f.target ?? 0);
  sys.events.push({
    event: {
      kind: EVENT_KIND[kind],
      source: f.source ?? 0,
      target: f.target ?? 0,
      skill: f.skill ?? -1,
      amount: f.amount ?? 0,
      extra: f.extra ?? 0,
      absorbed: f.absorbed ?? 0,
      ...(f.blocked ? { blocked: f.blocked } : {}),
      ...(f.resisted ? { resisted: f.resisted } : {}),
      flags: f.flags ?? 0,
      reason: f.reason ?? 0,
      name: f.name ?? "",
      time: sys.world.time(),
    },
    dimension: at?.dimension ?? "",
    x: at?.x ?? 0,
    z: at?.z ?? 0,
  });
}

/** Tells every magic on a unit a combat trigger (ABILITIES.md, *States*). */
export function trigger(sys: Sys, unit: Entity | undefined, event: string, other: SkillDef): void {
  if (!unit?.combat || triggerDepth >= MAX_TRIGGER_DEPTH) return;
  triggerDepth++;
  try {
    for (const magic of [...unit.combat.magics]) signal(sys, magic, event, other);
  } finally {
    triggerDepth--;
  }
}

// --- rolls ---

const rollScratch = new Map<number, Float64Array>();

/** A roll set's expression for an attacker and defender, with `amount`. */
function rollValue(sys: Sys, expr: { run: (v: ArrayLike<number>) => number }, attacker: Entity | undefined, defender: Entity, amount: number): number {
  const scope = sys.rules.combat.scope;
  let v = rollScratch.get(scope.size);
  if (!v) rollScratch.set(scope.size, (v = new Float64Array(scope.size)));
  v.fill(0);
  v[LOCAL.amount] = amount;
  const copy = (unit: Entity | undefined, at: number) => {
    if (unit?.stats) v!.set(statValues(unit.stats), at);
    else for (const s of sys.rules.stats) v![at + s.index] = s.default;
  };
  copy(attacker, scope.caster);
  copy(defender, scope.target);
  copy(defender, scope.host);
  return expr.run(v);
}

/** Which roll set an action uses: its own, or the skill's kind's (`spell` for spells, else `default`). */
function rollSet(sys: Sys, skill: SkillDef, roll: number | null): number {
  if (roll !== null) return roll;
  const id = skill.type === "spell" ? "spell" : "default";
  return sys.rules.combat.rollIndex.get(id) ?? -1;
}

const markHostile = (sys: Sys, ...units: (Entity | undefined)[]) => {
  const now = sys.world.time();
  for (const u of units) if (u?.combat) u.combat.lastHostile = now;
};

// --- defence (rules/defenceRules.ts) ---

/** A unit's stats by id, for the defence parts (0 for one it has not). */
function statsOf(sys: Sys, unit: Entity | undefined): StatReader {
  return (id) => {
    const i = sys.rules.statIndex.get(id);
    return i === undefined || !unit?.stats ? 0 : statValue(unit.stats, i);
  };
}
const levelOf = (sys: Sys, unit: Entity | undefined): number => {
  const i = sys.rules.statIndex.get("level");
  return i !== undefined && unit?.stats ? statValue(unit.stats, i) : 1;
};

/** What is left of each unit's ward (the `absorb` part). */
const wards = new WeakMap<Entity, { left: number }>();

/** The flags a hostile spell may raise that crowd-control avoidance can shake off. */
const AVOIDABLE: ReadonlySet<number> = new Set([FLAG.stunned, FLAG.rooted, FLAG.silenced, FLAG.pacified, FLAG.disarmed]);

/**
 * Whether a hostile magic's crowd control fails to take on `target` (the `control` part): rolled on
 * the magic's own random, so a replay rolls the same; a resist event when it does.
 */
export function avoidsControl(sys: Sys, magic: Magic, target: Entity, flag: number): boolean {
  const d = sys.rules.combat.defence;
  if (!d.on.control || !AVOIDABLE.has(flag) || magic.caster === target.id) return false;
  const source = sys.world.entity(magic.caster);
  if (source && relation(sys, source, target) !== "enemy") return false;
  const chance = defenceValues(d, statsOf(sys, target), levelOf(sys, source)).control;
  if (chance <= 0 || magic.random() >= chance) return false;
  emit(sys, "resisted", { source: magic.caster, target: target.id, skill: magic.skill.index, at: target });
  return true;
}

// --- damage and healing ---

export interface HitOptions {
  roll: number | null;
  threat: number;
  periodic: boolean;
}

/**
 * Damage from a magic's caster to a target (ABILITIES.md, *Rolls*): the hit roll, the crit roll,
 * mitigation, absorbs, then health; threat, events and triggers; death at 0.
 */
export function dealDamage(sys: Sys, magic: Magic, target: Entity, base: number, options: HitOptions): void {
  const combat = target.combat;
  if (!combat || combat.dead || !target.resources) return;
  const source = sys.world.entity(magic.caster);
  const skill = magic.skill;
  const common = { source: magic.caster, target: target.id, skill: skill.index, at: target };
  const periodic = options.periodic ? EVENT_FLAG.periodic : 0;
  if (hasFlag(combat.flags, FLAG.immune)) {
    emit(sys, "miss", { ...common, flags: EVENT_FLAG.immune | periodic });
    return;
  }
  // Out of combat until this blow: a ward is whole again.
  const fresh = sys.world.time() - combat.lastHostile >= sys.rules.combat.combatTimeout;
  markHostile(sys, source, target);

  let amount = Math.max(0, base);
  let flags = periodic;
  let blocked = 0;
  let resisted = 0;
  let defence: ReturnType<typeof defenceValues> | null = null;
  const set = rollSet(sys, skill, options.roll);
  if (set >= 0) {
    const rolls = sys.rules.combat.rolls[set];
    if (magic.random() >= rollValue(sys, rolls.hit, source, target, amount)) {
      emit(sys, "miss", { ...common, flags });
      addThreat(sys, target, source, 0);
      return;
    }
    if (magic.random() < rollValue(sys, rolls.crit, source, target, amount)) {
      amount *= rollValue(sys, rolls.critMultiplier, source, target, amount);
      flags |= EVENT_FLAG.crit;
    }
    // The defence (rules/combat.json5, *defence*): a weapon's blow may be dodged or parried (not one
    // over time, not while stunned), blocked by a shield, and is cut by armour; a spell by the
    // target's resistance to its school.
    if (rolls.defence !== "none") {
      defence = defenceValues(sys.rules.combat.defence, statsOf(sys, target), levelOf(sys, source));
      if (rolls.defence === "physical") {
        if (!options.periodic && !hasFlag(combat.flags, FLAG.stunned)) {
          const dodge = defence.dodge;
          const parry = skill.tags.includes("melee") ? defence.parry : 0;
          if (dodge + parry > 0) {
            const r = magic.random();
            if (r < dodge + parry) {
              emit(sys, r < dodge ? "dodge" : "parry", { ...common, flags });
              addThreat(sys, target, source, 0);
              return;
            }
          }
          if (defence.block > 0 && defence.blockValue > 0 && magic.random() < defence.block) {
            blocked = Math.min(amount, defence.blockValue);
            amount -= blocked;
            flags |= EVENT_FLAG.blocked;
          }
        }
        amount *= 1 - defence.armor;
      } else {
        const school = skill.tags.find((t) => t.startsWith("school."))?.slice(7);
        const share = school ? defence.resist(school) : 0;
        if (share > 0) {
          resisted = amount * share;
          amount -= resisted;
          flags |= EVENT_FLAG.resisted;
        }
      }
    }
    amount = Math.max(0, rollValue(sys, rolls.mitigate, source, target, amount));
  }

  // Absorbs, oldest first, those whose tags match the skill's.
  let absorbed = 0;
  for (const shield of [...combat.absorbs]) {
    if (amount <= 0) break;
    if (shield.tags.length > 0 && !shield.tags.some((t) => skill.tags.includes(t))) continue;
    const taken = Math.min(shield.remaining, amount);
    shield.remaining -= taken;
    amount -= taken;
    absorbed += taken;
    if (shield.remaining <= 1e-9) {
      if (!signal(sys, shield.magic, "absorbedOut")) endMagic(sys, shield.magic, "expired");
    }
  }

  // The ward (the `absorb` part), after the shields skills put up.
  if (sys.rules.combat.defence.on.absorb && amount > 0) {
    const most = (defence ?? defenceValues(sys.rules.combat.defence, statsOf(sys, target), levelOf(sys, source))).ward;
    let ward = wards.get(target);
    if (!ward || fresh) wards.set(target, (ward = { left: most }));
    ward.left = Math.min(ward.left, most);
    const taken = Math.min(ward.left, amount);
    ward.left -= taken;
    amount -= taken;
    absorbed += taken;
  }

  const health = sys.rules.health;
  const before = target.resources.current[health];
  restore(target.resources, health, -amount);
  const dealt = before - target.resources.current[health];
  const overkill = amount - dealt;
  addThreat(sys, target, source, (dealt + absorbed) * sys.rules.combat.threat.damage * options.threat);
  emit(sys, "hit", { ...common, amount: dealt, extra: overkill, absorbed, blocked, resisted, flags });

  if (source) {
    trigger(sys, source, "hitDealt", skill);
    if (flags & EVENT_FLAG.crit) trigger(sys, source, "critDealt", skill);
  }
  trigger(sys, target, "hitTaken", skill);
  if (target.resources.current[health] <= 0 && target.template.mortal && !combat.dead) die(sys, target, source, skill);
}

/** Harm from the world itself: health down by `amount`, an event with no source and no skill (a
 *  periodic hit), and death at 0. Absorbs, rolls and threat do not apply (WATER.md, drowning). */
export function hurt(sys: Sys, target: Entity, amount: number, cause = ""): void {
  const combat = target.combat;
  if (!combat || combat.dead || !target.resources || amount <= 0) return;
  if (hasFlag(combat.flags, FLAG.immune)) return;
  const health = sys.rules.health;
  const before = target.resources.current[health];
  restore(target.resources, health, -amount);
  const dealt = before - target.resources.current[health];
  emit(sys, "hit", { source: 0, target: target.id, skill: -1, amount: dealt, flags: EVENT_FLAG.periodic, name: cause, at: target });
  if (target.resources.current[health] <= 0 && target.template.mortal) die(sys, target, undefined, null);
}

/** Healing from a magic's caster: rolled for a crit, never misses; threat split over every table
 *  the healed unit is on. */
export function heal(sys: Sys, magic: Magic, target: Entity, base: number, options: HitOptions): void {
  if (!target.combat || target.combat.dead || !target.resources) return;
  const source = sys.world.entity(magic.caster);
  let amount = Math.max(0, base);
  let flags = options.periodic ? EVENT_FLAG.periodic : 0;
  const set = rollSet(sys, magic.skill, options.roll);
  if (set >= 0) {
    const rolls = sys.rules.combat.rolls[set];
    if (magic.random() < rollValue(sys, rolls.crit, source, target, amount)) {
      amount *= rollValue(sys, rolls.critMultiplier, source, target, amount);
      flags |= EVENT_FLAG.crit;
    }
  }
  const health = sys.rules.health;
  const before = target.resources.current[health];
  restore(target.resources, health, amount);
  const healed = target.resources.current[health] - before;
  emit(sys, "heal", { source: magic.caster, target: target.id, skill: magic.skill.index, amount: healed, extra: amount - healed, flags, at: target });

  // Threat for the healer on every table that has the healed unit on it.
  if (source && healed > 0) {
    const tables = [...sys.world.entitiesIn(target.dimension)].filter((u) => u.combat?.threat?.has(target.id) && relation(sys, u, source) === "enemy");
    for (const holder of tables) addThreat(sys, holder, source, (healed * sys.rules.combat.threat.heal * options.threat) / tables.length);
    if (tables.length > 0) markHostile(sys, source);
  }
  if (source) trigger(sys, source, "healDealt", magic.skill);
  trigger(sys, target, "healTaken", magic.skill);
}

// --- threat ---

/** Adds threat on `holder`'s table for `unit` (its own row: a summon is not its owner). */
export function addThreat(sys: Sys, holder: Entity, unit: Entity | undefined, amount: number): void {
  const table = holder.combat?.threat;
  if (!table || !unit || unit === holder || !unit.combat || unit.combat.dead || relation(sys, holder, unit) !== "enemy") return;
  const entry = table.get(unit.id);
  const now = sys.world.time();
  if (entry) {
    entry.amount += amount;
    entry.last = now;
  } else table.set(unit.id, { amount, last: now });
}

/** Puts a unit on top of a table: the highest there, and one more. */
export function taunt(sys: Sys, holder: Entity, unit: Entity): void {
  const table = holder.combat?.threat;
  if (!table) return;
  let top = 0;
  for (const [id, e] of table) if (id !== unit.id) top = Math.max(top, e.amount);
  addThreat(sys, holder, unit, 0);
  const entry = table.get(unit.id);
  if (entry && entry.amount <= top) entry.amount = top + 1;
}

// --- death ---

/** A unit at 0 health dies: the `dead` flag, its magics ended (but passives and `keepOnDeath`),
 *  off every threat table, its own table cleared. */
export function die(sys: Sys, unit: Entity, killer: Entity | undefined, skill: SkillDef | null): void {
  const combat = unit.combat!;
  combat.dead = true;
  combat.attacking = false;
  combat.queued = null;
  raiseFlag(combat.flags, FLAG.dead);
  combat.killers = [...(combat.threat ?? [])].sort((a, b) => b[1].amount - a[1].amount).map(([id]) => id);
  if (killer && !combat.killers.includes(killer.id)) combat.killers.push(killer.id);
  emit(sys, "death", { source: killer?.id ?? 0, target: unit.id, skill: skill?.index ?? -1, at: unit });
  for (const magic of [...combat.magics]) {
    if (magic.skill.passive || magic.skill.keepOnDeath) continue;
    if (!signal(sys, magic, "hostDied")) endMagic(sys, magic, "died");
  }
  combat.threat?.clear();
  for (const other of sys.world.entitiesIn(unit.dimension)) other.combat?.threat?.delete(unit.id);
  if (skill) {
    trigger(sys, killer, "killed", skill);
    trigger(sys, unit, "died", skill);
  }
}

/** Back from the dead with full health. Where it stands is the caller's business. */
export function revive(sys: Sys, unit: Entity): void {
  const combat = unit.combat;
  if (!combat?.dead || !unit.resources) return;
  combat.dead = false;
  lowerFlag(combat.flags, FLAG.dead);
  for (const r of unit.resources.has) restore(unit.resources, r, sys.rules.resources[r].start * unit.resources.max[r] - unit.resources.current[r]);
  restore(unit.resources, sys.rules.health, unit.resources.max[sys.rules.health]);
  emit(sys, "respawn", { target: unit.id, at: unit });
}
