import type { Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import type { CreatureRules } from "../rules/creatureRules";
import type { SkillSystem } from "../skills/system";
import { addThreat } from "../skills/combat";
import { endMagic } from "../skills/magic";
import { canMove, FLAG, hasFlag } from "../skills/flags";
import { gap, hiddenFrom, isAlive, standingOf } from "../skills/unit";
import { statValues } from "../stats";
import { restore } from "../resources";
import type { NavAgent, NavQuery } from "../../world/nav/navQuery";
import type { Vec3 } from "../../world/collision/vec";
import type { Brain, CreaturePart } from "./creature";

/** What the brain reads of the world around it. */
export interface BrainWorld {
  rules: GameRules;
  creatures: CreatureRules;
  skills: SkillSystem;
  now: number;
  entity(id: number): Entity | undefined;
  /** The players in a dimension standing in it (with a body). */
  playersIn(dimension: string): readonly Entity[];
  lineOfSight(dimension: string, from: Entity, to: Entity): boolean;
  /** The other living members of a creature's group. */
  groupOf(creature: Entity): readonly Entity[];
  /** Whether a creature may stand at a point (for wandering). */
  open(x: number, z: number): boolean;
  /** A number from 0 to 1, from the creature's own stream. */
  random(creature: Entity): number;
  /** How it finds its way (NAVIGATION.md). */
  nav: NavQuery;
}

/** How close a melee creature closes on its target: the gap between capsules it stops at. */
const MELEE_GAP = 1.5;
/** Within this of its goal, a walk has arrived. */
const ARRIVED = 1;
/** Seconds between looks round for players to aggro, and between thoughts of tactics. */
const LOOK_EVERY = 0.25;
const TACTIC_EVERY = 0.3;
/** A fleeing creature runs at this share of its run. */
const FLEE_PACE = 0.5;
/** Threat a creature puts its aggro, or a pulled group-mate's foes, on its table with. */
const AGGRO_THREAT = 1;

/** Within this of a waypoint, it is passed and the next one is headed for. */
const WAYPOINT = 0.75;
/** Getting no nearer to what it heads for for this long, a creature plans (NAVIGATION.md). */
const NO_NEARER = 1;
/** Nearer by less than this is not nearer. */
const NEARER = 0.25;
/** Seconds between plans, at most. */
const PLAN_EVERY = 0.5;
/** Search nodes a plan may take. */
const PLAN_NODES = 4000;

export function createBrain(now: number): Brain {
  return { state: "idle", why: "", until: now + 1, goal: null, pulledAt: { x: 0, z: 0 }, lastPos: { x: 0, z: 0 }, closest: Infinity, lastProgress: now, tactics: [], nextLook: now, nextTactic: now, combatAt: now, lastControl: false, heldBy: 0, controlFreeAt: 0, fled: false, path: [], next: 0, nextPlan: now, aimBest: Infinity, aimAt: now };
}

/** Forgets the way it was following: a new goal, or none. */
function dropPath(brain: Brain, now: number): void {
  brain.path = [];
  brain.next = 0;
  brain.aimBest = Infinity;
  brain.aimAt = now;
}

/** How far is left along the way it follows, from where it stands. */
function pathLeft(self: Entity, brain: Brain): number {
  let left = 0;
  let x = self.x, z = self.z;
  for (let i = brain.next; i < brain.path.length; i++) {
    const p = brain.path[i];
    left += Math.hypot(p.x - x, p.z - z);
    x = p.x;
    z = p.z;
  }
  return left;
}

/**
 * The input that takes a creature toward a goal at a share of its pace (NAVIGATION.md, *Following a
 * path*): straight while the way is straight, along a planned way when it is not, or when walking
 * straight has got it no nearer for NO_NEARER. "unreachable" when a plan finds no way there.
 */
function steer(world: BrainWorld, self: Entity, brain: Brain, goal: Vec3, share: number, run: boolean): CreaturePart["input"] | "unreachable" {
  const { now, nav } = world;
  const here = { x: self.x, y: self.y, z: self.z };
  // The goal moved off from the end of the way: that way is stale.
  if (brain.path.length > 0) {
    const end = brain.path[brain.path.length - 1];
    if (Math.hypot(goal.x - end.x, goal.z - end.z) > Math.max(2, pathLeft(self, brain) / 3)) dropPath(brain, now);
  }
  // Waypoints passed.
  while (brain.next < brain.path.length && Math.hypot(brain.path[brain.next].x - self.x, brain.path[brain.next].z - self.z) < WAYPOINT) {
    brain.next++;
    brain.aimBest = Infinity;
    brain.aimAt = now;
  }
  if (brain.path.length > 0 && brain.next >= brain.path.length) dropPath(brain, now);
  const aim = brain.path.length > 0 ? brain.path[brain.next] : goal;
  const d = Math.hypot(aim.x - self.x, aim.z - self.z);
  if (d < brain.aimBest - NEARER) {
    brain.aimBest = d;
    brain.aimAt = now;
  }
  // Looked at once a PLAN_EVERY at most: in a dungeon `straight` is a few rays.
  if (now >= brain.nextPlan && ((brain.path.length === 0 && !nav.straight(self.dimension, here, goal, agentOf(self))) || now - brain.aimAt > NO_NEARER)) {
    brain.nextPlan = now + PLAN_EVERY;
    const way = nav.path(self.dimension, here, goal, PLAN_NODES, agentOf(self));
    if (!way) {
      dropPath(brain, now);
      return "unreachable";
    }
    brain.path = way;
    brain.next = 0;
    brain.aimBest = Infinity;
    brain.aimAt = now;
    return steer(world, self, brain, goal, share, run);
  }
  if (now >= brain.nextPlan && brain.path.length === 0) brain.nextPlan = now + PLAN_EVERY;
  return toward(self, aim.x, aim.z, share, run);
}

/** Group mates nearer than this, both in reach of one foe, are on each other: one steps aside. */
const OVERLAP = 1.1;
/** At this share of its walk. */
const ASIDE_PACE = 0.6;

/**
 * A creature in reach of its foe with a group mate on top of it (NAVIGATION.md, *Local steering*):
 * a step round the foe, away from the mate - sideways, so it stays in reach - or null when none is
 * that near. The lower id of two stays, so they do not both step the same way.
 */
function stepAside(world: BrainWorld, self: Entity, foe: Entity, walk: number): CreaturePart["input"] | null {
  let px = 0, pz = 0;
  for (const mate of world.groupOf(self)) {
    if (mate.id > self.id) continue;
    const dx = self.x - mate.x, dz = self.z - mate.z;
    const d = Math.hypot(dx, dz);
    if (d >= OVERLAP) continue;
    const [ux, uz] = d > 1e-3 ? [dx / d, dz / d] : [1, 0];
    px += ux * (1 - d / OVERLAP);
    pz += uz * (1 - d / OVERLAP);
  }
  if (px === 0 && pz === 0) return null;
  // Round the foe: the push less its part toward or away from the foe.
  const rx = self.x - foe.x, rz = self.z - foe.z, r = Math.hypot(rx, rz) || 1;
  const along = (px * rx + pz * rz) / r;
  let tx = px - (along * rx) / r, tz = pz - (along * rz) / r;
  // Straight in line with the mate and the foe: round to its left.
  if (Math.hypot(tx, tz) < 1e-3) [tx, tz] = [-rz / r, rx / r];
  const l = Math.hypot(tx, tz);
  return { moveX: (tx / l) * walk * ASIDE_PACE, moveZ: (tz / l) * walk * ASIDE_PACE, run: false, jump: false };
}


/** Who the nav is asked about for a creature: whether it swims. */
const agentOf = (self: Entity): NavAgent => ({ swims: self.creature!.kind.swims });

/** How far ahead a fleeing creature looks for somewhere to run, the turns off straight away from its
 *  foe it tries (radians, nearest first), and how often it looks again. */
const FLEE_REACH = 12;
const FLEE_TURNS = [0, 0.5, -0.5, 1, -1, 1.6, -1.6];
const FLEE_LOOK = 1;

/** Somewhere away from its foe a fleeing creature can run straight to: straight away if it can,
 *  else turned off it as little as will do, else straight away all the same. */
function fleeSpot(world: BrainWorld, self: Entity, foe: Entity): { x: number; y: number; z: number } {
  const away = Math.atan2(self.x - foe.x, self.z - foe.z);
  const here = { x: self.x, y: self.y, z: self.z };
  const at = (turn: number) => ({ x: self.x + Math.sin(away + turn) * FLEE_REACH, y: self.y, z: self.z + Math.cos(away + turn) * FLEE_REACH });
  for (const turn of FLEE_TURNS) {
    const spot = at(turn);
    if (world.nav.straight(self.dimension, here, spot, agentOf(self))) return spot;
  }
  return at(0);
}

/** A goal on the ground at (x, z), at its own height if it has one (home), else the creature's. */
const at = (self: Entity, p: { x: number; y?: number; z: number }): Vec3 => ({ x: p.x, y: p.y ?? self.y, z: p.z });

/** The flags crowd control puts on a foe: while it holds any, it is not controlled again. */
const CONTROLLED = [FLAG.stunned, FLAG.rooted, FLAG.silenced, FLAG.pacified, FLAG.disarmed];

/**
 * Whether crowd control may be used on a foe now (rules `control`): not while it is held, not for
 * `control.immunity` seconds after the hold ends, not when it is immune to what holds it.
 * Keeps `heldBy` and `controlFreeAt` up to date, so it is called every thought.
 */
function mayControl(world: BrainWorld, brain: Brain, foe: Entity): boolean {
  const flags = foe.combat?.flags;
  const held = CONTROLLED.some((f) => hasFlag(flags, f));
  if (held) {
    brain.heldBy = foe.id;
    return false;
  }
  // A hold that has just ended: the foe is left alone for a while.
  if (brain.heldBy === foe.id) {
    brain.heldBy = 0;
    brain.controlFreeAt = world.now + world.creatures.config.control.immunity;
  }
  if (world.now < brain.controlFreeAt) return false;
  return !hasFlag(flags, FLAG.immune);
}

/** A creature's stats and another's into the scope tactics' `when` and the aggro formula read. */
function scopeFor(world: BrainWorld, self: Entity, other: Entity | undefined, distance: number): Float64Array {
  const { scope } = world.creatures;
  const values = new Float64Array(scope.size);
  if (self.stats) values.set(statValues(self.stats), 0);
  if (other?.stats) values.set(statValues(other.stats), scope.stats);
  const share = (e: Entity | undefined): number => {
    const r = e?.resources;
    const h = world.rules.health;
    return r && r.max[h] > 0 ? r.current[h] / r.max[h] : 0;
  };
  values[scope.casterHealth] = share(self);
  values[scope.targetHealth] = share(other);
  values[scope.distance] = distance;
  return values;
}

/** The unit at the top of a creature's threat table, alive and in its dimension. */
function topOfThreat(world: BrainWorld, self: Entity): Entity | undefined {
  let best: Entity | undefined;
  let most = -Infinity;
  for (const [id, entry] of self.combat?.threat ?? []) {
    const unit = world.entity(id);
    if (!unit || unit.dimension !== self.dimension || !isAlive(unit)) continue;
    if (entry.amount > most) {
      most = entry.amount;
      best = unit;
    }
  }
  return best;
}

const STAND = { moveX: 0, moveZ: 0, run: false, jump: false };

/** The input that walks or runs toward a point, at a share of the body's pace. */
function toward(self: Entity, x: number, z: number, share: number, run: boolean): CreaturePart["input"] {
  const dx = x - self.x;
  const dz = z - self.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return STAND;
  return { moveX: (dx / d) * share, moveZ: (dz / d) * share, run, jump: false };
}

function face(self: Entity, other: Entity): void {
  const facing = Math.atan2(other.x - self.x, other.z - self.z);
  self.body?.face(facing);
  self.facing = facing;
}

/** Into combat: where the pull started, and the group comes too. */
function startCombat(world: BrainWorld, self: Entity, brain: Brain, pulling = true): void {
  brain.state = "combat";
  brain.combatAt = world.now;
  brain.lastControl = false;
  brain.heldBy = 0;
  brain.controlFreeAt = 0;
  brain.pulledAt = { x: self.x, z: self.z };
  brain.closest = Infinity;
  brain.lastProgress = world.now;
  brain.lastPos = { x: self.x, z: self.z };
  brain.fled = false;
  brain.goal = null;
  dropPath(brain, world.now);
  const foes = [...(self.combat?.threat?.keys() ?? [])];
  // Only mates near the one pulled come (rules `social`), not a whole spread-out camp: a pull that
  // starts at one of them brings its neighbours; the mates brought do not call their own.
  for (const mate of pulling ? world.groupOf(self) : []) {
    if (Math.hypot(mate.x - self.x, mate.z - self.z) > world.creatures.config.social) continue;
    const part = mate.creature!;
    if (part.brain.state === "combat" || part.brain.state === "evade" || part.brain.state === "flee") continue;
    for (const id of foes) addThreat(world.skills.sys, mate, world.entity(id), AGGRO_THREAT);
    startCombat(world, mate, part.brain, false);
  }
}

/** Gives up: immune, its table cleared, running home to come back at full health. */
function evade(world: BrainWorld, self: Entity, brain: Brain, why: string): void {
  const part = self.creature!;
  brain.state = "evade";
  brain.why = why;
  brain.goal = { ...part.home };
  dropPath(brain, world.now);
  world.skills.stopCast(self);
  world.skills.setAttacking(self, false);
  world.skills.setTarget(self, 0);
  self.combat?.threat?.clear();
  world.skills.apply(world.creatures.config.evadeSkill, self, self);
}

/** Home again: the evade ends, health and the rest back to full. */
function arriveHome(world: BrainWorld, self: Entity, brain: Brain): void {
  const combat = self.combat!;
  for (const magic of [...combat.magics]) if (magic.skill.index === world.creatures.config.evadeSkill) endMagic(world.skills.sys, magic, "expired");
  combat.threat?.clear();
  const resources = self.resources;
  if (resources) for (const r of resources.has) restore(resources, r, resources.max[r] - resources.current[r]);
  brain.state = "idle";
  brain.until = world.now + 2;
  brain.goal = null;
  dropPath(brain, world.now);
}

/**
 * One step of a creature's brain (see CREATURES.md, *The brain*): what it does and where it moves.
 * Sets `creature.input`; casts and targets through the skill system as a player's messages would.
 */
export function stepBrain(world: BrainWorld, self: Entity): void {
  const part = self.creature!;
  const brain = part.brain;
  const { kind } = part;
  const { config } = world.creatures;
  const combat = self.combat!;
  part.input = STAND;
  if (combat.dead) return;
  const now = world.now;
  const threatened = (combat.threat?.size ?? 0) > 0;

  // Hit while minding its own business (or pulled by a group-mate's foes): into combat.
  if ((brain.state === "idle" || brain.state === "wander") && threatened) startCombat(world, self, brain);

  switch (brain.state) {
    case "idle":
    case "wander": {
      // Kinds hostile to a player look round for it to aggro (NPCS.md, *Factions*).
      if (kind.aggro > 0 && now >= brain.nextLook) {
        brain.nextLook = now + LOOK_EVERY;
        for (const player of world.playersIn(self.dimension)) {
          if (!isAlive(player) || hiddenFrom(world.skills.sys, player, self)) continue;
          if (standingOf(world.skills.sys, self, player) >= world.skills.sys.rules.factions.hostile) continue;
          const distance = Math.hypot(player.x - self.x, player.z - self.z);
          if (distance > 50) continue;
          const radius = config.aggro.run(scopeFor(world, self, player, distance)) * kind.aggro;
          if (distance > radius || !world.lineOfSight(self.dimension, self, player)) continue;
          addThreat(world.skills.sys, self, player, AGGRO_THREAT);
          startCombat(world, self, brain);
          return stepBrain(world, self);
        }
      }
      if (brain.state === "idle") {
        if (now < brain.until) return;
        // Now and then a stroll to somewhere near home.
        if (part.wander > 0 && world.random(self) < 0.6) {
          for (let tries = 0; tries < 4; tries++) {
            const angle = world.random(self) * Math.PI * 2;
            const r = part.wander * Math.sqrt(world.random(self));
            const x = part.home.x + Math.sin(angle) * r;
            const z = part.home.z + Math.cos(angle) * r;
            // Somewhere it may stand, and can walk to from here.
            if (!world.open(x, z) || !world.nav.reachable(self.dimension, { x: self.x, y: self.y, z: self.z }, { x, y: self.y, z }, agentOf(self))) continue;
            brain.state = "wander";
            brain.goal = { x, z };
            brain.until = now + 20;
            dropPath(brain, now);
            break;
          }
        }
        if (brain.state === "idle") brain.until = now + 3 + world.random(self) * 6;
        return;
      }
      // Wandering: walk on till there, or give up after a while (a wall in the way).
      const goal = brain.goal!;
      const input = Math.hypot(goal.x - self.x, goal.z - self.z) < ARRIVED || now > brain.until ? "arrived" : steer(world, self, brain, at(self, goal), kind.speed.walk, false);
      if (typeof input === "string") {
        // There, out of time, or no way there: stand a while.
        brain.state = "idle";
        brain.goal = null;
        brain.until = now + 3 + world.random(self) * 6;
        dropPath(brain, now);
        return;
      }
      part.input = input;
      return;
    }

    case "evade": {
      const goal = brain.goal ?? part.home;
      combat.threat?.clear();
      if (Math.hypot(goal.x - self.x, goal.z - self.z) < ARRIVED + 0.5) {
        arriveHome(world, self, brain);
        return;
      }
      // No way home found: straight, and the teleport below catches it.
      const input = steer(world, self, brain, at(self, goal), 1, true);
      part.input = input === "unreachable" ? toward(self, goal.x, goal.z, 1, true) : input;
      // Somewhere it cannot get back from: put it home.
      if (now - brain.lastProgress > 20) {
        self.body?.teleport(goal.x, goal.z);
        arriveHome(world, self, brain);
      }
      return;
    }

    case "flee":
    case "combat": {
      const target = topOfThreat(world, self);
      if (!target) {
        evade(world, self, brain, "no foes left");
        brain.lastProgress = now;
        return;
      }
      if (combat.target !== target.id) world.skills.setTarget(self, target.id);
      // The leash: how far it has been drawn from where the pull started (not while it runs away).
      if (brain.state !== "flee" && Math.hypot(self.x - brain.pulledAt.x, self.z - brain.pulledAt.z) > config.leash) {
        evade(world, self, brain, "leash");
        brain.lastProgress = now;
        return;
      }
      const distance = gap(self, target);

      // Fleeing: away from its foe for a while, then back to the fight.
      if (brain.state === "flee") {
        if (now >= brain.until) brain.state = "combat";
        else {
          world.skills.setAttacking(self, false);
          // At half its pace: a fleeing creature can be caught, as in Classic.
          // Away from its foe, to a spot it can run straight to - looked for again every so often.
          if (!brain.goal || now >= brain.nextPlan || Math.hypot(brain.goal.x - self.x, brain.goal.z - self.z) < ARRIVED) {
            brain.goal = fleeSpot(world, self, target);
            brain.nextPlan = now + FLEE_LOOK;
          }
          part.input = toward(self, brain.goal.x, brain.goal.z, kind.speed.run * FLEE_PACE, true);
          return;
        }
      }
      const health = self.resources ? self.resources.current[world.rules.health] / Math.max(1, self.resources.max[world.rules.health]) : 1;
      if (kind.flee && !brain.fled && health < kind.flee.at) {
        brain.fled = true;
        brain.state = "flee";
        brain.until = now + kind.flee.time;
        brain.goal = null;
        dropPath(brain, now);
        world.skills.stopCast(self);
        return;
      }

      world.skills.setAttacking(self, true);
      const reach = kind.keepRange > 0 ? kind.keepRange : MELEE_GAP;
      const casting = combat.casting !== null;
      // A ranged creature in range but out of sight of its foe closes in until it sees it: the way
      // there comes round the corner, so the first spot with a line of sight stops it.
      const blind = kind.keepRange > 0 && distance <= reach && !world.lineOfSight(self.dimension, self, target);
      if ((distance > reach || blind) && !casting && canMove(combat.flags)) {
        const input = steer(world, self, brain, { x: target.x, y: target.y, z: target.z }, kind.speed.run, true);
        if (input === "unreachable") {
          evade(world, self, brain, "unreachable");
          brain.lastProgress = now;
          return;
        }
        part.input = input;
        // Progress is getting closer, or at least covering ground: a target that ran off is still
        // being chased, a creature pressed against a wall is not.
        const ran = Math.hypot(self.x - brain.lastPos.x, self.z - brain.lastPos.z) > 1;
        if (distance < brain.closest - 0.5 || ran) {
          brain.closest = distance;
          brain.lastProgress = now;
          brain.lastPos = { x: self.x, z: self.z };
        } else if (now - brain.lastProgress > config.stuck && !self.body?.pushed) {
          evade(world, self, brain, "stuck");
          brain.lastProgress = now;
          return;
        }
      } else {
        brain.closest = distance;
        brain.lastProgress = now;
        // In reach on a group mate's body: a step aside round the foe; else face it.
        const aside = !casting && canMove(combat.flags) ? stepAside(world, self, target, kind.speed.walk) : null;
        if (aside) part.input = aside;
        else if (!hasFlag(combat.flags, FLAG.stunned)) face(self, target);
      }

      // Tactics: the first ready one whose `when` holds goes.
      if (now >= brain.nextTactic && !casting) {
        brain.nextTactic = now + TACTIC_EVERY;
        const scope = scopeFor(world, self, target, distance);
        // Crowd control is never the first thing, nor twice in a row (while the kind has anything else to do).
        const control = mayControl(world, brain, target) && !(brain.lastControl && kind.tactics.some((t) => !t.control));
        for (let i = 0; i < kind.tactics.length; i++) {
          const tactic = kind.tactics[i];
          if ((brain.tactics[i] ?? 0) > now) continue;
          // The opening delay: nothing goes the moment the fight starts.
          if (now - brain.combatAt < tactic.after) continue;
          if (tactic.control && !control) continue;
          if (tactic.when && tactic.when.run(scope) === 0) continue;
          const result = world.skills.cast(self, tactic.skill, tactic.at === "self" ? self.id : target.id);
          if (!result.ok) continue;
          brain.lastControl = tactic.control;
          brain.tactics[i] = now + tactic.every[0] + world.random(self) * (tactic.every[1] - tactic.every[0]);
          break;
        }
      }
      return;
    }
  }
}
