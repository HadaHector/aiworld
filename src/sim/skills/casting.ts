import type { Entity } from "../entity";
import type { SkillDef, StateDef } from "../rules/skillRules";
import { spend } from "../resources";
import { emit } from "./combat";
import { REASON, type Reason } from "./events";
import { canStart, FLAG } from "./flags";
import { endMagic, evaluate, signal, startMagic } from "./magic";
import type { Magic, Spell, Sys } from "./types";
import { gap, hasMagic, hiddenFrom, inFront, isAlive, relation, relationIs } from "./unit";

/**
 * Casting (see ABILITIES.md, *Casting*): whether a unit may start a spell now, at what, and what
 * happens as the cast goes - the GCD, the queue window, cooldowns and costs at commit, range and
 * sight checked again then, cast bars, moving, interrupts and lockouts.
 */

export interface CastOptions {
  /** A point, for `target: "point"`. */
  point?: { x: number; z: number } | null;
  /** Queue it if the unit is busy and will be free within the queue window. */
  queue?: boolean;
  /** A spell the unit does not keep (an item's use, a `cast` action's `mode: "cast"`). */
  transient?: { level: number };
  depth?: number;
}

export type CastResult = { ok: true; magic: Magic | null } | { ok: false; reason: Reason; queued?: boolean };

const fail = (reason: Reason): CastResult => ({ ok: false, reason });

/** Starts a cast, or says why not (and tells the caster's client so). */
export function requestCast(sys: Sys, unit: Entity, skillIndex: number, targetId: number, options: CastOptions = {}): CastResult {
  const result = tryCast(sys, unit, skillIndex, targetId, options);
  if (!result.ok && !result.queued && !options.transient) {
    emit(sys, "castFailed", { source: unit.id, target: targetId, skill: skillIndex, reason: REASON[result.reason], at: unit });
  }
  return result;
}

function tryCast(sys: Sys, unit: Entity, skillIndex: number, targetId: number, options: CastOptions): CastResult {
  const combat = unit.combat;
  const skill = sys.rules.skills[skillIndex];
  if (!combat || !skill) return fail("unknown");
  let spell: Spell | null = combat.spells.find((s) => s.skill === skillIndex) ?? null;
  if (!spell && options.transient) spell = { skill: skillIndex, level: options.transient.level, source: "", ready: 0, passive: null };
  if (!spell) return fail("unknown");
  if (skill.passive) return fail("passive");
  if (combat.dead) return fail("dead");
  if (!canStart(combat.flags, skill.type, skill.weapon)) return fail("cannot");
  const now = sys.world.time();
  if (combat.lockouts.some((l) => l.until > now && skill.tags.includes(l.tag))) return fail("locked");
  if (skill.requires.length > 0 && !hasMagic(unit, skill.requires)) return fail("requires");
  if (hasMagic(unit, skill.blockedBy)) return fail("blocked");

  // Busy: the GCD, a cast, the spell's own cooldown. Close enough to its end, it waits in the queue.
  const busyUntil = Math.max(skill.gcd === "none" ? 0 : combat.gcdUntil, combat.casting ? combat.casting.stateEnds : 0);
  const coolUntil = Math.max(spell.ready, skill.category ? combat.categories.get(skill.category) ?? 0 : 0);
  if (busyUntil > now || coolUntil > now) {
    const waitUntil = Math.max(busyUntil, coolUntil);
    if (options.queue && waitUntil - now <= sys.rules.combat.queueWindow) {
      combat.queued = { skill: skillIndex, target: targetId, point: options.point ?? null };
      return { ok: false, reason: coolUntil > busyUntil ? "cooldown" : "gcd", queued: true };
    }
    return fail(coolUntil > now ? "cooldown" : combat.casting ? "busy" : "gcd");
  }

  const chosen = chooseTarget(sys, unit, skill, targetId);
  if ("reason" in chosen) return fail(chosen.reason);
  const target = chosen.target;
  if (target) {
    if (skill.targetRequires.length > 0 && !hasMagic(target, skill.targetRequires)) return fail("requires");
    if (hasMagic(target, skill.targetBlockedBy)) return fail("blocked");
    const reach = reachProblem(sys, unit, skill, target, spell, 0);
    if (reach) return fail(reach);
  }
  if (!canPay(sys, unit, skill, spell, target)) return fail("cost");

  // Off it goes.
  combat.castCounter++;
  combat.queued = null;
  if (skill.gcd === "global") combat.gcdUntil = now + sys.rules.combat.gcd;
  else if (skill.gcd === "own" && skill.gcdLength) combat.gcdUntil = now + Math.max(0, skill.gcdLength.run(new Float64Array(skill.scope.size)));
  const host = skill.hostOn === "target" ? target ?? unit : unit;
  const point = options.point ? { x: options.point.x, y: unit.y, z: options.point.z } : undefined;
  const magic = startMagic(sys, { skill, caster: unit, host, target, point, level: spell.level, spell, depth: options.depth });
  return { ok: true, magic };
}

/** Who a cast is aimed at, by the skill's `target`: the one asked for, or the unit's own target. */
function chooseTarget(sys: Sys, unit: Entity, skill: SkillDef, targetId: number): { target: Entity | null } | { reason: Reason } {
  const pick = (id: number): Entity | undefined => {
    const t = id ? sys.world.entity(id) : undefined;
    return t && t.dimension === unit.dimension && t.combat ? t : undefined;
  };
  switch (skill.target) {
    case "self":
      return { target: unit };
    case "none":
    case "point":
      return { target: null };
    case "enemy": {
      const t = pick(targetId || unit.combat!.target);
      if (!t) return { reason: "noTarget" };
      if (!isAlive(t) || relation(sys, unit, t) !== "enemy" || hiddenFrom(sys, t, unit)) return { reason: "badTarget" };
      return { target: t };
    }
    case "ally": {
      const t = pick(targetId || unit.combat!.target);
      // No friendly target: the caster itself, as in WoW.
      if (!t || relation(sys, unit, t) !== "ally") return { target: unit };
      if (!isAlive(t)) return { reason: "badTarget" };
      return { target: t };
    }
  }
}

/** Range, facing and sight, with some leeway when checked again at commit. */
function reachProblem(sys: Sys, unit: Entity, skill: SkillDef, target: Entity, spell: Spell | null, leeway: number): Reason | null {
  if (target === unit) return null;
  const scope = new Float64Array(skill.scope.size);
  scope[0] = spell?.level ?? 1;
  const distance = gap(unit, target);
  if (skill.range && distance > skill.range.run(scope) + leeway) return "range";
  if (skill.minRange && distance < skill.minRange.run(scope) - leeway) return "tooClose";
  if (skill.facing && leeway === 0 && !inFront(unit, target)) return "facing";
  if (skill.los && !sys.world.lineOfSight(unit.dimension, unit, target)) return "sight";
  return null;
}

/** A magic shaped enough to evaluate the cost with: the caster, the target, the spell's level. */
function costProbe(unit: Entity, skill: SkillDef, spell: Spell | null, target: Entity | null): Magic {
  return {
    id: 0, skill, caster: unit.id, host: unit.id, dimension: unit.dimension, x: unit.x, y: unit.y, z: unit.z, target: target?.id ?? 0,
    level: spell?.level ?? 1, state: 0, stateStart: 0, stateEnds: 0, nextTick: 0, stacks: 1, vars: new Float64Array(skill.vars.length),
    groups: [], random: () => 0, held: [], serial: 0, ended: true, committed: false, spell, depth: 0,
  };
}

function canPay(sys: Sys, unit: Entity, skill: SkillDef, spell: Spell | null, target: Entity | null): boolean {
  if (skill.cost.length === 0) return true;
  const probe = costProbe(unit, skill, spell, target);
  return skill.cost.every((c) => (unit.resources?.current[c.resource] ?? 0) >= evaluate(sys, probe, c.amount, target ?? undefined));
}

/** Pays the cost and starts the cooldown: when the magic enters its commit state. False if the
 *  target has gone out of reach or the cost cannot be paid any more. */
function commit(sys: Sys, magic: Magic): boolean {
  magic.committed = true;
  const unit = sys.world.entity(magic.caster);
  const spell = magic.spell;
  if (!unit?.combat || !spell) return true;
  const skill = magic.skill;
  const target = magic.target ? sys.world.entity(magic.target) : undefined;
  if (magic.target && (!target || target.dimension !== unit.dimension || !isAlive(target))) return false;
  if (target) {
    const problem = reachProblem(sys, unit, skill, target, spell, sys.rules.combat.rangeLeeway);
    if (problem) {
      emit(sys, "castFailed", { source: unit.id, target: target.id, skill: skill.index, reason: REASON[problem], at: unit });
      return false;
    }
  }
  if (!canPay(sys, unit, skill, spell, target ?? null)) {
    emit(sys, "castFailed", { source: unit.id, skill: skill.index, reason: REASON.cost, at: unit });
    return false;
  }
  for (const c of skill.cost) {
    const amount = Math.max(0, evaluate(sys, magic, c.amount, target));
    if (unit.resources) spend(unit.resources, c.resource, Math.min(amount, unit.resources.current[c.resource]));
  }
  const now = sys.world.time();
  spell.ready = now + Math.max(0, evaluate(sys, magic, skill.cooldown, target));
  if (skill.category) unit.combat.categories.set(skill.category, spell.ready);
  emit(sys, "castDone", { source: unit.id, target: magic.target, skill: skill.index, at: unit });
  // A blow at an enemy starts the fight in earnest: auto-attack on, facing it.
  if (skill.startsAttack && target && target.id !== unit.id && relationIs(sys, unit, target, "enemy")) startAttack(unit, target);
  return true;
}

/** Auto-attack on against a unit, turned to face it (ABILITIES.md, *As built*). */
export function startAttack(unit: Entity, target: Entity): void {
  if (!unit.combat || unit.combat.dead) return;
  unit.combat.target = target.id;
  unit.combat.attacking = true;
  faceUnit(unit, target);
}

/** Turns a unit to face another where it stands. */
export function faceUnit(unit: Entity, target: Entity): void {
  const facing = Math.atan2(target.x - unit.x, target.z - unit.z);
  if (unit.body) unit.body.face(facing);
  unit.facing = facing;
}

/** The casting hooks magics call (Sys.hooks). */
export function castingHooks(sys: Sys): Sys["hooks"] {
  return {
    onEnter(magic: Magic, state: StateDef) {
      if (magic.committed || !magic.spell || magic.skill.passive) return;
      const commitHere = state.commit || (state.index === magic.skill.start && !magic.skill.states.some((s) => s.commit));
      if (!commitHere) return;
      if (!commit(sys, magic)) endMagic(sys, magic, "stopped");
    },
    onEnd() {},
    commitNow: (magic: Magic) => magic.committed || commit(sys, magic),
  };
}

/** Stops the unit's cast before it commits (Escape). */
export function stopCast(sys: Sys, unit: Entity, reason: Reason = "stopped"): void {
  const magic = unit.combat?.casting;
  if (!magic || magic.committed) return;
  emit(sys, "castStopped", { source: unit.id, target: magic.target, skill: magic.skill.index, reason: REASON[reason], at: unit });
  endMagic(sys, magic, reason);
}

/** The unit moved by its own doing: states that moving breaks hear of it. */
export function unitMoved(sys: Sys, unit: Entity): void {
  for (const magic of [...(unit.combat?.magics ?? [])]) {
    const state = magic.skill.states[magic.state];
    if (!state?.breakOnMove || magic.caster !== unit.id) continue;
    emit(sys, "castStopped", { source: unit.id, target: magic.target, skill: magic.skill.index, reason: REASON.moved, at: unit });
    if (!signal(sys, magic, "moved")) endMagic(sys, magic, "moved");
  }
}

/**
 * Interrupts a unit's cast, if the state it is in can be interrupted (or `force`, for a stun): it
 * moves on as its `on.interrupted` says or ends, and for `lockout` seconds the unit cannot start
 * skills sharing a school (`school.*` tag) with the one it was casting.
 */
export function interrupt(sys: Sys, unit: Entity, by: Entity | undefined, lockout: number, force = false): boolean {
  const magic = unit.combat?.casting;
  if (!magic) return false;
  const state = magic.skill.states[magic.state];
  if (!force && !state.interruptible) return false;
  emit(sys, "interrupted", { source: by?.id ?? 0, target: unit.id, skill: magic.skill.index, amount: lockout, at: unit });
  if (lockout > 0) {
    const until = sys.world.time() + lockout;
    for (const tag of magic.skill.tags) if (tag.startsWith("school.")) unit.combat!.lockouts.push({ tag, until });
  }
  if (!signal(sys, magic, "interrupted")) endMagic(sys, magic, "stopped");
  return true;
}

/** A flag just set: a stun stops any cast, a silence a spell's. */
export function flagRaised(sys: Sys, unit: Entity, flag: number): void {
  const casting = unit.combat?.casting;
  if (!casting) return;
  if (flag === FLAG.stunned || flag === FLAG.dead || (flag === FLAG.silenced && casting.skill.type === "spell") || (flag === FLAG.pacified && casting.skill.type === "physical")) {
    interrupt(sys, unit, undefined, 0, true);
  }
}

/** Fires a unit's queued cast once it is free; drops it once it is stale. */
export function fireQueued(sys: Sys, unit: Entity): void {
  const combat = unit.combat;
  const queued = combat?.queued;
  if (!combat || !queued) return;
  const now = sys.world.time();
  const skill = sys.rules.skills[queued.skill];
  const spell = combat.spells.find((s) => s.skill === queued.skill);
  if (!skill || !spell) {
    combat.queued = null;
    return;
  }
  const busy = Math.max(skill.gcd === "none" ? 0 : combat.gcdUntil, combat.casting ? combat.casting.stateEnds : 0, spell.ready);
  if (busy > now + sys.rules.combat.queueWindow) {
    combat.queued = null;
    return;
  }
  if (busy > now || (combat.casting && !combat.casting.ended)) return;
  combat.queued = null;
  requestCast(sys, unit, queued.skill, queued.target, { point: queued.point });
}

/** Lockouts that have run out are dropped. */
export function expireLockouts(sys: Sys, unit: Entity): void {
  const lockouts = unit.combat?.lockouts;
  if (!lockouts || lockouts.length === 0) return;
  const now = sys.world.time();
  unit.combat!.lockouts = lockouts.filter((l) => l.until > now);
}

