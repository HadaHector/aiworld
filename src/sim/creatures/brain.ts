import type { Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import type { CreatureRules } from "../rules/creatureRules";
import type { SkillSystem } from "../skills/system";
import { addThreat } from "../skills/combat";
import { endMagic } from "../skills/magic";
import { canMove, FLAG, hasFlag } from "../skills/flags";
import { gap, hiddenFrom, isAlive } from "../skills/unit";
import { statValues } from "../stats";
import { restore } from "../resources";
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

export function createBrain(now: number): Brain {
  return { state: "idle", why: "", until: now + 1, goal: null, pulledAt: { x: 0, z: 0 }, lastPos: { x: 0, z: 0 }, closest: Infinity, lastProgress: now, tactics: [], nextLook: now, nextTactic: now, fled: false };
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
function startCombat(world: BrainWorld, self: Entity, brain: Brain): void {
  brain.state = "combat";
  brain.pulledAt = { x: self.x, z: self.z };
  brain.closest = Infinity;
  brain.lastProgress = world.now;
  brain.lastPos = { x: self.x, z: self.z };
  brain.fled = false;
  brain.goal = null;
  const foes = [...(self.combat?.threat?.keys() ?? [])];
  for (const mate of world.groupOf(self)) {
    const part = mate.creature!;
    if (part.brain.state === "combat" || part.brain.state === "evade" || part.brain.state === "flee") continue;
    for (const id of foes) addThreat(world.skills.sys, mate, world.entity(id), AGGRO_THREAT);
    startCombat(world, mate, part.brain);
  }
}

/** Gives up: immune, its table cleared, running home to come back at full health. */
function evade(world: BrainWorld, self: Entity, brain: Brain, why: string): void {
  const part = self.creature!;
  brain.state = "evade";
  brain.why = why;
  brain.goal = { ...part.home };
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
      // Hostile kinds look round for players to aggro.
      if (self.template.hostility === "hostile" && kind.aggro > 0 && now >= brain.nextLook) {
        brain.nextLook = now + LOOK_EVERY;
        for (const player of world.playersIn(self.dimension)) {
          if (!isAlive(player) || hiddenFrom(world.skills.sys, player, self)) continue;
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
            if (!world.open(x, z)) continue;
            brain.state = "wander";
            brain.goal = { x, z };
            brain.until = now + 20;
            break;
          }
        }
        if (brain.state === "idle") brain.until = now + 3 + world.random(self) * 6;
        return;
      }
      // Wandering: walk on till there, or give up after a while (a wall in the way).
      const goal = brain.goal!;
      if (Math.hypot(goal.x - self.x, goal.z - self.z) < ARRIVED || now > brain.until) {
        brain.state = "idle";
        brain.goal = null;
        brain.until = now + 3 + world.random(self) * 6;
        return;
      }
      part.input = toward(self, goal.x, goal.z, kind.speed.walk, false);
      return;
    }

    case "evade": {
      const goal = brain.goal ?? part.home;
      combat.threat?.clear();
      if (Math.hypot(goal.x - self.x, goal.z - self.z) < ARRIVED + 0.5) {
        arriveHome(world, self, brain);
        return;
      }
      part.input = toward(self, goal.x, goal.z, 1, true);
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
          part.input = toward(self, self.x * 2 - target.x, self.z * 2 - target.z, kind.speed.run * FLEE_PACE, true);
          return;
        }
      }
      const health = self.resources ? self.resources.current[world.rules.health] / Math.max(1, self.resources.max[world.rules.health]) : 1;
      if (kind.flee && !brain.fled && health < kind.flee.at) {
        brain.fled = true;
        brain.state = "flee";
        brain.until = now + kind.flee.time;
        world.skills.stopCast(self);
        return;
      }

      world.skills.setAttacking(self, true);
      const reach = kind.keepRange > 0 ? kind.keepRange : MELEE_GAP;
      const casting = combat.casting !== null;
      if (distance > reach && !casting && canMove(combat.flags)) {
        part.input = toward(self, target.x, target.z, kind.speed.run, true);
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
        if (!hasFlag(combat.flags, FLAG.stunned)) face(self, target);
      }

      // Tactics: the first ready one whose `when` holds goes.
      if (now >= brain.nextTactic && !casting) {
        brain.nextTactic = now + TACTIC_EVERY;
        const scope = scopeFor(world, self, target, distance);
        for (let i = 0; i < kind.tactics.length; i++) {
          const tactic = kind.tactics[i];
          if ((brain.tactics[i] ?? 0) > now) continue;
          if (tactic.when && tactic.when.run(scope) === 0) continue;
          const result = world.skills.cast(self, tactic.skill, tactic.at === "self" ? self.id : target.id);
          if (!result.ok) continue;
          brain.tactics[i] = now + tactic.every[0] + world.random(self) * (tactic.every[1] - tactic.every[0]);
          break;
        }
      }
      return;
    }
  }
}
