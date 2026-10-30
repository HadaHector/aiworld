import type { Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import { rollLoot, type ItemRules } from "../rules/itemRules";
import { statValues } from "../stats";
import { hashString } from "../../world/content/dimensions";
import { deriveSeed, mulberry32 } from "../../world/rng";
import { EVENT_KIND, type CombatEvent } from "../skills/events";
import { createItemStore, type ItemInstance, type ItemStore, type LootPart, type Refusal, type SlotRef } from "./items";
import {
  createBelongings,
  equipItem,
  giveItem,
  moveItem,
  receiveItem,
  repairAll,
  takeOut,
  unequipItem,
  useItem,
  wearArmour,
  wearOnDeath,
  wearSlot,
  wearWeapon,
  wornGear,
  type ItemContext,
} from "./belongings";
import { NO_ITEM_HOOKS, type ItemHooks } from "./itemHooks";

/** The template a dropped item lies on the ground as (see ITEMS.md, *Loot*): the engine knows it by name. */
export const GROUND_ITEM_TEMPLATE = "groundItem";
/** `lootTake`'s slot for everything, money included. */
export const TAKE_ALL = 0xffff;

/** What the item system needs of the server. */
export interface ItemWorld {
  seed: number;
  time(): number;
  entity(id: number): Entity | undefined;
  entitiesIn(dimension: string): Iterable<Entity>;
  /** Makes an entity of a template on the ground at a point - an item dropped there. */
  spawn(dimension: string, template: string, x: number, z: number, facing: number): Entity | undefined;
  despawn(entity: Entity): void;
  /** Where an emptied chest's time to come back is kept, by its placement key, so a dimension loaded
   *  again does not refill it early (see CREATURES.md, *Death, corpses and respawn*). */
  delta?: { get(key: string): number | undefined; set(key: string, until: number): void };
  /** The first item id to give: the saved world's next one, so ids stay unique from run to run. */
  firstItemId?: number;
}

/**
 * Items on the server (see ITEMS.md): the store, every player's belongings, loot in corpses, chests
 * and on the ground, and what clients may ask of them. Each request returns why it did not happen,
 * or "" when it did; the server tells the client so.
 */
export interface ItemSystem {
  readonly store: ItemStore;
  readonly ctx: ItemContext;
  /** A new entity gets what its template's `items` says: belongings and start items, or loot. */
  adopt(entity: Entity): void;
  /** Loot rolled at 0 health, emptied chests coming back, items on the ground expiring, and who is
   *  in reach of a strongbox or of the loot they have open. */
  step(dimensions: Iterable<{ id: string; entities: Map<number, Entity> }>): void;
  /** Wear from what happened in fights this step: deaths, hits given and taken. */
  combatEvents(events: Iterable<{ event: CombatEvent }>): void;
  move(entity: Entity, from: SlotRef, to: SlotRef, count: number): Refusal;
  equip(entity: Entity, from: SlotRef): Refusal;
  unequip(entity: Entity, slot: number): Refusal;
  use(entity: Entity, from: SlotRef): Refusal;
  drop(entity: Entity, from: SlotRef, count: number): Refusal;
  pickUp(entity: Entity, target: number): Refusal;
  openLoot(entity: Entity, target: number): Refusal;
  takeLoot(entity: Entity, slot: number): Refusal;
  closeLoot(entity: Entity): void;
  repair(entity: Entity, free?: boolean): Refusal;
  /** Debug: makes `count` of a type in an entity's bag. Returns how many did not fit. */
  give(entity: Entity, type: number, count: number): number;
  /** Debug: wears an entity's gear as death or a hit would ("weapon" and "armour" always land). */
  wear(entity: Entity, what: "death" | "weapon" | "armour"): void;
  /** Whether an entity has loot to take, or a chest that would roll some when opened. */
  lootable(entity: Entity): boolean;
  /** Whether an entity holds loot that nobody has taken yet (a corpse not emptied). */
  hasLoot(entity: Entity): boolean;
  /** An entity is going: whatever its loot holds goes from the store with it. */
  release(entity: Entity): void;
}

export function createItemSystem(game: GameRules, items: ItemRules, world: ItemWorld, hooks: ItemHooks = NO_ITEM_HOOKS): ItemSystem {
  const store = createItemStore(world.firstItemId);
  const ctx: ItemContext = { game, items, store, hooks };
  // Chances - wear on a hit - from a stream of the world seed's; loot from each source's own.
  const chance = mulberry32(deriveSeed(world.seed >>> 0, hashString("items")));
  const anyRoll = mulberry32(deriveSeed(world.seed >>> 0, hashString("item rolls")));
  const roll32 = (random: () => number) => () => Math.floor(random() * 4294967296) >>> 0;

  const near = (a: Entity, b: Entity, range: number): boolean => a.dimension === b.dimension && Math.hypot(a.x - b.x, a.z - b.z) <= range;
  const hasContents = (loot: LootPart): boolean => loot.items.some((id) => id != null) || loot.money.some((m) => m > 0);
  const updateGear = (entity: Entity): void => {
    if (entity.belongings) entity.gear = wornGear(ctx, entity.belongings);
  };
  const after = (entity: Entity, why: Refusal): Refusal => {
    updateGear(entity);
    return why;
  };

  /** Rolls an entity's loot table into it (see ITEMS.md, *Loot*): from the world seed, its key and
   *  how many times it has been rolled, with its own stats and its looter's for conditions. */
  function rollInto(entity: Entity, looter: Entity | undefined): void {
    const def = items.entities.get(entity.template.id);
    const loot = entity.loot;
    if (!def?.loot || !loot) return;
    const base = deriveSeed(world.seed >>> 0, hashString(entity.key || `#${entity.id}`));
    const random = mulberry32(deriveSeed(base, ++loot.rolls));
    const context = new Float64Array(game.stats.length * 2);
    if (entity.stats) context.set(statValues(entity.stats));
    if (looter?.stats) context.set(statValues(looter.stats), game.stats.length);
    loot.items = [];
    loot.money = new Array<number>(items.currencies.length).fill(0);
    for (const drop of rollLoot(items, def.loot, context, random)) {
      if ("currency" in drop) {
        loot.money[drop.currency] += drop.amount;
        continue;
      }
      const type = items.types[drop.type];
      for (let left = drop.count; left > 0; left -= type.stack) {
        loot.items.push(store.make(drop.type, Math.min(left, type.stack), roll32(random)(), type.durability).id);
      }
    }
    loot.rolled = true;
  }

  /** Who a corpse's loot counts as rolled for: the top of its threat table, if it keeps one. */
  function looterOf(entity: Entity): Entity | undefined {
    // The dead have no table left: who was on it when it died.
    if (entity.combat?.dead && entity.combat.killers.length > 0) return world.entity(entity.combat.killers[0]);
    let best: Entity | undefined;
    let most = -Infinity;
    for (const [id, entry] of entity.combat?.threat ?? []) {
      if (entry.amount > most) {
        most = entry.amount;
        best = world.entity(id);
      }
    }
    return best;
  }

  /** Loot has been taken: an emptied chest waits to come back, an emptied item on the ground goes. */
  function taken(source: Entity): void {
    const loot = source.loot!;
    if (hasContents(loot)) return;
    loot.items = [];
    const def = items.entities.get(source.template.id);
    if (def?.container) {
      loot.rolled = false;
      loot.respawnAt = world.time() + def.respawn;
      if (source.key) world.delta?.set(source.key, loot.respawnAt);
    } else if (source.template.id === GROUND_ITEM_TEMPLATE) {
      world.despawn(source);
    }
  }

  /** Takes one slot of a source's loot into an entity's bag, or as much of it as fits. */
  function takeSlot(entity: Entity, source: Entity, slot: number): Refusal {
    const loot = source.loot!;
    const id = loot.items[slot];
    if (id == null) return "empty";
    const item = store.get(id)!;
    const { left, why } = receiveItem(ctx, entity, item);
    if (left === 0) loot.items[slot] = null;
    return left === 0 ? "" : why;
  }

  function takeMoney(entity: Entity, source: Entity): void {
    const loot = source.loot!;
    loot.money.forEach((amount, currency) => {
      entity.belongings!.wallet[currency] += amount;
      loot.money[currency] = 0;
    });
  }

  /** The source of the loot an entity has open, if it is still there and in reach. */
  function openSource(entity: Entity): Entity | undefined {
    const b = entity.belongings;
    const source = b && b.lootOpen ? world.entity(b.lootOpen) : undefined;
    return source?.loot && near(entity, source, items.config.lootRange + 1) ? source : undefined;
  }

  const system: ItemSystem = {
    store,
    ctx,
    adopt(entity) {
      const def = items.entities.get(entity.template.id);
      if (!def) return;
      if (def.bag > 0 || def.bank > 0) {
        entity.belongings = createBelongings(items, def.bag, def.bank);
        for (const { type, count } of def.start) giveItem(ctx, entity, type, count, roll32(anyRoll));
        // What can be worn is worn.
        entity.belongings.bag.forEach((id, slot) => {
          if (id != null && items.types[store.get(id)!.type].slots.length > 0) equipItem(ctx, entity, { container: 0, slot });
        });
        updateGear(entity);
      }
      if (def.loot) entity.loot = { items: [], money: new Array<number>(items.currencies.length).fill(0), rolled: false, armed: true, rolls: 0, respawnAt: 0, expires: Infinity };
      // A chest emptied before its dimension was last unloaded stays empty until its time.
      if (def.container && entity.loot && entity.key) entity.loot.respawnAt = world.delta?.get(entity.key) ?? 0;
    },

    step(dimensions) {
      const now = world.time();
      for (const dimension of dimensions) {
        const bankers: Entity[] = [];
        const players: Entity[] = [];
        for (const entity of dimension.entities.values()) {
          if (entity.belongings) players.push(entity);
          if (items.entities.get(entity.template.id)?.banker) bankers.push(entity);
          const loot = entity.loot;
          if (!loot) continue;
          if (loot.expires <= now) {
            for (const id of loot.items) if (id != null) store.remove(id);
            loot.items = [];
            world.despawn(entity);
            continue;
          }
          // Loot at 0 health: rolled once, and again only after it has been emptied and the entity
          // has come back above 0 (the dummy, which does not die).
          const def = items.entities.get(entity.template.id);
          if (!def || def.container || !entity.resources) continue;
          const health = entity.resources.current[game.health];
          if (health > 0) {
            if (!hasContents(loot)) loot.armed = true;
          } else if (loot.armed) {
            loot.armed = false;
            rollInto(entity, looterOf(entity));
          }
        }
        for (const player of players) {
          const b = player.belongings!;
          b.bankOpen = bankers.some((banker) => near(player, banker, items.config.bankRange));
          // Out of reach, gone, or emptied: the window closes.
          const source = b.lootOpen ? openSource(player) : undefined;
          if (b.lootOpen && (!source || !hasContents(source.loot!))) b.lootOpen = 0;
        }
      }
    },

    combatEvents(events) {
      for (const { event } of events) {
        if (event.kind === EVENT_KIND.death) {
          const target = world.entity(event.target);
          if (target?.belongings) wearOnDeath(ctx, target);
        } else if (event.kind === EVENT_KIND.hit) {
          const source = world.entity(event.source);
          const target = world.entity(event.target);
          if (source?.belongings) wearWeapon(ctx, source, chance);
          if (target?.belongings) wearArmour(ctx, target, chance);
        }
      }
    },

    move: (entity, from, to, count) => after(entity, moveItem(ctx, entity, from, to, count)),
    equip: (entity, from) => after(entity, equipItem(ctx, entity, from)),
    unequip: (entity, slot) => after(entity, unequipItem(ctx, entity, slot)),
    use: (entity, from) => after(entity, useItem(ctx, entity, from)),

    drop(entity, from, count) {
      if (!entity.belongings) return "cannot";
      if (!game.templates.has(GROUND_ITEM_TEMPLATE)) return "cannot";
      const out = takeOut(ctx, entity, from, count);
      if (typeof out === "string") return out;
      const item: ItemInstance = out;
      const x = entity.x + Math.sin(entity.facing) * 0.8;
      const z = entity.z + Math.cos(entity.facing) * 0.8;
      const ground = world.spawn(entity.dimension, GROUND_ITEM_TEMPLATE, x, z, entity.facing);
      if (!ground) return after(entity, "cannot");
      ground.name = items.types[item.type].name;
      ground.loot = { items: [item.id], money: new Array<number>(items.currencies.length).fill(0), rolled: true, armed: false, rolls: 0, respawnAt: 0, expires: world.time() + items.config.groundLifetime };
      return after(entity, "");
    },

    pickUp(entity, target) {
      const source = world.entity(target);
      if (!entity.belongings || !source?.loot || source.template.id !== GROUND_ITEM_TEMPLATE) return "cannot";
      if (!near(entity, source, items.config.pickUpRange)) return "range";
      let why: Refusal = "";
      source.loot.items.forEach((_, slot) => {
        const r = takeSlot(entity, source, slot);
        if (r && r !== "empty") why = r;
      });
      taken(source);
      return after(entity, why);
    },

    openLoot(entity, target) {
      const source = world.entity(target);
      if (!entity.belongings || !source?.loot) return "cannot";
      if (!near(entity, source, items.config.lootRange)) return "range";
      const def = items.entities.get(source.template.id);
      if (def?.container && !source.loot.rolled) {
        if (world.time() < source.loot.respawnAt) return "empty";
        rollInto(source, entity);
      }
      entity.belongings.lootOpen = source.id;
      return "";
    },

    takeLoot(entity, slot) {
      const source = openSource(entity);
      if (!source) return "range";
      let why: Refusal = "";
      if (slot === TAKE_ALL) {
        takeMoney(entity, source);
        source.loot!.items.forEach((_, i) => {
          const r = takeSlot(entity, source, i);
          if (r && r !== "empty") why = r;
        });
      } else {
        why = takeSlot(entity, source, slot);
      }
      taken(source);
      return after(entity, why);
    },

    closeLoot(entity) {
      if (entity.belongings) entity.belongings.lootOpen = 0;
    },

    repair: (entity, free = false) => after(entity, repairAll(ctx, entity, free)),

    give(entity, type, count) {
      if (!entity.belongings || !items.types[type]) return count;
      const left = giveItem(ctx, entity, type, count, roll32(anyRoll));
      updateGear(entity);
      return left;
    },

    wear(entity, what) {
      if (what === "death") wearOnDeath(ctx, entity);
      else if (what === "weapon") {
        const main = items.slotIndex.get("mainHand");
        if (main !== undefined) wearSlot(ctx, entity, main, Math.max(1, items.config.wear.onHit) * 10);
      } else {
        entity.belongings?.equipment.forEach((id, slot) => {
          if (id != null && slot !== items.slotIndex.get("mainHand")) wearSlot(ctx, entity, slot, Math.max(1, items.config.wear.onHitTaken) * 10);
        });
      }
    },

    hasLoot: (entity) => !!entity.loot && hasContents(entity.loot),
    release(entity) {
      const loot = entity.loot;
      if (!loot) return;
      for (const id of loot.items) if (id != null) store.remove(id);
      loot.items = [];
    },
    lootable(entity) {
      const loot = entity.loot;
      if (!loot) return false;
      if (hasContents(loot)) return true;
      const def = items.entities.get(entity.template.id);
      return !!def?.container && !loot.rolled && world.time() >= loot.respawnAt;
    },
  };
  return system;
}
