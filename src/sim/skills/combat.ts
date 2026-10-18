import type { Entity } from "../entity";
import type { SkillDef } from "../rules/skillRules";
import { LOCAL } from "../rules/skillRules";
import { restore } from "../resources";
import { statValues } from "../stats";
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
  markHostile(sys, source, target);

  let amount = Math.max(0, base);
  let flags = periodic;
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

  const health = sys.rules.health;
  const before = target.resources.current[health];
  restore(target.resources, health, -amount);
  const dealt = before - target.resources.current[health];
  const overkill = amount - dealt;
  addThreat(sys, target, source, (dealt + absorbed) * sys.rules.combat.threat.damage * options.threat);
  emit(sys, "hit", { ...common, amount: dealt, extra: overkill, absorbed, flags });

  if (source) {
    trigger(sys, source, "hitDealt", skill);
    if (flags & EVENT_FLAG.crit) trigger(sys, source, "critDealt", skill);
  }
  trigger(sys, target, "hitTaken", skill);
  if (target.resources.current[health] <= 0 && target.template.mortal && !combat.dead) die(sys, target, source, skill);
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
