import type { Entity } from "../entity";
import type { CompiledFormula } from "../rules/formula";
import { LOCAL, type SkillDef, type StateDef } from "../rules/skillRules";
import { removeSource, statValues } from "../stats";
import { actionKind, type Action, type ModifierData } from "./actions";
import { emit } from "./combat";
import { REASON, type Reason } from "./events";
import { magicRandom } from "./random";
import { groupMembers } from "./targeting";
import type { Magic, Spell, Sys } from "./types";
import { gap } from "./unit";

/** Casts nested deeper than this (a skill applying a skill applying...) are dropped. */
const MAX_DEPTH = 8;
/** States a magic may pass through in one step, a guard against two 0-length states in a loop. */
const MAX_HOPS = 32;

// --- expressions ---

const scratch = new Map<number, Float64Array>();

/**
 * Fills the scope a magic's expressions read, for one target (ABILITIES.md, *Attributes in
 * expressions*), drawing a fresh `random`. The array is shared scratch: run what needs it at once.
 */
export function scopeFor(sys: Sys, magic: Magic, target: Entity | undefined, amount = 0): Float64Array {
  const { scope } = magic.skill;
  let values = scratch.get(scope.size);
  if (!values) scratch.set(scope.size, (values = new Float64Array(scope.size)));
  const caster = sys.world.entity(magic.caster);
  const host = magic.host ? sys.world.entity(magic.host) : undefined;
  values[LOCAL.level] = magic.level;
  values[LOCAL.stacks] = magic.stacks;
  values[LOCAL.random] = magic.random();
  values[LOCAL.distance] = caster && target ? gap(caster, target) : 0;
  values[LOCAL.amount] = amount;
  copyStats(sys, values, scope.caster, caster);
  copyStats(sys, values, scope.target, target);
  copyStats(sys, values, scope.host, host);
  values.set(magic.vars, scope.vars);
  return values;
}

/** A unit's attributes into a scope, or every attribute's default for a unit that is not there. */
function copyStats(sys: Sys, values: Float64Array, at: number, unit: Entity | undefined): void {
  if (unit?.stats) values.set(statValues(unit.stats), at);
  else for (const stat of sys.rules.stats) values[at + stat.index] = stat.default;
}

export const evaluate = (sys: Sys, magic: Magic, expr: CompiledFormula, target?: Entity): number => expr.run(scopeFor(sys, magic, target));

// --- starting ---

export interface StartOptions {
  skill: SkillDef;
  caster: Entity;
  /** The unit it lives on; null for one at a point. */
  host: Entity | null;
  target: Entity | null;
  point?: { x: number; y: number; z: number };
  level: number;
  /** Vars a `cast` action set, by index, over the skill's defaults. */
  vars?: { index: number; value: number }[];
  spell?: Spell | null;
  depth?: number;
}

/**
 * Starts a skill's magic - or, when one of its stacking group is already on the host, combines
 * with it as the skill's `stacking` says (ABILITIES.md, *Stacking*). Returns the magic that is now
 * running (the old one when it stacked), or null when nothing started.
 */
export function startMagic(sys: Sys, options: StartOptions): Magic | null {
  const { skill, caster, host } = options;
  const depth = options.depth ?? 0;
  if (depth > MAX_DEPTH) return null;
  const dimension = host?.dimension ?? caster.dimension;
  if (host?.combat?.dead && !skill.keepOnDeath && !skill.passive) return null;

  const fresh = createMagic(sys, options, dimension, depth);
  if (host?.combat) {
    const rule = skill.stacking;
    const same = host.combat.magics.filter((m) => !m.ended && m.skill.stacking.group === rule.group && (rule.per === "host" || m.caster === caster.id));
    const max = Math.max(1, Math.floor(evaluate(sys, fresh, rule.max, host)));
    if (same.length > 0 && rule.add !== "separate") {
      const old = same[0];
      // A cast that meets one already there still costs and cools down.
      if (fresh.spell && !sys.hooks.commitNow(fresh)) return null;
      if (rule.add === "keep") return null;
      if (rule.add === "replace") endMagic(sys, old, "replaced");
      else {
        combine(sys, old, fresh, max);
        return old;
      }
    } else if (rule.add === "separate") {
      for (let i = 0; i <= same.length - max; i++) endMagic(sys, same[i], "replaced");
    }
  }

  if (host?.combat) host.combat.magics.push(fresh);
  else {
    let list = sys.pointMagics.get(dimension);
    if (!list) sys.pointMagics.set(dimension, (list = []));
    list.push(fresh);
  }
  if (skill.display !== "hidden" && host) emit(sys, "auraOn", { source: caster.id, target: host.id, skill: skill.index, amount: 1, at: host });
  const now = sys.world.time();
  enterState(sys, fresh, skill.start, now);
  // Instant states pass at once: a strike is over in the step it was struck.
  if (!fresh.ended && fresh.stateEnds <= now) stepMagic(sys, fresh, now);
  return fresh.ended ? null : fresh;
}

function createMagic(sys: Sys, options: StartOptions, dimension: string, depth: number): Magic {
  const { skill, caster, host, target } = options;
  const id = sys.nextMagic++;
  const at = options.point ?? host ?? caster;
  const magic: Magic = {
    id,
    skill,
    caster: caster.id,
    host: host?.id ?? 0,
    dimension,
    x: at.x,
    y: at.y,
    z: at.z,
    target: target?.id ?? 0,
    level: options.level,
    state: -1,
    stateStart: 0,
    stateEnds: Infinity,
    nextTick: Infinity,
    stacks: 1,
    vars: new Float64Array(skill.vars.length),
    groups: skill.groups.map(() => null),
    random: magicRandom(sys.world.seed, sys.world.tick(), caster.id, caster.combat?.castCounter ?? 0, id),
    held: [],
    serial: 0,
    ended: false,
    committed: false,
    spell: options.spell ?? null,
    depth,
  };
  // Defaults first, each with the caster and host as they are now; then what the caller passed.
  skill.varDefaults.forEach((expr, i) => (magic.vars[i] = evaluate(sys, magic, expr, target ?? host ?? undefined)));
  for (const v of options.vars ?? []) magic.vars[v.index] = v.value;
  return magic;
}

/** A new application meeting one already on the host: stacks, length and values by the rules. */
function combine(sys: Sys, old: Magic, fresh: Magic, max: number): void {
  const rule = old.skill.stacking;
  const before = old.stacks;
  old.stacks = Math.min(max, old.stacks + 1);

  // Values: the newest, the stronger, or the first.
  const strength = (m: Magic): number => (rule.strength ? evaluate(sys, m, rule.strength) : m.vars.reduce((a, b) => a + b, 0));
  const takeNew = rule.value === "newest" || (rule.value === "stronger" && strength(fresh) >= strength(old));
  if (takeNew) {
    old.vars.set(fresh.vars);
    if (rule.per === "host") old.caster = fresh.caster;
  }

  // Length of the state it is in.
  const now = sys.world.time();
  const state = old.skill.states[old.state];
  const length = stateLength(sys, old, state);
  if (Number.isFinite(length)) {
    const left = old.stateEnds - now;
    if (rule.duration === "restart") restartState(old, now, length);
    else if (rule.duration === "longer" && length > left) restartState(old, now, length);
    else if (rule.duration === "extend") {
      const cap = rule.extendCap ? evaluate(sys, old, rule.extendCap) : Infinity;
      old.stateEnds = now + Math.min(left + length, cap);
    }
  }
  if (old.stacks !== before) {
    refreshStackHolds(sys, old);
    const host = sys.world.entity(old.host);
    if (old.skill.display !== "hidden" && host) emit(sys, "auraStacks", { source: old.caster, target: old.host, skill: old.skill.index, amount: old.stacks, at: host });
  } else {
    const host = sys.world.entity(old.host);
    if (old.skill.display !== "hidden" && host) emit(sys, "auraOn", { source: old.caster, target: old.host, skill: old.skill.index, amount: old.stacks, at: host });
  }
}

/** Starts a state's time again, keeping its tick phase from the start (the next tick a period on). */
function restartState(magic: Magic, now: number, length: number): void {
  magic.stateStart = now;
  magic.stateEnds = now + length;
}

/** Changes a magic's stacks by an amount; at 0 it is told `stacksGone`, and ends if nothing takes it. */
export function changeStacks(sys: Sys, magic: Magic, amount: number): void {
  if (magic.ended) return;
  const max = Math.max(1, Math.floor(evaluate(sys, magic, magic.skill.stacking.max)));
  const next = Math.min(max, magic.stacks + Math.trunc(amount));
  if (next === magic.stacks) return;
  magic.stacks = Math.max(0, next);
  if (magic.stacks === 0) {
    if (!signal(sys, magic, "stacksGone")) endMagic(sys, magic, "expired");
    return;
  }
  refreshStackHolds(sys, magic);
  const host = sys.world.entity(magic.host);
  if (magic.skill.display !== "hidden" && host) emit(sys, "auraStacks", { source: magic.caster, target: magic.host, skill: magic.skill.index, amount: magic.stacks, at: host });
}

/** Held modifiers marked `perStack` follow the count: taken off and put back with the new one. */
function refreshStackHolds(sys: Sys, magic: Magic): void {
  const state = magic.skill.states[magic.state];
  if (!state || !state.hold.some((a) => a.kind === "modifier" && (a.data as ModifierData).perStack)) return;
  const kept = magic.held.filter((h) => h.kind !== "modifier");
  for (const h of magic.held) {
    if (h.kind !== "modifier") continue;
    const unit = sys.world.entity(h.target);
    if (unit?.stats) removeSource(unit.stats, sourceOf(magic));
  }
  magic.held = kept;
  for (const action of state.hold) if (action.kind === "modifier") applyHold(sys, magic, action);
}

export const sourceOf = (magic: Magic): string => `magic:${magic.id}`;

// --- states ---

function stateLength(sys: Sys, magic: Magic, state: StateDef): number {
  const target = sys.world.entity(magic.target) ?? sys.world.entity(magic.host);
  switch (state.length.kind) {
    case "forever":
      return Infinity;
    case "fixed":
      return Math.max(0, evaluate(sys, magic, state.length.length, target));
    case "travel": {
      const from = sys.world.entity(magic.host) ?? sys.world.entity(magic.caster);
      const to = sys.world.entity(magic.target);
      const speed = evaluate(sys, magic, state.length.speed, to);
      return from && to && speed > 0 ? gap(from, to) / speed : 0;
    }
  }
}

/** Enters a state at a time (the moment the last one ran out, so ticks and swings do not drift). */
function enterState(sys: Sys, magic: Magic, index: number, at: number): void {
  const state = magic.skill.states[index];
  magic.state = index;
  magic.serial++;
  magic.stateStart = at;
  magic.groups.fill(null);
  const length = stateLength(sys, magic, state);
  magic.stateEnds = at + length;
  magic.nextTick = state.period ? at + Math.max(0.05, evaluate(sys, magic, state.period)) : Infinity;
  const serial = magic.serial;

  if (state.bar) {
    const host = sys.world.entity(magic.host);
    if (host?.combat) {
      host.combat.casting = magic;
      emit(sys, "castStart", { source: magic.caster, target: magic.target, skill: magic.skill.index, amount: length, at: host, flags: state.bar === "channel" ? 1 : 0 });
    }
  }
  sys.hooks.onEnter(magic, state);
  if (magic.ended || magic.serial !== serial) return;
  for (const action of state.hold) applyHold(sys, magic, action);
  runActions(sys, magic, state.enter, serial);
}

/** Leaves the current state for another, or ends the magic (`to` -1). */
export function changeState(sys: Sys, magic: Magic, to: number, at = sys.world.time()): void {
  if (magic.ended) return;
  if (to < 0) {
    endMagic(sys, magic, "expired");
    return;
  }
  leaveState(sys, magic);
  if (!magic.ended) enterState(sys, magic, to, at);
}

function leaveState(sys: Sys, magic: Magic): void {
  const state = magic.skill.states[magic.state];
  if (!state) return;
  const serial = ++magic.serial;
  runActions(sys, magic, state.exit, serial);
  undoHolds(sys, magic);
  if (state.bar) {
    const host = sys.world.entity(magic.host);
    if (host?.combat?.casting === magic) host.combat.casting = null;
  }
}

/** Ends a magic: its state's exit actions, its holds undone, gone from its host. */
export function endMagic(sys: Sys, magic: Magic, reason: Reason): void {
  if (magic.ended) return;
  leaveState(sys, magic);
  magic.ended = true;
  const host = magic.host ? sys.world.entity(magic.host) : undefined;
  if (host?.combat) {
    const i = host.combat.magics.indexOf(magic);
    if (i >= 0) host.combat.magics.splice(i, 1);
    if (host.combat.casting === magic) host.combat.casting = null;
    for (const spell of host.combat.spells) if (spell.passive === magic) spell.passive = null;
  } else {
    const list = sys.pointMagics.get(magic.dimension);
    const i = list?.indexOf(magic) ?? -1;
    if (i >= 0) list!.splice(i, 1);
  }
  if (magic.skill.display !== "hidden" && host) emit(sys, "auraOff", { source: magic.caster, target: host.id, skill: magic.skill.index, at: host, reason: REASON[reason] });
  sys.hooks.onEnd(magic, reason);
}

/**
 * Tells a magic an event (ABILITIES.md, *States*). If its state has a transition for it - matching
 * the other side's skill for combat triggers - it moves on and true is returned.
 */
export function signal(sys: Sys, magic: Magic, event: string, other?: SkillDef): boolean {
  if (magic.ended) return false;
  const state = magic.skill.states[magic.state];
  for (const t of state?.on ?? []) {
    if (t.event !== event) continue;
    if (t.filter.length > 0 && !(other && t.filter.some((f) => (f.skill >= 0 ? f.skill === other.index : other.tags.includes(f.tag))))) continue;
    changeState(sys, magic, t.to);
    return true;
  }
  return false;
}

/** Steps a magic to a time: its ticks, then the states its lengths run out of. */
export function stepMagic(sys: Sys, magic: Magic, now: number): void {
  for (let hops = 0; hops < MAX_HOPS && !magic.ended; hops++) {
    const state = magic.skill.states[magic.state];
    while (!magic.ended && magic.nextTick <= Math.min(now, magic.stateEnds) && state.period) {
      const serial = magic.serial;
      for (const g of state.refill) magic.groups[g] = null;
      sys.ticking = true;
      try {
        runActions(sys, magic, state.tick, serial);
      } finally {
        sys.ticking = false;
      }
      if (magic.serial !== serial) break;
      magic.nextTick += Math.max(0.05, evaluate(sys, magic, state.period));
    }
    if (magic.ended || magic.skill.states[magic.state] !== state) continue;
    if (magic.stateEnds > now) return;
    changeState(sys, magic, state.next, magic.stateEnds);
  }
}

// --- actions ---

/** Runs a list of actions until one moves the magic out of the state they ran in. */
export function runActions(sys: Sys, magic: Magic, actions: readonly Action[], serial: number): void {
  for (const action of actions) {
    if (magic.ended || magic.serial !== serial) return;
    const kind = actionKind(action.kind);
    if (!kind?.run) continue;
    kind.run(sys, magic, action.data, members(sys, magic, action.group));
  }
}

/** A group's members, as entities, filled the first time this state uses it. */
export function members(sys: Sys, magic: Magic, group: number): Entity[] {
  let ids = magic.groups[group];
  if (!ids) magic.groups[group] = ids = groupMembers(sys, magic, group);
  const out: Entity[] = [];
  for (const id of ids) {
    const unit = sys.world.entity(id);
    if (unit && unit.dimension === magic.dimension) out.push(unit);
  }
  return out;
}

function applyHold(sys: Sys, magic: Magic, action: Action): void {
  const kind = actionKind(action.kind);
  if (!kind?.apply) return;
  for (const target of members(sys, magic, action.group)) {
    magic.held.push({ kind: action.kind, data: action.data, target: target.id, record: kind.apply(sys, magic, action.data, target) });
  }
}

function undoHolds(sys: Sys, magic: Magic): void {
  const held = magic.held;
  magic.held = [];
  for (const h of held) {
    const target = sys.world.entity(h.target);
    if (target) actionKind(h.kind)?.undo?.(sys, magic, h.data, target, h.record);
  }
}

