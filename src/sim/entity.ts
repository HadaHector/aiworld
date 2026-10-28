import type { GameRules, TemplateDef } from "./rules/gameRules";
import { createStatBlock, statValue, type StatBlock } from "./stats";
import { createResourceBlock, stepResourceBlock, tickPhase, type ResourceBlock } from "./resources";
import type { PlayerBody } from "./playerBody";
import type { EntityAppearance } from "./protocol";
import type { CombatPart } from "./skills/types";
import type { Belongings, LootPart } from "./items/items";
import type { CreaturePart } from "./creatures/creature";
import type { ProgressPart } from "./progression/progress";
import { createCombatPart } from "./skills/unit";
import { hashString } from "../world/content/dimensions";

/**
 * Anything in a dimension the server keeps track of: a player, a creature, an NPC, a node, a chest
 * (see ENTITIES.md). An id, where it is, its template, and the parts it is built from - each one
 * optional, each its own module. Systems are functions over the entities that have a part.
 */
export interface Entity {
  /** Unique on the server for its run, never reused. */
  readonly id: number;
  readonly template: TemplateDef;
  name: string;
  /** Who it is to look at, over its template's look: sent in its spawn, so every client draws the
   *  same character. */
  look: EntityAppearance;
  /** The dimension it is in - for a player, the one it is in or on its way to. */
  dimension: string;
  /** For an entity a dimension places: `<dimension>/<index>`, stable from run to run - what the
   *  world delta will key it by. Empty for others. */
  readonly key: string;
  /** Its feet. */
  x: number;
  y: number;
  z: number;
  /** Radians about y, 0 facing +z. */
  facing: number;
  grounded: boolean;
  /** Whether it is fighting - which regen rates apply. Worked out by the skill system each step from
   *  threat and hostile acts (see ABILITIES.md, *Threat*). */
  inCombat: boolean;
  stats?: StatBlock;
  resources?: ResourceBlock;
  /** What it knows, what runs on it, its flags and threat (see ABILITIES.md): every entity with stats. */
  combat?: CombatPart;
  /** A capsule walking the dimension's collision: players now, creatures that walk later. */
  body?: PlayerBody | null;
  /** Its kind, spawn point and brain (see CREATURES.md): a creature's. */
  creature?: CreaturePart;
  /** Its bag, bank, equipment and wallet (see ITEMS.md): a player's. */
  belongings?: Belongings;
  /** What it holds for others to take: a corpse's loot, a chest's, an item on the ground. */
  loot?: LootPart;
  /** The item types it shows on its body, from what it wears (ITEMS.md, *Equipment*) - sent to
   *  everyone who sees it. Left out for an entity without belongings: its template's outfit shows. */
  gear?: string[];
  /** Its origins, disciplines, talents and what it has learned (see PROGRESSION.md): a player's. */
  progress?: ProgressPart;
}

export interface EntityPlace {
  dimension: string;
  x: number;
  y: number;
  z: number;
  facing: number;
  key?: string;
  /** Its own name, over the template's - a player's. */
  name?: string;
  /** Its own look - a player's; else its seed comes from its key, or its id when it has none. */
  look?: EntityAppearance;
}

/** An entity as its template makes it: stats and resources if the template has them, all at their
 *  start. No body: whoever makes one gives it one. */
export function createEntity(rules: GameRules, template: TemplateDef, id: number, place: EntityPlace): Entity {
  const entity: Entity = {
    id,
    template,
    name: place.name ?? template.name,
    look: place.look ?? { seed: hashString(place.key || `#${id}`), race: "", outfit: "", sex: "" },
    dimension: place.dimension,
    key: place.key ?? "",
    x: place.x,
    y: place.y,
    z: place.z,
    facing: place.facing,
    grounded: true,
    inCombat: false,
  };
  if (template.hasStats) {
    entity.stats = createStatBlock(rules, template);
    entity.resources = createResourceBlock(rules, template, entity.stats, tickPhase(id));
    entity.combat = createCombatPart(template.threat);
  }
  return entity;
}

/** One step of every entity's regen and decay - none for the dead (see ABILITIES.md, *Death*). */
export function stepResources(entities: Iterable<Entity>, deltaSeconds: number): void {
  for (const entity of entities) {
    if (entity.combat?.dead) continue;
    if (entity.stats && entity.resources) stepResourceBlock(entity.resources, entity.stats, entity.inCombat, deltaSeconds);
  }
}

/** A stat of an entity by id, or a fallback when it has no such stat or no stats. */
export function entityStat(rules: GameRules, entity: Entity, id: string, fallback: number): number {
  const index = rules.statIndex.get(id);
  return entity.stats && index !== undefined ? statValue(entity.stats, index) : fallback;
}
