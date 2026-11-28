import type { Entity } from "../entity";
import type { CreatureKind } from "../rules/creatureRules";
import { RUN_SPEED } from "../playerBody";
import { EVENT_KIND, type CombatEvent } from "../skills/events";
import { canMove, FLAG, hasFlag } from "../skills/flags";
import { gap } from "../skills/unit";
import { statValues } from "../stats";
import { createArena, type DuelRules } from "./arena";
import { policyFor, type ClassPolicy, type PolicyView } from "./policies";

/**
 * One duel (B7, DUEL.md): a character of a class against a dummy or a creature, on a line, until one
 * dies or the time is up. The skills, stats, gear, ranks, defence and resources are the game's; the
 * arena stands in for movement, and the foe's side for the brain's combat thoughts (closing, keeping
 * range, its tactics with their opening delay, spacing and crowd-control limits, fleeing).
 */

export interface DuelOptions {
  classId: string;
  level: number;
  /** "dummy" for a training dummy with `dummyRole`'s defence, else a creature kind or species id. */
  foe: string;
  /** The foe's level (the character's by default). */
  foeLevel?: number;
  /** The dummy's role: its armour and defence (default `normal`). */
  dummyRole?: string;
  /** Metres between them at the start: a pull from range (default 30). */
  start?: number;
  /** Seconds before calling it (default 120; a dummy fight is always this long, default 60). */
  limit?: number;
  dt?: number;
  seed?: number;
}

export interface SideStats {
  /** Health and its maximum at the start. */
  maxHealth: number;
  endHealth: number;
  /** Damage it dealt (to health, and into absorbs), and what it took. */
  dealt: number;
  taken: number;
  healed: number;
  /** Resource spent, by resource id (summed drops, regeneration not netted out). */
  spent: Record<string, number>;
  /** Casts that went off, by skill id. */
  casts: Record<string, number>;
}

export interface DuelResult {
  classId: string;
  level: number;
  foe: string;
  foeKind: string;
  foeLevel: number;
  foeRole: string;
  seconds: number;
  /** "player", "foe", or "time" when the clock ran out. */
  winner: "player" | "foe" | "time";
  player: SideStats;
  enemy: SideStats;
  /** Seconds the foe stood beyond the character's main reach. */
  outOfRange: number;
  /** Seconds the character was moving (closing or kiting) rather than standing. */
  moving: number;
}

/** The game's rules a duel needs: the server's, read from the packs. */
export type { DuelRules } from "./arena";

/** Creature tactics' thought spacing, melee gap and flee pace: the brain's own constants (creatures/brain.ts). */
const TACTIC_EVERY = 0.3;
const MELEE_GAP = 1.5;
const FLEE_PACE = 0.5;
const CONTROLLED = [FLAG.stunned, FLAG.rooted, FLAG.silenced, FLAG.pacified, FLAG.disarmed];

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function findKind(rules: DuelRules, id: string): CreatureKind {
  const kind = rules.creatures.kinds.get(id) ?? [...rules.creatures.kinds.values()].find((k) => k.species === id);
  if (!kind) throw new Error(`no creature kind "${id}"`);
  return kind;
}

export function runDuel(rules: DuelRules, options: DuelOptions): DuelResult {
  const { game } = rules;
  const dt = options.dt ?? 1 / 20;
  const dummy = options.foe === "dummy";
  const limit = options.limit ?? (dummy ? 60 : 120);
  const foeLevel = options.foeLevel ?? options.level;
  const arena = createArena(rules, options.seed ?? 1);
  const random = mulberry(options.seed ?? 1);

  const me = arena.character(options.classId, options.level, 0);
  const kind = dummy ? null : findKind(rules, options.foe);
  const foe = kind ? arena.creature(kind, foeLevel, options.start ?? 30) : arena.dummy(foeLevel, options.dummyRole ?? "normal", options.start ?? 30);
  const template = rules.classes.find((c) => c.id === options.classId);
  const policy: ClassPolicy = policyFor(options.classId, template?.distance ?? "holds", me.combat!.spells.map((s) => game.skills[s.skill].id));

  const skillIndex = (id: string) => game.skillIndex.get(id);
  const knows = (unit: Entity, id: string) => {
    const index = skillIndex(id);
    return index !== undefined && unit.combat!.spells.some((s) => s.skill === index);
  };
  const has = (unit: Entity, id: string) => unit.combat!.magics.some((m) => !m.ended && m.skill.id === id);
  const health = game.health;
  const share = (u: Entity) => (u.resources ? u.resources.current[health] / Math.max(1, u.resources.max[health]) : 0);
  const alive = (u: Entity) => !u.combat!.dead && (u.resources?.current[health] ?? 0) > 0;
  const casting = (u: Entity) => u.combat!.casting !== null && !u.combat!.casting.ended;
  const held = (u: Entity) => CONTROLLED.some((f) => hasFlag(u.combat!.flags, f));
  /** A skill that can be started on the move: its first state does not break when its caster moves. */
  const onTheMove = (skill: number) => {
    const def = game.skills[skill];
    const first = def?.states[def.start];
    return !first || !(first.bar !== "" && first.breakOnMove);
  };

  // Each side's owner: a totem's damage is its summoner's.
  const sideOf = (id: number): "player" | "foe" | null => {
    let unit = arena.entities.get(id);
    for (let i = 0; unit && i < 4; i++) {
      if (unit === me) return "player";
      if (unit === foe) return "foe";
      unit = unit.combat?.owner ? arena.entities.get(unit.combat.owner) : undefined;
    }
    return null;
  };
  const blank = (u: Entity): SideStats => ({ maxHealth: u.resources!.max[health], endHealth: 0, dealt: 0, taken: 0, healed: 0, spent: {}, casts: {} });
  const sides = { player: blank(me), foe: blank(foe) };
  const lastResources = new Map<Entity, Float64Array>();
  const snapshot = (u: Entity) => lastResources.set(u, Float64Array.from(u.resources!.current));
  snapshot(me);
  snapshot(foe);

  // Into the fight: both pick the other and swing when they can.
  arena.skills.setTarget(me, foe.id);
  arena.skills.setAttacking(me, true);
  if (!dummy) {
    arena.skills.setTarget(foe, me.id);
    arena.skills.setAttacking(foe, true);
  }
  const tacticReady: number[] = [];
  let nextThought = 0;
  let lastControl = false;
  let controlFreeAt = 0;
  let wasHeld = false;
  let fleeing = 0;
  let fled = false;
  let outOfRange = 0;
  let moving = 0;
  const speedOf = (u: Entity, share: number) => RUN_SPEED * share * (statValues(u.stats!)[game.statIndex.get("speed") ?? -1] ?? 1);

  function move(u: Entity, direction: number, pace: number): boolean {
    if (direction === 0 || arena.pushed(u) || !canMove(u.combat!.flags)) return false;
    u.x += direction * pace * dt;
    u.combat!.moved = true;
    return true;
  }

  function playerThinks(): void {
    const g = gap(me, foe);
    const foeNear = foe.x - me.x;
    const toward = Math.sign(foeNear) || 1;
    // Moving first (a moving caster does not start a cast; a cast in progress keeps it still).
    let dir = 0;
    const m = policy.movement;
    if (!casting(me)) {
      if (m.kind === "close" && g > MELEE_GAP) dir = toward;
      else if (m.kind === "hold" && g > m.at) dir = toward;
      else if (m.kind === "kite") {
        const comingOn = !held(foe) && !dummy;
        if (g < m.near && comingOn) dir = -toward;
        else if (g > m.far) dir = toward;
      }
    }
    const moved = move(me, dir, speedOf(me, 1));
    if (moved) moving += dt;
    me.facing = Math.atan2(foe.x - me.x, 0);
    if (casting(me)) return;
    const view: PolicyView = { self: me, foe, gap: gap(me, foe), hp: share(me), foeHp: share(foe), has, foeCasting: casting(foe), foeHeld: held(foe) };
    for (const rule of policy.priority) {
      if (!knows(me, rule.skill)) continue;
      if (rule.when && !rule.when(view)) continue;
      const index = skillIndex(rule.skill)!;
      // On the move only what can be cast running; a cast with a bar waits until it stands.
      if (moved && !onTheMove(index)) continue;
      const target = rule.at === "self" ? me.id : foe.id;
      if (arena.skills.cast(me, index, target).ok) break;
    }
  }

  function foeThinks(now: number): void {
    if (!kind) return;
    const g = gap(me, foe);
    const toward = Math.sign(me.x - foe.x) || 1;
    // Fleeing at its health share, once a pull.
    if (kind.flee && !fled && share(foe) < kind.flee.at) {
      fled = true;
      fleeing = now + kind.flee.time;
    }
    if (now < fleeing) {
      move(foe, -toward, speedOf(foe, kind.speed.run * FLEE_PACE));
      return;
    }
    let moved = false;
    if (!casting(foe)) {
      const want = kind.keepRange > 0 ? kind.keepRange : MELEE_GAP;
      if (g > want) moved = move(foe, toward, speedOf(foe, kind.speed.run));
    }
    foe.facing = Math.atan2(me.x - foe.x, 0);
    if (now < nextThought || casting(foe)) return;
    nextThought = now + TACTIC_EVERY;
    // Crowd control as the brain allows it: not on a held foe, not again soon after a hold ends.
    const isHeld = held(me);
    if (wasHeld && !isHeld) controlFreeAt = now + rules.creatures.config.control.immunity;
    wasHeld = isHeld;
    const mayControl = !isHeld && now >= controlFreeAt && !hasFlag(me.combat!.flags, FLAG.immune) && !(lastControl && kind.tactics.some((t) => !t.control));
    const scope = tacticScope(foe, me, g);
    for (let i = 0; i < kind.tactics.length; i++) {
      const t = kind.tactics[i];
      if ((tacticReady[i] ?? 0) > now || now < t.after) continue;
      if (t.control && !mayControl) continue;
      if (t.when && t.when.run(scope) === 0) continue;
      if (moved && !onTheMove(t.skill)) continue;
      if (!arena.skills.cast(foe, t.skill, t.at === "self" ? foe.id : me.id).ok) continue;
      lastControl = t.control;
      tacticReady[i] = now + t.every[0] + random() * (t.every[1] - t.every[0]);
      break;
    }
  }

  function tacticScope(self: Entity, other: Entity, distance: number): Float64Array {
    const s = rules.creatures.scope;
    const values = new Float64Array(s.size);
    values.set(statValues(self.stats!), 0);
    values.set(statValues(other.stats!), s.stats);
    values[s.casterHealth] = share(self);
    values[s.targetHealth] = share(other);
    values[s.distance] = distance;
    return values;
  }

  function count(events: CombatEvent[]): void {
    for (const e of events) {
      const from = sideOf(e.source);
      const to = sideOf(e.target);
      if (e.kind === EVENT_KIND.hit && to) {
        const amount = e.amount + e.absorbed;
        (to === "player" ? sides.player : sides.foe).taken += amount;
        if (from && from !== to) (from === "player" ? sides.player : sides.foe).dealt += amount;
      } else if (e.kind === EVENT_KIND.heal && to) {
        (to === "player" ? sides.player : sides.foe).healed += e.amount;
      } else if (e.kind === EVENT_KIND.castDone && from && e.skill >= 0) {
        const casts = (from === "player" ? sides.player : sides.foe).casts;
        const id = game.skills[e.skill].id;
        casts[id] = (casts[id] ?? 0) + 1;
      }
    }
  }

  function spending(u: Entity, side: SideStats): void {
    const before = lastResources.get(u)!;
    for (const r of u.resources!.has) {
      if (r === health) continue;
      const drop = before[r] - u.resources!.current[r];
      if (drop > 1e-9) side.spent[game.resources[r].id] = (side.spent[game.resources[r].id] ?? 0) + drop;
    }
    snapshot(u);
  }

  let winner: DuelResult["winner"] = "time";
  while (arena.now() < limit - 1e-9) {
    const now = arena.now();
    playerThinks();
    foeThinks(now);
    if (gap(me, foe) > policy.reach) outOfRange += dt;
    arena.step(dt);
    count(arena.skills.drainEvents().map((e) => e.event));
    spending(me, sides.player);
    spending(foe, sides.foe);
    if (!alive(me)) {
      winner = "foe";
      break;
    }
    if (!dummy && !alive(foe)) {
      winner = "player";
      break;
    }
  }
  // Maxima at the end: a buff in the fight (Fortitude) raises them.
  sides.player.maxHealth = me.resources!.max[health];
  if (!dummy) sides.foe.maxHealth = foe.resources!.max[health];
  sides.player.endHealth = me.resources!.current[health];
  sides.foe.endHealth = foe.resources!.current[health];
  return {
    classId: options.classId,
    level: options.level,
    foe: options.foe,
    foeKind: kind?.id ?? "dummy",
    foeLevel,
    foeRole: kind?.balance?.role ?? (dummy ? options.dummyRole ?? "normal" : ""),
    seconds: arena.now(),
    winner,
    player: sides.player,
    enemy: sides.foe,
    outOfRange,
    moving,
  };
}
