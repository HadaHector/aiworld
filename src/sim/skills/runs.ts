import type { Entity } from "../entity";
import { restore } from "../resources";
import { addModifier, removeSource } from "../stats";
import {
  attachRun, type AbsorbData, type CastData, type ChanceData, type DamageData, type FlagData, type GotoData, type HealData, type IfData,
  type InterruptData, type ModifierData, type MoveData, type NameData, type RemoveData, type ResourceData, type SetData, type StacksData,
  type SummonData, type ThreatData,
} from "./actions";
import { flagRaised, interrupt, requestCast } from "./casting";
import { addThreat, dealDamage, emit, heal, taunt } from "./combat";
import { REASON } from "./events";
import { lowerFlag, raiseFlag } from "./flags";
import { changeStacks, changeState, endMagic, evaluate, members, runActions, scopeFor, sourceOf, startMagic } from "./magic";
import type { AbsorbRecord, Magic, Sys } from "./types";
import { gap, matchesSkill } from "./unit";

/**
 * What core's action kinds do (ABILITIES.md, *Actions*), attached to the kinds actions.ts registered.
 * Imported once by the skill system for its side effect.
 */

const host = (sys: Sys, magic: Magic): Entity | undefined => (magic.host ? sys.world.entity(magic.host) : undefined);
const caster = (sys: Sys, magic: Magic): Entity | undefined => sys.world.entity(magic.caster);

attachRun<DamageData>("damage", {
  run(sys, magic, data, targets) {
    for (const t of targets) {
      const v = scopeFor(sys, magic, t);
      dealDamage(sys, magic, t, data.amount.run(v), { roll: data.roll, threat: data.threat.run(v), periodic: sys.ticking });
    }
  },
});

attachRun<HealData>("heal", {
  run(sys, magic, data, targets) {
    for (const t of targets) {
      const v = scopeFor(sys, magic, t);
      heal(sys, magic, t, data.amount.run(v), { roll: data.roll, threat: data.threat.run(v), periodic: sys.ticking });
    }
  },
});

attachRun<ResourceData>("resource", {
  run(sys, magic, data, targets) {
    for (const t of targets) if (t.resources) restore(t.resources, data.resource, evaluate(sys, magic, data.amount, t));
  },
});

attachRun<ModifierData>("modifier", {
  apply(sys, magic, data, target) {
    if (!target.stats) return null;
    const value = evaluate(sys, magic, data.value, target) * (data.perStack ? magic.stacks : 1);
    addModifier(target.stats, { stat: data.stat, kind: data.kind, value, source: sourceOf(magic) });
    return null;
  },
  undo(_sys, magic, _data, target) {
    if (target.stats) removeSource(target.stats, sourceOf(magic));
  },
});

attachRun<FlagData>("flag", {
  apply(sys, magic, data, target) {
    const raised: number[] = [];
    if (!target.combat) return raised;
    for (const flag of data.flags) {
      if (raiseFlag(target.combat.flags, flag)) {
        raised.push(flag);
        flagRaised(sys, target, flag);
      } else emit(sys, "resisted", { source: magic.caster, target: target.id, skill: magic.skill.index, at: target });
    }
    return raised;
  },
  undo(_sys, _magic, _data, target, record) {
    if (target.combat) for (const flag of record as number[]) lowerFlag(target.combat.flags, flag);
  },
});

attachRun<AbsorbData>("absorb", {
  apply(sys, magic, data, target) {
    if (!target.combat) return null;
    const record: AbsorbRecord = { magic, remaining: Math.max(0, evaluate(sys, magic, data.amount, target)), tags: data.tags };
    target.combat.absorbs.push(record);
    return record;
  },
  undo(_sys, _magic, _data, target, record) {
    const absorbs = target.combat?.absorbs;
    const i = absorbs?.indexOf(record as AbsorbRecord) ?? -1;
    if (i >= 0) absorbs!.splice(i, 1);
  },
});

attachRun<CastData>("cast", {
  run(sys, magic, data, targets) {
    const skill = sys.rules.skills[data.skill];
    const by = data.by === "host" ? host(sys, magic) : caster(sys, magic);
    if (!by) return;
    const level = data.level ? Math.max(0, Math.floor(evaluate(sys, magic, data.level))) : magic.level;
    for (const t of targets) {
      if (data.mode === "cast") {
        requestCast(sys, by, data.skill, t.id, { transient: { level }, depth: magic.depth + 1 });
        continue;
      }
      const vars = data.vars.map((v) => ({ index: v.index, value: evaluate(sys, magic, v.value, t) }));
      startMagic(sys, { skill, caster: by, host: t, target: t, level, vars, depth: magic.depth + 1 });
    }
  },
});

attachRun<StacksData>("stacks", {
  run(sys, magic, data, targets) {
    for (const t of targets) {
      const amount = evaluate(sys, magic, data.amount, t);
      for (const m of [...(t.combat?.magics ?? [])]) {
        if (data.skill >= 0 ? m.skill.index === data.skill : m.skill.stacking.group === data.stackGroup) changeStacks(sys, m, amount);
      }
    }
  },
});

attachRun<RemoveData>("remove", {
  run(sys, magic, data, targets) {
    for (const t of targets) {
      let count = Math.floor(evaluate(sys, magic, data.count, t));
      for (const m of [...(t.combat?.magics ?? [])]) {
        if (count <= 0) break;
        if (m === magic || m.skill.passive) continue;
        const match = (data.skill >= 0 && m.skill.index === data.skill) || (data.tag && matchesSkill({ skill: -1, tag: data.tag }, m)) || (data.dispel && m.skill.dispel === data.dispel);
        if (!match) continue;
        count--;
        emit(sys, "dispelled", { source: magic.caster, target: t.id, skill: m.skill.index, reason: REASON.dispelled, at: t });
        endMagic(sys, m, "dispelled");
      }
    }
  },
});

attachRun<InterruptData>("interrupt", {
  run(sys, magic, data, targets) {
    for (const t of targets) interrupt(sys, t, caster(sys, magic), Math.max(0, evaluate(sys, magic, data.lockout, t)));
  },
});

attachRun<MoveData>("move", {
  run(sys, magic, data, targets) {
    const from = caster(sys, magic);
    const aim = magic.target ? sys.world.entity(magic.target) : undefined;
    for (const t of targets) {
      const speed = Math.max(0.1, evaluate(sys, magic, data.speed, t));
      const distance = Math.max(0, evaluate(sys, magic, data.distance, t));
      const height = evaluate(sys, magic, data.height, t);
      // Which way: at the target, away from or toward the caster, or along the facing.
      let dx = Math.sin(t.facing);
      let dz = Math.cos(t.facing);
      let length = distance;
      if (data.kind === "knockback" || data.kind === "pull") {
        if (from && from !== t) {
          const h = Math.hypot(t.x - from.x, t.z - from.z) || 1;
          dx = (t.x - from.x) / h;
          dz = (t.z - from.z) / h;
        }
        if (data.kind === "pull") {
          dx = -dx;
          dz = -dz;
          if (from) length = Math.min(distance, gap(t, from));
        }
      } else if (data.toTarget && aim && aim !== t) {
        const h = Math.hypot(aim.x - t.x, aim.z - t.z) || 1;
        dx = (aim.x - t.x) / h;
        dz = (aim.z - t.z) / h;
        length = gap(t, aim);
      }
      if (data.kind === "teleport") {
        sys.world.push(t, { vx: 0, vy: 0, vz: 0, duration: 0, stopAt: null, to: { x: t.x + dx * length, z: t.z + dz * length } });
        continue;
      }
      const duration = length / speed;
      // A leap or a knockback goes up as well: high enough to come down at the end.
      const vy = data.kind === "leap" || data.kind === "knockback" ? Math.max(height, 0) / Math.max(duration / 2, 0.05) : 0;
      const stopAt = data.kind === "dash" && data.toTarget && aim ? { x: aim.x, z: aim.z, within: t.template.look.radius + aim.template.look.radius + 0.5 } : null;
      sys.world.push(t, { vx: dx * speed, vy, vz: dz * speed, duration, stopAt, to: null });
    }
  },
});

attachRun<SummonData>("summon", {
  run(sys, magic, data) {
    const owner = caster(sys, magic);
    if (!owner?.combat) return;
    const count = Math.max(0, Math.floor(evaluate(sys, magic, data.count)));
    const duration = evaluate(sys, magic, data.duration);
    for (let i = 0; i < count; i++) {
      // In front of the owner, spread round a little arc when there are several.
      const angle = owner.facing + (count > 1 ? (i / (count - 1) - 0.5) * 1.6 : 0);
      const at = data.at >= 0 ? magic : owner;
      const x = at.x + Math.sin(angle) * 1.5;
      const z = at.z + Math.cos(angle) * 1.5;
      const unit = sys.world.spawn(magic.dimension, data.template, x, z, owner.facing);
      if (!unit?.combat) continue;
      unit.combat.owner = owner.id;
      unit.combat.expires = duration > 0 ? sys.world.time() + duration : Infinity;
      owner.combat.summons.push(unit.id);
      emit(sys, "summon", { source: owner.id, target: unit.id, skill: magic.skill.index, at: unit });
    }
  },
});

attachRun<ThreatData>("threat", {
  run(sys, magic, data, targets) {
    const by = caster(sys, magic);
    if (!by) return;
    for (const t of targets) {
      if (data.taunt) taunt(sys, t, by);
      const amount = evaluate(sys, magic, data.amount, t);
      if (amount !== 0) addThreat(sys, t, by, amount);
    }
  },
});

attachRun<NameData>("animation", {
  run(sys, magic, data) {
    const unit = caster(sys, magic);
    if (unit) emit(sys, "animation", { source: unit.id, target: magic.target, skill: magic.skill.index, name: data.name, at: unit });
  },
});

attachRun<NameData>("effect", {
  run(sys, magic, data, targets) {
    for (const t of targets) emit(sys, "effect", { source: magic.caster, target: t.id, skill: magic.skill.index, name: data.name, at: t });
  },
});

attachRun<GotoData>("goto", { run: (sys, magic, data) => changeState(sys, magic, data.state) });

attachRun<SetData>("set", {
  run(sys, magic, data) {
    magic.vars[data.variable] = evaluate(sys, magic, data.value, host(sys, magic));
  },
});

attachRun<IfData>("if", {
  run(sys, magic, data) {
    let yes = data.when ? evaluate(sys, magic, data.when, host(sys, magic)) !== 0 : true;
    if (yes && data.has >= 0) yes = members(sys, magic, data.has).length > 0;
    runActions(sys, magic, yes ? data.then : data.otherwise, magic.serial);
  },
});

attachRun<ChanceData>("chance", {
  run(sys, magic, data) {
    const p = evaluate(sys, magic, data.p, host(sys, magic));
    runActions(sys, magic, magic.random() < p ? data.then : data.otherwise, magic.serial);
  },
});

attachRun<null>("end", { run: (sys, magic) => endMagic(sys, magic, "expired") });
