import type { GameRules, TemplateDef } from "./rules/gameRules";
import { createStatBlock, statValue, type StatBlock } from "./stats";
import { createResourceBlock, stepResourceBlock, tickPhase, type ResourceBlock } from "./resources";
import type { PlayerBody } from "./playerBody";
import type { EntityAppearance } from "./protocol";
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
  /** Set by debug now, by the ability system later: which regen rates apply. */
  inCombat: boolean;
  stats?: StatBlock;
  resources?: ResourceBlock;
  /** A capsule walking the dimension's collision: players now, creatures that walk later. */
  body?: PlayerBody | null;
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
  }
  return entity;
}

/** One step of every entity's regen and decay. */
export function stepResources(entities: Iterable<Entity>, deltaSeconds: number): void {
  for (const entity of entities) {
    if (entity.stats && entity.resources) stepResourceBlock(entity.resources, entity.stats, entity.inCombat, deltaSeconds);
  }
}

/** A stat of an entity by id, or a fallback when it has no such stat or no stats. */
export function entityStat(rules: GameRules, entity: Entity, id: string, fallback: number): number {
  const index = rules.statIndex.get(id);
  return entity.stats && index !== undefined ? statValue(entity.stats, index) : fallback;
}
