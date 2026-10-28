import type { Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import type { ItemTypeDef } from "../rules/itemRules";
import type { ProgressionRules, SourceDef, SourceKind } from "../rules/progressionRules";
import type { SkillSystem } from "../skills/system";
import type { CombatEvent } from "../skills/events";
import { EVENT_FLAG, EVENT_KIND } from "../skills/events";
import type { ItemHooks } from "../items/itemHooks";
import type { KillRecord } from "../creatures/system";
import { statValues } from "../stats";
import {
  addXp, createProgress, learn, pickTalent, recount, resetTree, setLevel, spentIn, teach, whyNotLearn,
  type ProgressContext, type ProgressEvent,
} from "./progress";
import { bindProgression } from "./actions";
import { exportProgress, importProgress, type SavedProgress } from "./save";

/** What the server gives the progression system. */
export interface ProgressionWorld {
  entity(id: number): Entity | undefined;
  /** The item type in an entity's main hand, or null for bare hands. */
  mainHand(entity: Entity): ItemTypeDef | null;
  /** Takes money (the main currency's smallest unit) from an entity; false if it has too little. */
  pay(entity: Entity, amount: number): boolean;
}

type CombatEntry = { event: CombatEvent; dimension: string; x: number; z: number };

/**
 * Progression as the server uses it (see PROGRESSION.md): characters made from their origins, XP
 * from kills, defeats and the step's combat events, trainers, books and talents, and the events
 * each owner is told of. Pure of messages: the server and its replicators carry what it says.
 */
export interface ProgressionSystem {
  readonly rules: ProgressionRules;
  readonly ctx: ProgressContext;
  /** The origins a Hello asked for, made valid - each slot's default where it named none or one that
   *  cannot be - and the template a character with them is made from. */
  originsFor(requested: Readonly<Record<string, string>> | undefined): { origins: Map<string, number>; template: string };
  /** A new player: its progress for its origins. */
  adopt(entity: Entity, origins: Map<string, number>): void;
  /** A player left the server. */
  leave(entity: Entity): void;
  /** A creature died (CREATURES.md's kill record): XP to those with credit. */
  kill(record: KillRecord): void;
  /** XP from the step's events - hits, heals, casts, a dummy beaten - and `levelUp` combat events
   *  added to the list for the clients near each character that went up. */
  combatEvents(events: CombatEntry[]): void;
  /** The hooks for later systems - gathering, crafting, quests - and the `xp` action: XP through every
   *  source of this kind (of one discipline only, when it is given). */
  award(entity: Entity, on: SourceKind, amount: number, discipline?: number, tags?: readonly string[]): void;
  pick(entity: Entity, tree: number, node: number): string;
  reset(entity: Entity, tree: number): string;
  /** A trainer teaches an available skill, for its cost. */
  train(entity: Entity, trainer: Entity, skill: number): string;
  /** The item hooks, with books refused (and kept) when their reader may not learn from them yet. */
  itemHooks(base: ItemHooks): ItemHooks;
  /** What happened to each character since the last drain, by entity id. */
  drain(): Map<number, ProgressEvent[]>;
  debugXp(entity: Entity, discipline: number, amount: number): void;
  debugLevel(entity: Entity, discipline: number, level: number): void;
  /** Debug: every skill a character's origins and disciplines could ever teach it. */
  learnAll(entity: Entity): void;
  export(entity: Entity): SavedProgress | null;
  import(entity: Entity, saved: SavedProgress): string[];
}

export function createProgressionSystem(game: GameRules, rules: ProgressionRules, skills: SkillSystem, world: ProgressionWorld): ProgressionSystem {
  const ctx: ProgressContext = {
    game,
    rules,
    grant: (entity, skill, level, source) => void skills.grant(entity, skill, level, source),
    revoke: (entity, source) => skills.revoke(entity, source),
  };
  const characters = new Set<Entity>();
  /** Sources by kind, with their discipline: what each event is matched against. */
  const byKind = new Map<SourceKind, { discipline: number; source: SourceDef }[]>();
  for (const d of rules.disciplines) {
    for (const source of d.sources) {
      if (!byKind.has(source.on)) byKind.set(source.on, []);
      byKind.get(source.on)!.push({ discipline: d.index, source });
    }
  }
  /** Who hit whom first and for how much: what `first` and `damage` credit read. */
  const ledger = new Map<number, { first: number; by: Map<number, number> }>();
  /** Units that do not die, beaten to 0 and not yet back above it. */
  const defeated = new Set<number>();

  const scope = rules.sourceScope;
  const values = new Float64Array(scope.size);

  /** XP from one source to one earner: the source's amount, `when` and `rate`, in its scope. */
  function award(earner: Entity, discipline: number, source: SourceDef, fill: { other?: Entity; amount?: number; earners?: number; share?: number; spellLevel?: number }, label: string): void {
    const progress = earner.progress?.disciplines.get(discipline);
    if (!progress) return;
    values.fill(0);
    if (earner.stats) values.set(statValues(earner.stats), scope.earner);
    if (fill.other?.stats) values.set(statValues(fill.other.stats), scope.other);
    values[scope.amount] = fill.amount ?? 0;
    values[scope.earners] = fill.earners ?? 1;
    values[scope.share] = fill.share ?? 1;
    values[scope.own] = progress.level;
    values[scope.spellLevel] = fill.spellLevel ?? 0;
    if (source.when && source.when.run(values) === 0) return;
    let amount = source.amount.run(values);
    if (source.rate) amount *= source.rate.run(values);
    if (source.credit === "split" || source.credit === "damage") amount *= fill.share ?? 1;
    if (amount > 0) addXp(ctx, earner, discipline, amount, label);
  }

  const tagsMatch = (source: SourceDef, skill: number): boolean => {
    const tags = skill >= 0 ? game.skills[skill].tags : [];
    return source.tags.every((t) => tags.includes(t)) && !source.notTags.some((t) => tags.includes(t));
  };

  function weaponMatches(source: SourceDef, entity: Entity): boolean {
    const match = source.weapon;
    if (!match) return true;
    const held = world.mainHand(entity);
    if (match === "none") return held === null;
    if (!held) return false;
    if ("template" in match) return held.template === match.template;
    if ("type" in match) return held.id === match.type;
    return held.kind === match.kind;
  }

  /** Credit for a victim: who earns, and each one's share, by a source's rule. */
  function credited(source: SourceDef, victim: number, credit: number[]): { earner: Entity; share: number }[] {
    const earners = credit.map((id) => world.entity(id)).filter((e): e is Entity => !!e?.progress);
    if (earners.length === 0) return [];
    switch (source.credit) {
      case "all":
        return earners.map((earner) => ({ earner, share: 1 }));
      case "split":
        return earners.map((earner) => ({ earner, share: 1 / earners.length }));
      case "top":
        return [{ earner: earners[0], share: 1 }];
      case "first": {
        const first = ledger.get(victim)?.first;
        const earner = earners.find((e) => e.id === first) ?? earners[0];
        return [{ earner, share: 1 }];
      }
      case "damage": {
        const by = ledger.get(victim)?.by;
        const total = earners.reduce((sum, e) => sum + (by?.get(e.id) ?? 0), 0);
        return earners.map((earner) => ({ earner, share: total > 0 ? (by?.get(earner.id) ?? 0) / total : 1 / earners.length }));
      }
    }
  }

  function creditFor(kind: "kill" | "defeat", victim: Entity, credit: number[]): void {
    for (const { discipline, source } of byKind.get(kind) ?? []) {
      const list = credited(source, victim.id, credit);
      for (const { earner, share } of list) award(earner, discipline, source, { other: victim, earners: list.length, share }, kind);
    }
  }

  /** Who is on a unit's threat table, most threat first. */
  const threatOrder = (unit: Entity): number[] =>
    [...(unit.combat?.threat ?? new Map()).entries()].sort((a, b) => b[1].amount - a[1].amount || a[0] - b[0]).map(([id]) => id);

  function combatEvents(events: CombatEntry[]): void {
    for (const { event } of events) {
      if (event.kind === EVENT_KIND.hit) {
        const source = world.entity(event.source);
        const target = world.entity(event.target);
        // The ledger: per victim, the first to hit it and how much each dealt.
        if (target && event.amount > 0) {
          let entry = ledger.get(target.id);
          if (!entry) ledger.set(target.id, (entry = { first: event.source, by: new Map() }));
          entry.by.set(event.source, (entry.by.get(event.source) ?? 0) + event.amount);
        }
        const periodic = (event.flags & EVENT_FLAG.periodic) !== 0;
        if (source?.progress) {
          for (const { discipline, source: s } of byKind.get("hitDealt") ?? []) {
            if (tagsMatch(s, event.skill) && (s.periodic === null || s.periodic === periodic) && weaponMatches(s, source)) award(source, discipline, s, { other: target, amount: event.amount }, "hitDealt");
          }
        }
        if (target?.progress) {
          for (const { discipline, source: s } of byKind.get("hitTaken") ?? []) {
            if (tagsMatch(s, event.skill) && (s.periodic === null || s.periodic === periodic)) award(target, discipline, s, { other: source, amount: event.amount }, "hitTaken");
          }
        }
        // A unit that does not die, beaten to 0: a defeat, once until it is back above 0.
        if (target && !target.template.mortal && target.resources && target.resources.current[game.health] <= 0 && !defeated.has(target.id)) {
          defeated.add(target.id);
          creditFor("defeat", target, threatOrder(target).length > 0 ? threatOrder(target) : [event.source]);
          ledger.delete(target.id);
        }
      } else if (event.kind === EVENT_KIND.heal) {
        const source = world.entity(event.source);
        if (source?.progress && event.amount > 0) {
          for (const { discipline, source: s } of byKind.get("healDealt") ?? []) {
            if (tagsMatch(s, event.skill)) award(source, discipline, s, { other: world.entity(event.target), amount: event.amount }, "healDealt");
          }
        }
      } else if (event.kind === EVENT_KIND.castDone) {
        const caster = world.entity(event.source);
        if (!caster?.progress) continue;
        const spell = caster.combat?.spells.find((s) => s.skill === event.skill);
        for (const { discipline, source: s } of byKind.get("cast") ?? []) {
          if (!tagsMatch(s, event.skill) || !spellFrom(caster, s.spellSource, event.skill, spell?.source ?? "")) continue;
          award(caster, discipline, s, { other: world.entity(event.target), spellLevel: spell?.level ?? 1 }, "cast");
        }
      }
    }
    // Defeated units back above 0 can be beaten again; victims gone or left alone are forgotten.
    for (const id of defeated) {
      const unit = world.entity(id);
      if (!unit?.resources || unit.resources.current[game.health] > 0) defeated.delete(id);
    }
    for (const [id] of ledger) {
      const unit = world.entity(id);
      if (!unit || (!unit.combat?.dead && (unit.combat?.threat?.size ?? 0) === 0 && !unit.inCombat)) ledger.delete(id);
    }
    // Level-ups others may see, as combat events near the character.
    for (const entity of characters) {
      for (const e of entity.progress!.events) {
        if (e.kind !== "levelUp" || rules.disciplines[e.discipline].visible !== "all") continue;
        events.push({
          event: { kind: EVENT_KIND.levelUp, source: entity.id, target: entity.id, skill: -1, amount: e.level, extra: 0, absorbed: 0, flags: 0, reason: 0, name: rules.disciplines[e.discipline].id, time: 0 },
          dimension: entity.dimension,
          x: entity.x,
          z: entity.z,
        });
      }
    }
  }

  /** Whether a spell came from where a `cast` source asks: `origin:<slot>` is the skills that slot's
   *  origin gives or unlocks; anything else a prefix of the spell's own source. */
  function spellFrom(caster: Entity, wanted: string, skill: number, spellSource: string): boolean {
    if (!wanted) return true;
    if (wanted.startsWith("origin:")) return caster.progress!.originSkills.get(wanted.slice(7))?.has(skill) ?? false;
    return spellSource.startsWith(wanted);
  }

  const system: ProgressionSystem = {
    rules,
    ctx,
    originsFor(requested) {
      const origins = new Map<string, number>();
      for (const slot of rules.config.slots) {
        const id = requested?.[slot.id];
        const index = id === undefined ? undefined : rules.originIndex.get(id);
        const chosen = index !== undefined && rules.origins[index].slot === slot.id ? index : rules.originIndex.get(slot.default);
        if (chosen !== undefined) origins.set(slot.id, chosen);
      }
      const key = (map: Map<string, number>): string => rules.config.slots.map((s) => (map.has(s.id) ? rules.origins[map.get(s.id)!].id : "")).join(".");
      let template = rules.combinations.get(key(origins));
      if (!template) {
        // A pick the origins forbid together: every slot's default.
        origins.clear();
        for (const slot of rules.config.slots) {
          const index = rules.originIndex.get(slot.default);
          if (index !== undefined) origins.set(slot.id, index);
        }
        template = rules.combinations.get(key(origins));
      }
      return { origins, template: template ?? "" };
    },
    adopt(entity, origins) {
      createProgress(ctx, entity, origins);
      characters.add(entity);
    },
    leave: (entity) => void characters.delete(entity),
    kill(record) {
      const victim = world.entity(record.creature);
      if (victim) creditFor("kill", victim, record.credit);
      ledger.delete(record.creature);
    },
    combatEvents,
    award(entity, on, amount, discipline, tags = []) {
      for (const { discipline: d, source } of byKind.get(on) ?? []) {
        if (discipline !== undefined && d !== discipline) continue;
        if (!source.tags.every((t) => tags.includes(t)) || source.notTags.some((t) => tags.includes(t))) continue;
        award(entity, d, source, { amount }, on);
      }
    },
    pick: (entity, tree, node) => pickTalent(ctx, entity, tree, node),
    reset(entity, tree) {
      const part = entity.progress;
      if (!part || !part.talents.has(tree)) return "nothing";
      const cost = Math.max(0, Math.round(rules.config.respecCost.run([spentIn(ctx, part, tree)])));
      if (cost > 0 && !world.pay(entity, cost)) return "money";
      resetTree(ctx, entity, tree);
      return "";
    },
    train(entity, trainer, skill) {
      const teaches = rules.config.trainers.get(trainer.template.id);
      if (teaches === undefined) return "notTrainer";
      if (teaches !== null && !teaches.has(skill)) return "notTaught";
      if (trainer.dimension !== entity.dimension || Math.hypot(trainer.x - entity.x, trainer.z - entity.z) > rules.config.trainRange) return "range";
      const why = whyNotLearn(entity, skill, "trainer");
      if (why) return why;
      const cost = entity.progress!.available.get(skill)!.cost;
      if (cost > 0 && !world.pay(entity, cost)) return "money";
      return learn(ctx, entity, skill, "trainer");
    },
    itemHooks(base) {
      return {
        ...base,
        use(user, item, skillId) {
          const skill = game.skillIndex.get(skillId);
          const teaches = skill === undefined ? -1 : learnedBy(game, skill);
          if (teaches >= 0 && user.progress) {
            const why = whyNotLearn(user, teaches, "item");
            if (why) {
              user.progress.events.push({ kind: "refused", discipline: -1, amount: 0, level: 0, skill: teaches, source: why });
              return false;
            }
          }
          return base.use(user, item, skillId);
        },
      };
    },
    drain() {
      const out = new Map<number, ProgressEvent[]>();
      for (const entity of characters) {
        const part = entity.progress!;
        if (part.events.length === 0) continue;
        out.set(entity.id, part.events);
        part.events = [];
      }
      return out;
    },
    debugXp: (entity, discipline, amount) => void addXp(ctx, entity, discipline, amount, "debug"),
    debugLevel: (entity, discipline, level) => setLevel(ctx, entity, discipline, level),
    learnAll(entity) {
      const part = entity.progress;
      if (!part) return;
      const skills = new Set<number>();
      for (const d of rules.disciplines) for (const u of d.unlocks) if (u.skill >= 0) skills.add(u.skill);
      for (const index of part.origins.values()) for (const list of rules.origins[index].unlocks.values()) for (const u of list) if (u.skill >= 0) skills.add(u.skill);
      for (const tree of part.trees) for (const node of rules.trees[tree].nodes) if (node.skill >= 0) skills.add(node.skill);
      for (const skill of [...skills].sort((a, b) => a - b)) teach(ctx, entity, skill, "auto");
      recount(ctx, entity);
    },
    export: (entity) => exportProgress(ctx, entity),
    import: (entity, saved) => importProgress(ctx, entity, saved),
  };
  // The `learn` and `xp` actions find this system through the skill system they run in.
  bindProgression(skills.sys, system);
  return system;
}

/** The skill a skill's `learn` action teaches, or -1: what makes an item a book. */
function learnedBy(game: GameRules, skill: number): number {
  for (const state of game.skills[skill].states) {
    for (const action of [...state.enter, ...state.tick, ...state.exit]) if (action.kind === "learn") return (action.data as { skill: number }).skill;
  }
  return -1;
}
