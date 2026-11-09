import { deriveSeed, mulberry32 } from "../../world/rng";
import { hashString } from "../../world/content/dimensions";
import type { Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import type { ServerMessage } from "../protocol";
import { EVENT_KIND, type CombatEvent } from "../skills/events";
import type { KillRecord } from "../creatures/system";
import { bindOf, kindMatches, needed, type ActiveQuest, type Objective, type QuestDef, type QuestPart, type QuestRules, type SavedQuests } from "./quest";

/**
 * Quests on the server (QUESTS.md, *Tracking*): defined quests, what each character has taken and
 * done, and the events that move them - kills, quest drops, ground objects taken, quest items used
 * on creatures, talking to NPCs, places reached - then the rewards. Failing and abandoning leave
 * nothing behind. A character's quests are a small record of ids and counts, saved with it.
 */
export interface QuestWorld {
  time(): number;
  entity(id: number): Entity | undefined;
  /** The NPC id (NPCS.md's `npc:...`) an entity is, or undefined. */
  npcId(entity: Entity): string | undefined;
  /** The NPC entity standing now for an NPC id, if its settlement is filled. */
  npcEntity(id: string): Entity | undefined;
  playersIn(dimension: string): Entity[];
  spawn(dimension: string, template: string, x: number, z: number, key: string): Entity | undefined;
  despawn(entity: Entity): void;
  /** Items: how many of a type did not fit; whether one was taken; whether it has one. A quest item
   *  is its quest line's own - `bind` is the roll of its instance - so another quest's of the same
   *  type is not it. */
  give(entity: Entity, type: string, count: number, bind: number): number;
  take(entity: Entity, type: string, bind: number): boolean;
  has(entity: Entity, type: string, bind: number): boolean;
  /** Leaves a quest item (one of the type, with the quest line's roll) in a corpse's loot for one player alone. */
  drop(player: Entity, source: number, type: string, bind: number): boolean;
  /** Takes from an entity every quest item (a type with `quest`) `keep` says no to; how many went. */
  sweep(entity: Entity, keep: (type: string, bind: number) => boolean): number;
  /** The skill an item type's use casts, or "". */
  useSkill(type: string): string;
  pay(entity: Entity, money: number): void;
  award(entity: Entity, xp: number): void;
  changeStanding(entity: Entity, faction: string, amount: number): void;
  level(entity: Entity): number;
  send(entity: Entity, message: ServerMessage): void;
}

export interface QuestSystem {
  /** Makes quests known: the generator's (or a probe's). A quest already known is kept as it was. */
  define(defs: readonly QuestDef[]): void;
  def(id: string): QuestDef | undefined;
  /** A player arrives with its quests (from its record), or new. */
  adopt(entity: Entity, saved: SavedQuests | null): void;
  export(entity: Entity): SavedQuests;
  /** The quests an NPC has for a player: to take, in progress, ready to hand in. */
  questsAt(player: Entity, npc: Entity): { id: string; state: "offer" | "active" | "ready" }[];
  /** The mark over an NPC for a player (QUESTS.md, *Markers*): "?" to hand in, "!" to take, "?grey"
   *  in progress, "!grey" a level or two off; "" for none. */
  markerFor(player: Entity, npc: Entity): string;
  /** Talking to an NPC: talk, receive and deliver objectives with it are done. */
  talked(player: Entity, npc: Entity): void;
  accept(player: Entity, npc: Entity, quest: string): string;
  complete(player: Entity, npc: Entity, quest: string, choice: number): string;
  abandon(player: Entity, quest: string): string;
  /** A player takes a ground object. */
  takeObject(player: Entity, object: Entity): string;
  /** Clears a character's bags of quest items no quest of theirs could use - from a quest dropped from
   *  the packs, or kept from before items were bound to their quest line. Those of a quest line not yet
   *  finished stay, even between two of its quests. */
  sweep(player: Entity): number;
  /** The quests whose items a player holds, one for each line: for the client to name them (QUESTS.md, *Quest items*). */
  defsOfHeldItems(player: Entity): QuestDef[];
  /** A player took items into their bag from loot (a type id, the roll, how many): a quest's drop counts. */
  itemGained(player: Entity, type: string, bind: number, count: number): void;
  /** A player used an item (a type id, and the roll of the instance): the next cast of its skill counts for that. */
  itemUsed(player: Entity, type: string, bind: number): void;
  kill(record: KillRecord): void;
  combatEvents(events: readonly CombatEvent[]): void;
  step(): void;
}

const LOOK_EVERY = 0.5;
/** Ground objects this near a player on the quest are filled; dropped once none has been near for a minute. */
const OBJECTS_NEAR = 150;
const OBJECTS_KEEP = 60;
const TAKE_RANGE = 3.5;

interface ObjectSet {
  quest: QuestDef;
  objective: number;
  entities: (Entity | null)[];
  backAt: number[];
  lastNear: number;
}

export function createQuestSystem(rules: GameRules, quests: QuestRules, world: QuestWorld): QuestSystem {
  const defs = new Map<string, QuestDef>();
  const parts = new Map<number, QuestPart>();
  const objectSets = new Map<string, ObjectSet>();
  const objectOf = new Map<number, { set: ObjectSet; index: number }>();
  const random = mulberry32(deriveSeed(hashString("quests"), 1));
  let nextLook = 0;
  /** The item each player used last, for a `use` objective to count only its own quest's item. */
  const lastUsed = new Map<number, { type: string; bind: number }>();

  const partOf = (entity: Entity): QuestPart | undefined => parts.get(entity.id);

  function send(entity: Entity, quest: string, active: ActiveQuest | null, state: "done" | "removed" | null = null): void {
    world.send(entity, { type: "questUpdate", quest, counts: active?.counts ?? [], state: state ?? active!.state });
  }

  /** The first objective not yet done, for an ordered quest; -1 when all are. */
  function current(def: QuestDef, active: ActiveQuest): number {
    return def.objectives.findIndex((o, i) => active.counts[i] < needed(o));
  }
  /** Whether an objective counts now: not done, and in an ordered quest the current one. */
  function open(def: QuestDef, active: ActiveQuest, index: number): boolean {
    if (active.state !== "active" || active.counts[index] >= needed(def.objectives[index])) return false;
    return !def.ordered || current(def, active) === index;
  }

  /** One step of an objective's count, for a player; ready once every objective is done. */
  function advance(player: Entity, def: QuestDef, active: ActiveQuest, index: number, by = 1): void {
    active.counts[index] = Math.min(needed(def.objectives[index]), active.counts[index] + by);
    if (def.objectives.every((o, i) => active.counts[i] >= needed(o))) active.state = "ready";
    send(player, def.id, active);
  }

  /** Every open objective of every quest a player has, with its quest. */
  function* openObjectives(player: Entity): Generator<{ def: QuestDef; active: ActiveQuest; objective: Objective; index: number }> {
    const part = partOf(player);
    if (!part) return;
    for (const active of part.active.values()) {
      const def = defs.get(active.id);
      if (!def) continue;
      for (let index = 0; index < def.objectives.length; index++) if (open(def, active, index)) yield { def, active, objective: def.objectives[index], index };
    }
  }

  function available(player: Entity, def: QuestDef): boolean {
    const part = partOf(player);
    if (!part || part.active.has(def.id) || part.done.has(def.id)) return false;
    return def.requires.quests.every((q) => part.done.has(q)) && world.level(player) >= def.requires.level;
  }

  const near = (a: Entity, b: Entity, range: number): boolean => a.dimension === b.dimension && Math.hypot(a.x - b.x, a.z - b.z) <= range;

  /** The types of the quest items a quest gave, asks to use or to deliver: taken back when it ends. When
   *  it is handed in, a later quest of the same chain still to do keeps the ones it uses (the next in a
   *  chain uses the salve it was given); abandoned, they all go - and are handed again if it is taken. */
  function questItems(player: Entity, def: QuestDef, completing: boolean): string[] {
    const part = partOf(player);
    const wanted = new Set<string>();
    if (completing && def.chain) {
      for (const other of defs.values()) {
        if (part?.done.has(other.id) || other.chain?.id !== def.chain.id || other.chain.index <= def.chain.index) continue;
        for (const o of other.objectives) if (o.kind === "use" || o.kind === "deliver") wanted.add(o.item);
      }
    }
    const types = def.objectives.flatMap((o) => (o.kind === "receive" || o.kind === "use" || o.kind === "deliver" || o.kind === "drop" ? [o.item] : []));
    return [...new Set(types)].filter((item) => !wanted.has(item));
  }

  /** XP for a quest at a character's level: full at or under its level, less as it outgrows it. */
  function xpFor(def: QuestDef, level: number): number {
    const full = def.rewards.xp;
    const over = level - def.level;
    if (over <= 0) return full;
    const { grey, greyShare } = quests.xp;
    return Math.round(full * (over >= grey ? greyShare : 1 - (over / grey) * (1 - greyShare)));
  }

  function spotsFor(set: ObjectSet, n: number): { x: number; z: number } {
    const o = set.quest.objectives[set.objective] as Extract<Objective, { kind: "gather" }>;
    const rng = mulberry32(deriveSeed(hashString(set.quest.id), set.objective * 97 + n));
    const angle = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * o.area.radius;
    return { x: o.area.x + Math.cos(angle) * r, z: o.area.z + Math.sin(angle) * r };
  }

  /** Ground objects stand while a player who needs them is near (QUESTS.md, *Ground objects*). */
  function stepObjects(now: number): void {
    const wanted = new Map<string, { def: QuestDef; index: number }>();
    for (const part of parts.keys()) {
      const player = world.entity(part);
      if (!player) continue;
      for (const { def, objective, index } of openObjectives(player)) {
        if (objective.kind !== "gather" || objective.area.dimension !== player.dimension) continue;
        if (Math.hypot(player.x - objective.area.x, player.z - objective.area.z) > OBJECTS_NEAR + objective.area.radius) continue;
        wanted.set(`${def.id}#${index}`, { def, index });
      }
    }
    for (const [key, { def, index }] of wanted) {
      let set = objectSets.get(key);
      if (!set) {
        set = { quest: def, objective: index, entities: new Array(quests.objects.count).fill(null), backAt: new Array(quests.objects.count).fill(0), lastNear: now };
        objectSets.set(key, set);
      }
      set.lastNear = now;
      const o = def.objectives[index] as Extract<Objective, { kind: "gather" }>;
      for (let n = 0; n < set.entities.length; n++) {
        if (set.entities[n] || set.backAt[n] > now) continue;
        const at = spotsFor(set, n);
        const entity = world.spawn(o.area.dimension, quests.objects.template, at.x, at.z, `qo:${def.id}/${index}/${n}`);
        if (!entity) continue;
        entity.name = o.object;
        set.entities[n] = entity;
        objectOf.set(entity.id, { set, index: n });
      }
    }
    for (const [key, set] of objectSets) {
      if (now - set.lastNear < OBJECTS_KEEP) continue;
      for (const e of set.entities) if (e) {
        objectOf.delete(e.id);
        world.despawn(e);
      }
      objectSets.delete(key);
    }
  }

  return {
    define(list) {
      for (const def of list) if (!defs.has(def.id)) defs.set(def.id, def);
    },
    def: (id) => defs.get(id),
    adopt(entity, saved) {
      const part: QuestPart = { active: new Map(), done: new Set(saved?.done ?? []) };
      for (const a of saved?.active ?? []) part.active.set(a.id, { id: a.id, counts: [...a.counts], state: a.state, accepted: a.accepted });
      parts.set(entity.id, part);
    },
    export(entity) {
      const part = partOf(entity);
      return { active: [...(part?.active.values() ?? [])].map((a) => ({ ...a, counts: [...a.counts] })), done: [...(part?.done ?? [])] };
    },
    questsAt(player, npc) {
      const id = world.npcId(npc);
      const part = partOf(player);
      if (!id || !part) return [];
      const out: { id: string; state: "offer" | "active" | "ready" }[] = [];
      for (const def of defs.values()) {
        const active = part.active.get(def.id);
        if (active && def.ender === id) out.push({ id: def.id, state: active.state === "ready" ? "ready" : "active" });
        else if (!active && def.giver === id && available(player, def)) out.push({ id: def.id, state: "offer" });
      }
      return out;
    },
    markerFor(player, npc) {
      const id = world.npcId(npc);
      const part = partOf(player);
      if (!id || !part) return "";
      let best = "";
      const rank: Record<string, number> = { "": 0, "!grey": 1, "?grey": 2, "!": 3, "?": 4 };
      const consider = (mark: string): void => {
        if (rank[mark] > rank[best]) best = mark;
      };
      const level = world.level(player);
      for (const def of defs.values()) {
        const active = part.active.get(def.id);
        if (active && def.ender === id) consider(active.state === "ready" ? "?" : "?grey");
        else if (!active && def.giver === id && !part.done.has(def.id) && def.requires.quests.every((q) => part.done.has(q))) {
          if (level >= def.requires.level) consider("!");
          else if (level + 2 >= def.requires.level) consider("!grey");
        }
      }
      return best;
    },
    talked(player, npc) {
      const id = world.npcId(npc);
      if (!id) return;
      // Talk, receive and deliver objectives with this NPC, one after another as they open.
      for (let pass = 0; pass < 8; pass++) {
        let moved = false;
        for (const { def, active, objective, index } of openObjectives(player)) {
          if (objective.kind === "talk" && objective.npc === id) {
            advance(player, def, active, index);
            moved = true;
          } else if (objective.kind === "receive" && objective.from === id) {
            if (world.has(player, objective.item, bindOf(def)) || world.give(player, objective.item, 1, bindOf(def)) === 0) {
              advance(player, def, active, index);
              moved = true;
            }
          } else if (objective.kind === "deliver" && objective.to === id && world.take(player, objective.item, bindOf(def))) {
            advance(player, def, active, index);
            moved = true;
          }
        }
        if (!moved) break;
      }
    },
    accept(player, npc, quest) {
      const def = defs.get(quest);
      const part = partOf(player);
      if (!def || !part) return "unknown";
      if (world.npcId(npc) !== def.giver) return "notGiver";
      if (!near(player, npc, quests.talkRange)) return "range";
      if (!available(player, def)) return "notAvailable";
      if (part.active.size >= quests.maxActive) return "logFull";
      const active: ActiveQuest = { id: def.id, counts: def.objectives.map(() => 0), state: "active", accepted: world.time() };
      part.active.set(def.id, active);
      send(player, def.id, active);
      // An item it asks you to use that it does not itself give is handed again if it was lost with an
      // abandoned try of this quest (the salve of the last quest, taken with it).
      for (const o of def.objectives) {
        if (o.kind === "use" && !def.objectives.some((x) => x.kind === "receive" && x.item === o.item) && !world.has(player, o.item, bindOf(def))) world.give(player, o.item, 1, bindOf(def));
      }
      // Its giver may be the one it first sends you to.
      this.talked(player, npc);
      return "";
    },
    complete(player, npc, quest, choice) {
      const def = defs.get(quest);
      const part = partOf(player);
      const active = part?.active.get(quest);
      if (!def || !part || !active) return "unknown";
      if (world.npcId(npc) !== def.ender) return "notEnder";
      if (!near(player, npc, quests.talkRange)) return "range";
      if (active.state !== "ready") return "notReady";
      const chosen = def.rewards.choice.length > 0 ? def.rewards.choice[choice] : undefined;
      if (def.rewards.choice.length > 0 && chosen === undefined) return "choose";
      for (const item of questItems(player, def, true)) world.take(player, item, bindOf(def));
      const items = [...(chosen ? [chosen] : []), ...def.rewards.items];
      // A reward is an ordinary item (its roll made as any is), not a quest item.
      for (const item of items) if (world.give(player, item, 1, 0) > 0) return "bagFull";
      part.active.delete(quest);
      part.done.add(quest);
      world.award(player, xpFor(def, world.level(player)));
      if (def.rewards.money > 0) world.pay(player, def.rewards.money);
      for (const s of def.rewards.standing) world.changeStanding(player, s.faction, s.amount);
      send(player, quest, null, "done");
      return "";
    },
    abandon(player, quest) {
      const def = defs.get(quest);
      const part = partOf(player);
      if (!def || !part?.active.has(quest)) return "unknown";
      part.active.delete(quest);
      for (const item of questItems(player, def, false)) world.take(player, item, bindOf(def));
      send(player, quest, null, "removed");
      return "";
    },
    takeObject(player, object) {
      const found = objectOf.get(object.id);
      if (!found) return "notObject";
      if (!near(player, object, TAKE_RANGE)) return "range";
      const { set, index } = found;
      const part = partOf(player);
      const active = part?.active.get(set.quest.id);
      if (!active || !open(set.quest, active, set.objective)) return "notNeeded";
      advance(player, set.quest, active, set.objective);
      objectOf.delete(object.id);
      world.despawn(object);
      set.entities[index] = null;
      set.backAt[index] = world.time() + quests.objects.respawn;
      return "";
    },
    sweep(player) {
      const part = partOf(player);
      const wanted = new Set<string>();
      for (const def of defs.values()) {
        if (part?.done.has(def.id)) continue;
        for (const o of def.objectives) if (o.kind === "receive" || o.kind === "use" || o.kind === "deliver" || o.kind === "drop") wanted.add(`${o.item}/${bindOf(def)}`);
      }
      return world.sweep(player, (type, bind) => wanted.has(`${type}/${bind}`));
    },
    defsOfHeldItems(player) {
      const found = new Map<string, QuestDef>();
      world.sweep(player, (type, bind) => {
        for (const def of defs.values()) if (bindOf(def) === bind && def.itemLooks?.[type]) found.set(def.id, def);
        return true;
      });
      return [...found.values()];
    },
    itemGained(player, type, bind, count) {
      for (const { def, active, objective, index } of [...openObjectives(player)]) {
        if (objective.kind === "drop" && objective.item === type && bindOf(def) === bind) advance(player, def, active, index, count);
      }
    },
    itemUsed(player, type, bind) {
      lastUsed.set(player.id, { type, bind });
    },
    kill(record) {
      for (const id of record.credit) {
        const player = world.entity(id);
        if (!player || !parts.has(id)) continue;
        for (const { def, active, objective, index } of [...openObjectives(player)]) {
          if (objective.kind === "kill" && kindMatches(objective.creatures, record.kind)) advance(player, def, active, index);
          // A quest drop, for each who needs it (counted, not carried: QUESTS.md, *As built*).
          else if (objective.kind === "loot" && kindMatches(objective.from, record.kind) && random() < objective.chance) advance(player, def, active, index);
          // A dropped quest item: in the corpse's loot for this player alone, if the roll says so; it counts once taken.
          else if (objective.kind === "drop" && kindMatches(objective.from, record.kind) && random() < Math.min(1, objective.chance * quests.dropChance)) world.drop(player, record.creature, objective.item, bindOf(def));
        }
      }
    },
    combatEvents(events) {
      for (const event of events) {
        if (event.kind !== EVENT_KIND.castDone) continue;
        const player = world.entity(event.source);
        const target = world.entity(event.target);
        if (!player || !target || !parts.has(player.id)) continue;
        const skill = rules.skills[event.skill]?.id;
        for (const { def, active, objective, index } of [...openObjectives(player)]) {
          if (objective.kind !== "use" || world.useSkill(objective.item) !== skill) continue;
          // Only the item that is this quest line's own counts, not a similar one from another.
          const used = lastUsed.get(player.id);
          if (!used || used.type !== objective.item || used.bind !== bindOf(def)) continue;
          const kind = target.creature?.kind.id;
          if (!kind || !kindMatches(objective.on, kind)) continue;
          const health = target.resources ? target.resources.current[rules.health] / Math.max(1, target.resources.max[rules.health]) : 1;
          if (health > objective.below) continue;
          advance(player, def, active, index);
        }
      }
    },
    step() {
      const now = world.time();
      if (now < nextLook) return;
      nextLook = now + LOOK_EVERY;
      for (const [id, part] of parts) {
        const player = world.entity(id);
        if (!player) {
          parts.delete(id);
          lastUsed.delete(id);
          continue;
        }
        for (const active of part.active.values()) {
          const def = defs.get(active.id);
          if (!def) continue;
          // Out of time: failed, and nothing else (QUESTS.md, *Failing and abandoning*).
          if (def.within > 0 && active.state === "active" && now - active.accepted > def.within) {
            active.state = "failed";
            send(player, def.id, active);
          }
        }
        for (const { def, active, objective, index } of [...openObjectives(player)]) {
          if (objective.kind !== "reach" || objective.area.dimension !== player.dimension) continue;
          if (Math.hypot(player.x - objective.area.x, player.z - objective.area.z) <= objective.area.radius) advance(player, def, active, index);
        }
      }
      stepObjects(now);
    },
  };
}
