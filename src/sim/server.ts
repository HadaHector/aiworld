import { dimensionSeed, type DimensionDef } from "../world/content/dimensions";
import { createDimension, type Dimension, type DimensionWorld } from "./dimension";
import type { BodyInput } from "./playerBody";
import { PROTOCOL_VERSION, cleanChoices, type ClientMessage, type EntityAppearance, type ServerMessage } from "./protocol";
import { createReplicator, type Replicator } from "./replication";
import { addModifier, removeSource } from "./stats";
import { restore } from "./resources";
import type { ServerEnd } from "./channel";
import { PLAYER_TEMPLATE, type GameRules } from "./rules/gameRules";
import { createEntity, entityStat, stepResources, type Entity } from "./entity";
import { createSkillSystem, type SkillSystem } from "./skills/system";
import { canMove } from "./skills/flags";
import { Layers } from "../world/collision/shapes";
import type { ItemRules } from "./rules/itemRules";
import { createItemSystem, type ItemSystem } from "./items/itemSystem";
import { createItemReplicator, type ItemReplicator } from "./items/itemReplication";
import { handleItemMessage } from "./items/itemMessages";
import type { ItemHooks } from "./items/itemHooks";
import type { CreatureRules } from "./rules/creatureRules";
import { createCreatureSystem, type CreatureSystem, type KillRecord } from "./creatures/system";
import { createWorldDelta, type WorldDelta } from "./creatures/worldDelta";
import type { ProgressionRules } from "./rules/progressionRules";
import { createProgressionSystem, type ProgressionSystem } from "./progression/system";
import type { ProgressEvent } from "./progression/progress";
import { progressMessages } from "./progression/replication";
import { EVENT_KIND } from "./skills/events";
import { exportBelongings, importBelongings } from "./items/save";
import { startingPlace } from "./spawn";
import type { SaveStore } from "../save/store";
import { SAVE_VERSION, makeSaveId, nameProblem, tidyName, type CharacterRecord, type CharacterSummary, type WorldRecord } from "../save/records";

/** Each step spends at most this long bringing in collision chunks per dimension (always at least one). */
const CHUNK_BUDGET_MS = 2;

/** One connected client and the player it plays. */
interface Connection {
  end: ServerEnd;
  player: Player | null;
  /** What this client has been told of the entities around its player. */
  replicator: Replicator;
  /** ...and of items: its own, and the gear and loot of what it sees (null without item rules). */
  items: ItemReplicator | null;
  /** Whether it has been told its player's whole progress since it arrived somewhere. */
  progressSent: boolean;
  /** Choosing a character (a Hello that selects, or after a logout), with none in the world. */
  selecting: boolean;
  /** A character being read from the store, to enter. */
  entering: boolean;
}

/** A connected player: its entity, and what its client has said. */
export interface Player {
  /** Its entity: made on Hello, kept until it leaves, from one dimension to the next. Its `body` is
   *  null while travelling - from a Transfer until its client has Arrived and the dimension is loaded. */
  readonly entity: Entity;
  /** Where the body goes once it can be made. */
  arrival: { x: number; z: number };
  /** Whether the client has said Arrived since the last Transfer. */
  arrived: boolean;
  /** The latest intent; a jump stays set until a step takes it. */
  input: BodyInput;
  ackSeq: number;
  /** The saved character it plays - null for a quick, unsaved one. */
  character: CharacterRecord | null;
  /** Seconds in the world since its record was last brought up to date. */
  playing: number;
}

/** A dimension the server has asked its host for: loading, then loaded. */
interface Slot {
  dimension: Dimension | null;
  /** Set when nobody wants it any more: a load still running is thrown away when it finishes. */
  dropped: boolean;
}

export interface ServerOptions {
  /** The world seed: the start dimension's own, and the root of every other's (see DIMENSIONS.md). */
  seed: number;
  /** Which world config the server runs, by name - told to every client that joins. */
  config: string;
  /** Which packs it runs, by id - told to every client that joins. */
  packs?: string[];
  /** Every dimension the config keeps. */
  dimensions: readonly DimensionDef[];
  /** Stats, resources and entity templates (see ENTITIES.md). */
  rules: GameRules;
  /**
   * Makes a dimension's world, when the first player heads for it. The host's: in Node, it resolves
   * the dimension's content from disk and generates it; in the page, it hands over the page's own
   * build of it, so nothing is generated twice.
   */
  loadDimension: (definition: DimensionDef, seed: number) => DimensionWorld | Promise<DimensionWorld>;
  /** Called when a load fails; the players waiting for it stay waiting. */
  onLoadError?: (definition: DimensionDef, error: unknown) => void;
  /** Item types, slots, currencies and loot (see ITEMS.md); left out, nobody has items. */
  items?: ItemRules;
  /** How items cast skills - the ability system's own hooks unless a host says otherwise. */
  itemHooks?: ItemHooks;
  /** Creature kinds, rosters and spawning (see CREATURES.md); left out, no creatures spawn. */
  creatures?: CreatureRules;
  /** Called for every creature killed - what progression turns into XP (CREATURES.md, *Kills and XP*). */
  onKill?: (kill: KillRecord) => void;
  /** Disciplines, origins and talents (see PROGRESSION.md); left out, players are made from the
   *  `player` template and nobody gains XP. */
  progression?: ProgressionRules;
  /** Where the world and its characters are saved (FRONTEND.md, *Saves*); left out, only quick
   *  characters play and nothing is kept. */
  saves?: ServerSaves;
}

export interface ServerSaves {
  store: SaveStore;
  /** The world, as read from the store: its clock, delta and item ids carry on from where it was. */
  world: WorldRecord;
  /** Seconds of world time between autosaves; 30 if left out. */
  interval?: number;
  /** A write that failed, or ids a load skipped - the host says where it goes. */
  onProblem?: (message: string) => void;
}

export interface Server {
  /** Takes a client: it says Hello, and is a player from the next step. */
  connect: (end: ServerEnd) => void;
  /** Reads every client's messages, moves every player, and sends each client a snapshot. */
  step: (deltaSeconds: number) => void;
  readonly tick: number;
  /** For hosts and debugging - not for clients, which only see messages. */
  readonly debug: {
    readonly rules: GameRules;
    /** The dimensions loaded now, by id. */
    readonly dimensions: ReadonlyMap<string, Dimension>;
    /** Every connected player, by its entity's id. */
    readonly players: ReadonlyMap<number, Player>;
    /** Any entity by id - a player's (wherever it is), or one in a loaded dimension. */
    entity: (id: number) => Entity | undefined;
    /** The ability system (ABILITIES.md). */
    readonly skills: SkillSystem;
    /** The item system (ITEMS.md), null without item rules. */
    readonly items: ItemSystem | null;
    /** The creature system (CREATURES.md), null without creature rules. */
    readonly creatures: CreatureSystem | null;
    /** What has been cleared or emptied, until when (GAMEPLAY.md, *World delta*). */
    readonly delta: WorldDelta;
    /** The progression system (PROGRESSION.md), null without progression rules. */
    readonly progression: ProgressionSystem | null;
    /** The latest progress events, by character (the last 256). */
    readonly progressEvents: { entity: number; event: ProgressEvent }[];
  };
  /** The server's clock: seconds stepped since it started - or since the saved world began. */
  readonly time: number;
  /** Saves every character in the world and the world itself now: when a page is hidden, or a
   *  dedicated server is told to stop. Resolves once written. */
  save: () => Promise<void>;
}

/**
 * The simulation: the players, the dimensions they are in, the entities in those (see ENTITIES.md),
 * and each dimension's collision around them (see DIMENSIONS.md). A dimension is loaded when the
 * first player heads for it and dropped when the last one leaves. Everything it knows comes from its
 * host (the seed, the packs, the worlds it is handed) and from its clients' messages; everything it
 * tells them goes out as messages. No Babylon, no browser: the same server runs inside the page for
 * single player and on its own in Node (see SIMULATION.md).
 */
export function createServer(options: ServerOptions): Server {
  const { rules } = options;
  const definitions = new Map(options.dimensions.map((def) => [def.id, def]));
  const start = options.dimensions.find((def) => def.start) ?? options.dimensions[0];
  if (!start) throw new Error("A server needs at least one dimension");
  const playerTemplate = rules.templates.get(PLAYER_TEMPLATE);
  if (!playerTemplate) throw new Error(`The game rules have no "${PLAYER_TEMPLATE}" template`);

  const connections: Connection[] = [];
  const players = new Map<number, Player>();
  const slots = new Map<string, Slot>();
  const loaded = new Map<string, Dimension>();
  let nextId = 1;
  let tick = 0;
  const saves = options.saves ?? null;
  const world = saves?.world ?? null;
  let time = world?.time ?? 0;
  const delta = createWorldDelta(() => time);
  for (const [key, until] of world?.delta ?? []) if (until > time) delta.set(key, until);

  /** Any entity by id: a player's wherever it is, or one in a loaded dimension. */
  function findEntity(id: number): Entity | undefined {
    const player = players.get(id);
    if (player) return player.entity;
    for (const dimension of loaded.values()) {
      const entity = dimension.entities.get(id);
      if (entity) return entity;
    }
    return undefined;
  }

  /** Makes an entity of a template standing on the ground at a point, with its spells. */
  function spawnIn(dimension: Dimension, template: string, x: number, z: number, facing: number, key?: string): Entity | undefined {
    const def = rules.templates.get(template);
    if (!def) return undefined;
    const id = nextId++;
    const entity = createEntity(rules, def, id, { dimension: dimension.id, x, y: dimension.groundAt(x, z), z, facing, key });
    dimension.entities.set(id, entity);
    skills.adopt(entity);
    itemSystem?.adopt(entity);
    return entity;
  }

  const skills = createSkillSystem(rules, {
    seed: options.seed,
    time: () => time,
    tick: () => tick,
    entity: findEntity,
    entitiesIn: (dimension) => loaded.get(dimension)?.entities.values() ?? [],
    lineOfSight(dimension, from, to) {
      const world = loaded.get(dimension)?.collision.world;
      if (!world) return true;
      const eye = (e: Entity) => Math.min(rules.combat.losHeight, e.template.look.height * 0.9);
      const origin = { x: from.x, y: from.y + eye(from), z: from.z };
      const dx = to.x - from.x;
      const dy = to.y + eye(to) - origin.y;
      const dz = to.z - from.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance < 1e-6) return true;
      return !world.raycastAny(origin, { x: dx / distance, y: dy / distance, z: dz / distance }, distance, Layers.sight);
    },
    spawn: (dimension, template, x, z, facing) => {
      const dim = loaded.get(dimension);
      return dim ? spawnIn(dim, template, x, z, facing) : undefined;
    },
    despawn: (entity) => {
      skills.leave(entity, true);
      loaded.get(entity.dimension)?.entities.delete(entity.id);
    },
    push(entity, motion) {
      if (motion.to) {
        if (entity.body) {
          entity.body.teleport(motion.to.x, motion.to.z);
          follow(entity);
        } else {
          entity.x = motion.to.x;
          entity.z = motion.to.z;
        }
        return;
      }
      if (entity.body) entity.body.push(motion);
      else {
        // No body to carry it: it lands where the motion would have taken it.
        let t = motion.duration;
        const speed = Math.max(Math.hypot(motion.vx, motion.vz), 1e-6);
        if (motion.stopAt) t = Math.min(t, Math.max(0, Math.hypot(motion.stopAt.x - entity.x, motion.stopAt.z - entity.z) - motion.stopAt.within) / speed);
        entity.x += motion.vx * t;
        entity.z += motion.vz * t;
        const dimension = loaded.get(entity.dimension);
        if (dimension) entity.y = dimension.groundAt(entity.x, entity.z);
      }
    },
  });

  const progression: ProgressionSystem | null = options.progression
    ? createProgressionSystem(rules, options.progression, skills, {
        entity: findEntity,
        mainHand(entity) {
          const slot = options.items?.slotIndex.get("mainHand");
          const id = slot === undefined ? null : entity.belongings?.equipment[slot];
          const item = id == null ? undefined : itemSystem?.store.get(id);
          return item ? options.items!.types[item.type] : null;
        },
        pay(entity, amount) {
          const wallet = entity.belongings?.wallet;
          const main = options.items?.main;
          if (!wallet || main === undefined || wallet[main] < amount) return false;
          wallet[main] -= amount;
          return true;
        },
      })
    : null;
  const progressEvents: { entity: number; event: ProgressEvent }[] = [];

  const itemSystem: ItemSystem | null = options.items
    ? createItemSystem(
        rules,
        options.items,
        {
          seed: options.seed,
          time: () => time,
          entity: findEntity,
          entitiesIn: (dimension) => loaded.get(dimension)?.entities.values() ?? [],
          spawn: (dimension, template, x, z, facing) => {
            const dim = loaded.get(dimension);
            return dim ? spawnIn(dim, template, x, z, facing) : undefined;
          },
          despawn: (entity) => {
            skills.leave(entity, true);
            loaded.get(entity.dimension)?.entities.delete(entity.id);
          },
          delta,
          firstItemId: world?.nextItemId,
        },
        progression ? progression.itemHooks(options.itemHooks ?? skills.items) : (options.itemHooks ?? skills.items),
      )
    : null;

  /** The players standing in a dimension. */
  const playersIn = (id: string): Entity[] => [...players.values()].filter((p) => p.entity.dimension === id && p.entity.body).map((p) => p.entity);

  const creatureSystem: CreatureSystem | null = options.creatures
    ? createCreatureSystem(rules, options.creatures, skills, {
        seed: options.seed,
        time: () => time,
        entity: findEntity,
        spawn: (dimension, template, x, z, facing, key) => {
          const dim = loaded.get(dimension);
          return dim ? spawnIn(dim, template, x, z, facing, key) : undefined;
        },
        despawn: (entity) => {
          skills.leave(entity, true);
          itemSystem?.release(entity);
          loaded.get(entity.dimension)?.entities.delete(entity.id);
        },
        playersIn,
        killed: (kill) => progression?.kill(kill),
        lineOfSight: (dimension, from, to) => skills.sys.world.lineOfSight(dimension, from, to),
        hasLoot: (entity) => itemSystem?.hasLoot(entity) ?? false,
        delta,
      })
    : null;

  /** Makes the entities a dimension's definition places, standing on its ground. */
  function placeEntities(dimension: Dimension, definition: DimensionDef): void {
    definition.entities.forEach((placed, i) => {
      const template = rules.templates.get(placed.template);
      if (!template) return; // checked when the rules were loaded (checkPlacements)
      spawnIn(dimension, template.id, placed.at.x, placed.at.z, placed.facing, `${dimension.id}/${i}`);
    });
  }

  /** Asks the host for a dimension, unless it is loaded or on its way. */
  function want(id: string): void {
    if (slots.has(id)) return;
    const definition = definitions.get(id)!;
    const slot: Slot = { dimension: null, dropped: false };
    slots.set(id, slot);
    Promise.resolve()
      .then(() => options.loadDimension(definition, dimensionSeed(options.seed, definition)))
      .then(
        (world) => {
          if (slot.dropped) return;
          slot.dimension = createDimension(id, world);
          placeEntities(slot.dimension, definition);
          creatureSystem?.load(slot.dimension, definition);
          loaded.set(id, slot.dimension);
        },
        (error) => {
          if (slots.get(id) === slot) slots.delete(id);
          options.onLoadError?.(definition, error);
        },
      );
  }

  /** Drops a dimension nobody is in or heading for - and every entity in it. */
  function release(id: string): void {
    for (const player of players.values()) if (player.entity.dimension === id) return;
    const slot = slots.get(id);
    if (!slot) return;
    slot.dropped = true;
    slots.delete(id);
    loaded.delete(id);
    creatureSystem?.unload(id);
  }

  /** Takes a player out of where it is and sends it to a dimension, at a point. */
  function transfer(connection: Connection, player: Player, to: DimensionDef, at: { x: number; z: number }): void {
    const entity = player.entity;
    const from = entity.dimension;
    skills.leave(entity);
    loaded.get(from)?.entities.delete(entity.id);
    entity.dimension = to.id;
    entity.body = null;
    player.arrival = at;
    player.arrived = false;
    player.input = { moveX: 0, moveZ: 0, run: false, jump: false };
    want(to.id);
    if (from !== to.id) release(from);
    // The client clears what it knows of entities on a Transfer; so does what tells it of them.
    connection.replicator.reset();
    connection.items?.reset();
    connection.progressSent = false;
    connection.end.send({ type: "transfer", dimension: to.id, seed: dimensionSeed(options.seed, to), x: at.x, z: at.z });
  }

  const pointsIn = (id: string): { x: number; z: number }[] =>
    [...players.values()].filter((p) => p.entity.dimension === id && p.entity.body).map((p) => ({ x: p.entity.x, z: p.entity.z }));

  /** Copies a body's capsule into its entity's position. */
  function follow(entity: Entity): void {
    if (!entity.body) return;
    const { feet, grounded } = entity.body.motor.state;
    entity.x = feet.x;
    entity.y = feet.y;
    entity.z = feet.z;
    entity.facing = entity.body.facing;
    entity.grounded = grounded;
  }

  /** A debug command's target: the sender's own player for 0, else an entity in its dimension. */
  function targetOf(player: Player, id: number): Entity | undefined {
    return id === 0 || id === player.entity.id ? player.entity : loaded.get(player.entity.dimension)?.entities.get(id);
  }

  // --- Saves (FRONTEND.md, *Saves*) -------------------------------------------------------------

  /** Writes waiting or running, by what they write: each key's in order, one at a time. */
  const writing = new Map<string, Promise<void>>();
  let lastAutosave = time;
  const problem = (message: string): void => (saves?.onProblem ?? console.warn)(message);

  function queue(key: string, write: () => Promise<void>): Promise<void> {
    const next = (writing.get(key) ?? Promise.resolve()).then(write).catch((error: unknown) => problem(`Saving ${key} failed: ${String(error)}`));
    writing.set(key, next);
    void next.then(() => {
      if (writing.get(key) === next) writing.delete(key);
    });
    return next;
  }

  /** The world's record brought up to date and written. */
  function writeWorld(): Promise<void> {
    if (!saves || !world) return Promise.resolve();
    world.time = time;
    world.delta = delta.entries();
    world.nextItemId = itemSystem?.store.nextId ?? world.nextItemId;
    world.played = Date.now();
    const copy = structuredClone(world);
    return queue("world", () => saves.store.writeWorld(copy));
  }

  const levelOf = (entity: Entity): number => {
    const level = progression?.rules.config.level;
    return (level === undefined ? undefined : entity.progress?.disciplines.get(level)?.level) ?? 1;
  };

  /** A player's record brought up to date from its entity: progress, belongings, resources, where it is. */
  function capture(player: Player): CharacterRecord | null {
    const record = player.character;
    if (!record) return null;
    const entity = player.entity;
    record.progress = progression?.export(entity) ?? record.progress;
    if (itemSystem && entity.belongings) record.belongings = exportBelongings(itemSystem.ctx, entity);
    if (entity.resources) {
      record.resources = {};
      for (const index of entity.resources.has) record.resources[rules.resources[index].id] = entity.resources.current[index];
    }
    record.dead = entity.combat?.dead ?? false;
    // Travelling, it has no body yet: it is wherever it is headed.
    const at = entity.body ? { x: entity.x, z: entity.z } : player.arrival;
    record.travel = { ...record.travel, dimension: entity.dimension, x: at.x, z: at.z, facing: entity.facing };
    record.played = Date.now();
    record.playedSeconds += player.playing;
    player.playing = 0;
    const summary = world?.characters.find((c) => c.id === record.id);
    if (summary) Object.assign(summary, summaryOf(record, levelOf(entity), entity.gear ?? []));
    return record;
  }

  function summaryOf(record: CharacterRecord, level: number, gear: string[]): CharacterSummary {
    return { id: record.id, name: record.name, origins: { ...record.origins }, level, place: definitions.get(record.travel.dimension)?.name ?? record.travel.dimension, played: record.played, look: structuredClone(record.look), gear: [...gear] };
  }

  /** Writes a player's character as it is now; the client is told once it is written. */
  function writeCharacter(player: Player, connection?: Connection): Promise<void> {
    const record = capture(player);
    if (!saves || !world || !record) return Promise.resolve();
    const copy = structuredClone(record);
    return queue(`character ${record.id}`, () => saves.store.writeCharacter(world.id, copy)).then(() => {
      if (connection && !connection.end.closed) connection.end.send({ type: "saved" });
    });
  }

  /** Every character in the world and the world itself. */
  function saveAll(): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const connection of connections) if (connection.player?.character) writes.push(writeCharacter(connection.player, connection));
    writes.push(writeWorld());
    return Promise.all(writes).then(() => undefined);
  }

  // Summaries saved before they had looks get the record's when it is next written; until then, none.
  const characterList = (): ServerMessage => ({ type: "characters", list: (world?.characters ?? []).map((c) => ({ ...structuredClone(c), look: c.look ?? { seed: 0, race: "", outfit: "", sex: "" }, gear: c.gear ?? [] })) });

  /** A player goes from the world: its body, its things in the store, and its dimension if it was the last. */
  function removePlayer(player: Player): void {
    const entity = player.entity;
    skills.leave(entity);
    progression?.leave(entity);
    const b = entity.belongings;
    if (b && itemSystem) for (const list of [b.bag, b.bank, b.equipment]) for (const id of list) if (id != null) itemSystem.store.remove(id);
    players.delete(entity.id);
    loaded.get(entity.dimension)?.entities.delete(entity.id);
    release(entity.dimension);
  }

  /** Makes a character's entity from its record and puts it in the world where it was left. */
  function enterCharacter(connection: Connection, record: CharacterRecord, debugDimension: string): void {
    const origins = record.progress?.origins ?? record.origins;
    const chosen = progression?.originsFor(origins);
    const template = (chosen && rules.templates.get(chosen.template)) || playerTemplate!;
    const asked = definitions.get(debugDimension);
    const left = definitions.get(record.travel.dimension);
    const home = definitions.get(record.travel.home.dimension) ? record.travel.home : null;
    // Where it was left - at home if it left dead; the start's spawn if that dimension has gone.
    const to = asked ?? (record.dead && home ? definitions.get(home.dimension)! : left ?? start);
    const at = asked ? asked.spawn : record.dead && home ? home : left ? record.travel : start.spawn;
    const entity = createEntity(rules, template, nextId++, { dimension: "", x: at.x, y: 0, z: at.z, facing: asked ? 0 : record.travel.facing, name: record.name, look: cleanLook(record.look) });
    skills.adopt(entity);
    itemSystem?.adopt(entity);
    if (chosen) progression!.adopt(entity, chosen.origins);
    const skipped: string[] = [];
    if (record.progress && progression) skipped.push(...progression.import(entity, record.progress));
    if (record.belongings && itemSystem && entity.belongings) skipped.push(...importBelongings(itemSystem.ctx, entity, record.belongings));
    if (entity.resources && !record.dead) {
      for (const [id, value] of Object.entries(record.resources)) {
        const index = rules.resourceIndex.get(id);
        if (index === undefined || !entity.resources.has.includes(index)) continue;
        entity.resources.current[index] = Math.max(0, Math.min(entity.resources.max[index], Number(value) || 0));
      }
    }
    if (skipped.length > 0) problem(`${record.name}'s save names what the packs no longer have: ${skipped.join(", ")}`);
    const joined: Player = { entity, arrival: { x: at.x, z: at.z }, arrived: false, input: { moveX: 0, moveZ: 0, run: false, jump: false }, ackSeq: 0, character: record, playing: 0 };
    players.set(entity.id, joined);
    connection.player = joined;
    connection.selecting = false;
    connection.end.send({ type: "entered", playerId: entity.id, character: record.id, look: entity.look, interface: record.interface });
    transfer(connection, joined, to, { x: at.x, z: at.z });
  }

  /** Makes a character from what the client chose; why it will not do, or "" once it is saved. */
  function createCharacter(message: Extract<ClientMessage, { type: "characterCreate" }>): string {
    if (!saves || !world) return "Characters are not kept on this server.";
    const name = tidyName(String(message.name ?? ""));
    const why = nameProblem(name, world.characters.map((c) => c.name));
    if (why) return why;
    const requested = message.origins && typeof message.origins === "object" ? message.origins : {};
    const origins: Record<string, string> = {};
    if (progression) {
      const chosen = progression.originsFor(requested);
      for (const [slot, index] of chosen.origins) {
        const id = progression.rules.origins[index].id;
        // A slot given wrong falls to its default in originsFor: here it is refused instead.
        if (requested[slot] !== undefined && requested[slot] !== id) return `"${requested[slot]}" cannot be chosen as ${slot} with the rest.`;
        origins[slot] = id;
      }
    }
    const place = startingPlace(start, origins);
    const now = Date.now();
    const record: CharacterRecord = {
      version: SAVE_VERSION,
      id: makeSaveId(name, now),
      name,
      origins,
      look: cleanLook(message.look ?? { seed: 0, race: "", outfit: "", sex: "" }),
      created: now,
      played: now,
      playedSeconds: 0,
      progress: null,
      belongings: null,
      resources: {},
      dead: false,
      travel: { ...place, home: { dimension: place.dimension, x: place.x, z: place.z } },
      interface: "",
    };
    world.characters.push(summaryOf(record, 1, []));
    void queue(`character ${record.id}`, () => saves.store.writeCharacter(world.id, structuredClone(record)));
    void writeWorld();
    return "";
  }

  function handle(connection: Connection, message: ClientMessage): void {
    const player = connection.player;
    const body = player?.entity.body;
    // Items (see ITEMS.md): only for a player standing in a dimension.
    if (message.type.startsWith("item") || message.type.startsWith("loot") || message.type === "debugItem" || message.type === "debugWear") {
      if (!itemSystem || !player || !body) return;
      const why = handleItemMessage(itemSystem, player.entity, message);
      if (why) connection.end.send({ type: "itemRefused", reason: why });
      return;
    }
    switch (message.type) {
      case "hello": {
        if (player || connection.selecting || message.protocol !== PROTOCOL_VERSION) return;
        if (message.select) {
          connection.selecting = true;
          connection.end.send({ type: "welcome", protocol: PROTOCOL_VERSION, playerId: 0, world: world?.name ?? "", saves: saves !== null, config: options.config, packs: options.packs ?? [], rules: rules.hash, items: options.items?.hash ?? 0, creatures: options.creatures?.hash ?? 0, seed: options.seed >>> 0, progression: options.progression?.hash ?? 0 });
          connection.end.send(characterList());
          return;
        }
        const first = definitions.get(message.dimension) ?? start;
        // Its origins make its template (PROGRESSION.md, *Origins*).
        const chosen = progression?.originsFor(message.origins && typeof message.origins === "object" ? message.origins : undefined);
        const template = (chosen && rules.templates.get(chosen.template)) || playerTemplate!;
        const entity = createEntity(rules, template, nextId++, { dimension: "", x: first.spawn.x, y: 0, z: first.spawn.z, facing: 0, name: message.name, look: message.look && cleanLook(message.look) });
        skills.adopt(entity);
        itemSystem?.adopt(entity);
        if (chosen) progression!.adopt(entity, chosen.origins);
        const joined: Player = { entity, arrival: first.spawn, arrived: false, input: { moveX: 0, moveZ: 0, run: false, jump: false }, ackSeq: 0, character: null, playing: 0 };
        players.set(entity.id, joined);
        connection.player = joined;
        connection.end.send({ type: "welcome", protocol: PROTOCOL_VERSION, playerId: entity.id, world: world?.name ?? "", saves: saves !== null, config: options.config, packs: options.packs ?? [], rules: rules.hash, items: options.items?.hash ?? 0, creatures: options.creatures?.hash ?? 0, seed: options.seed >>> 0, progression: options.progression?.hash ?? 0 });
        transfer(connection, joined, first, first.spawn);
        return;
      }
      case "characterCreate": {
        if (!connection.selecting || player) return;
        const why = createCharacter(message);
        connection.end.send(why ? { type: "refused", what: "characterCreate", reason: why } : characterList());
        return;
      }
      case "characterDelete": {
        if (!connection.selecting || player || !saves || !world) return;
        const i = world.characters.findIndex((c) => c.id === message.id);
        const playing = [...players.values()].some((p) => p.character?.id === message.id);
        if (i < 0 || playing) {
          connection.end.send({ type: "refused", what: "characterDelete", reason: playing ? "That character is in the world." : "There is no such character." });
          return;
        }
        world.characters.splice(i, 1);
        void queue(`character ${message.id}`, () => saves.store.deleteCharacter(world.id, message.id));
        void writeWorld();
        connection.end.send(characterList());
        return;
      }
      case "enterWorld": {
        if (!connection.selecting || player || connection.entering) return;
        const refuse = (reason: string): void => connection.end.send({ type: "refused", what: "enterWorld", reason });
        if (!saves || !world || !world.characters.some((c) => c.id === message.character)) return refuse("There is no such character.");
        if ([...players.values()].some((p) => p.character?.id === message.character)) return refuse("That character is already in the world.");
        connection.entering = true;
        // After any write of it still under way.
        const key = `character ${message.character}`;
        void (writing.get(key) ?? Promise.resolve())
          .then(() => saves.store.readCharacter(world.id, message.character))
          .then(
            (record) => {
              connection.entering = false;
              if (connection.end.closed || connection.player) return;
              if (!record) return refuse("That character's save is missing.");
              enterCharacter(connection, record, message.dimension);
            },
            (error: unknown) => {
              connection.entering = false;
              refuse(`That character could not be loaded: ${String(error instanceof Error ? error.message : error)}`);
            },
          );
        return;
      }
      case "logout": {
        if (!player) return;
        const write = writeCharacter(player);
        removePlayer(player);
        connection.player = null;
        connection.selecting = true;
        const wrote = Promise.all([write, writeWorld()]);
        void wrote.then(() => {
          if (connection.end.closed) return;
          connection.end.send({ type: "loggedOut" });
          connection.end.send(characterList());
        });
        return;
      }
      case "saveInterface": {
        if (player?.character && typeof message.value === "string" && message.value.length <= 16384) player.character.interface = message.value;
        return;
      }
      case "intent": {
        if (!player) return;
        const length = Math.hypot(message.moveX, message.moveZ);
        const scale = length > 1 ? 1 / length : 1;
        player.input = { moveX: message.moveX * scale, moveZ: message.moveZ * scale, run: message.run, jump: player.input.jump || message.jump };
        player.ackSeq = message.seq;
        return;
      }
      case "teleport": {
        if (!player || !body) return;
        body.teleport(message.x, message.z);
        follow(player.entity);
        loaded.get(player.entity.dimension)!.streamer.loadAround(message.x, message.z, pointsIn(player.entity.dimension));
        return;
      }
      case "teleportTo": {
        if (!player || !body) return;
        body.teleportTo({ x: message.x, y: message.y, z: message.z });
        follow(player.entity);
        loaded.get(player.entity.dimension)!.streamer.loadAround(message.x, message.z, pointsIn(player.entity.dimension));
        return;
      }
      case "travel": {
        const to = definitions.get(message.dimension);
        if (!player || !to) return;
        const link = definitions.get(player.entity.dimension)?.links.find((l) => l.to === to.id);
        transfer(connection, player, to, link ? link.arrive : to.spawn);
        void writeCharacter(player, connection);
        return;
      }
      case "arrived": {
        if (player) player.arrived = true;
        return;
      }
      // Debug commands on entities (see ENTITIES.md): 0 is the sender's own player.
      case "debugModifier": {
        const target = player && targetOf(player, message.entity);
        if (!target?.stats || !rules.stats[message.stat] || !rules.modifierKinds[message.kind] || !Number.isFinite(message.value)) return;
        addModifier(target.stats, { stat: message.stat, kind: message.kind, value: message.value, source: message.source });
        return;
      }
      case "debugRemoveSource": {
        const target = player && targetOf(player, message.entity);
        if (target?.stats) removeSource(target.stats, message.source);
        return;
      }
      case "debugCombat": {
        const target = player && targetOf(player, message.entity);
        if (target?.combat) target.combat.forceCombat = message.inCombat;
        return;
      }
      case "debugResource": {
        const target = player && targetOf(player, message.entity);
        if (target?.resources && Number.isFinite(message.delta)) restore(target.resources, message.resource, message.delta);
        return;
      }
      case "debugSpawn": {
        const dimension = player && loaded.get(player.entity.dimension);
        const template = rules.templates.get(message.template);
        if (!dimension || !template) return;
        const { x, z } = message;
        spawnIn(dimension, template.id, x, z, Math.atan2(player!.entity.x - x, player!.entity.z - z));
        return;
      }
      case "debugDespawn": {
        const dimension = player && loaded.get(player.entity.dimension);
        const gone = dimension?.entities.get(message.entity);
        if (gone && !players.has(message.entity)) {
          skills.leave(gone, true);
          dimension!.entities.delete(message.entity);
        }
        return;
      }
      case "debugApply": {
        const target = player && targetOf(player, message.entity);
        if (target && rules.skills[message.skill]) skills.apply(message.skill, player!.entity, target);
        return;
      }
      case "debugKill": {
        const target = player && targetOf(player, message.entity);
        if (!target) return;
        if (message.revive) skills.revive(target);
        else skills.kill(target);
        return;
      }
      // Progression (see PROGRESSION.md, *Messages*).
      case "talentPick": {
        if (player && progression) progression.pick(player.entity, message.tree >>> 0, message.node >>> 0);
        return;
      }
      case "talentReset": {
        if (player && progression) progression.reset(player.entity, message.tree >>> 0);
        return;
      }
      case "learn": {
        const trainer = player && loaded.get(player.entity.dimension)?.entities.get(message.trainer >>> 0);
        if (!player || !progression || !trainer || !rules.skills[message.skill]) return;
        const why = progression.train(player.entity, trainer, message.skill);
        if (why) player.entity.progress?.events.push({ kind: "refused", discipline: -1, amount: 0, level: 0, skill: message.skill, source: why });
        return;
      }
      case "debugXp": {
        if (player && progression?.rules.disciplines[message.discipline] && Number.isFinite(message.amount)) progression.debugXp(player.entity, message.discipline, message.amount);
        return;
      }
      case "debugLevel": {
        if (player && progression?.rules.disciplines[message.discipline] && Number.isInteger(message.level)) progression.debugLevel(player.entity, message.discipline, Math.max(1, Math.min(1000, message.level)));
        return;
      }
      case "debugLearnAll": {
        if (player && progression) progression.learnAll(player.entity);
        return;
      }
      // Combat (see ABILITIES.md, *Casting*).
      case "target": {
        if (!player) return;
        const id = message.id >>> 0;
        const target = id ? targetOf(player, id) : undefined;
        skills.setTarget(player.entity, target ? target.id : 0);
        return;
      }
      case "cast": {
        if (!player || !player.entity.body || !rules.skills[message.skill]) return;
        const point = Number.isFinite(message.x) && Number.isFinite(message.z) ? { x: message.x, z: message.z } : null;
        skills.cast(player.entity, message.skill, message.target >>> 0, { point, queue: true });
        return;
      }
      case "stopCast": {
        if (player) skills.stopCast(player.entity);
        return;
      }
      case "attack": {
        if (player) skills.setAttacking(player.entity, message.on);
        return;
      }
      case "respawn": {
        if (!player?.entity.combat?.dead || !body) return;
        // Home, if it is in this dimension; else the dimension's spawn.
        const home = player.character?.travel.home;
        const spawn = home && home.dimension === player.entity.dimension ? home : (definitions.get(player.entity.dimension)?.spawn ?? start.spawn);
        skills.revive(player.entity);
        body.teleport(spawn.x, spawn.z);
        follow(player.entity);
        loaded.get(player.entity.dimension)?.streamer.loadAround(spawn.x, spawn.z, pointsIn(player.entity.dimension));
        return;
      }
    }
  }

  function step(deltaSeconds: number): void {
    for (let i = connections.length - 1; i >= 0; i--) {
      const connection = connections[i];
      for (const message of connection.end.receive()) handle(connection, message);
      if (connection.end.closed) {
        const gone = connection.player;
        connections.splice(i, 1);
        if (gone) {
          // Gone without logging out: saved as it was.
          void writeCharacter(gone);
          removePlayer(gone);
        }
      }
    }
    // Into the world: every player whose client is ready and whose dimension has loaded.
    for (const player of players.values()) {
      const entity = player.entity;
      const dimension = loaded.get(entity.dimension);
      if (entity.body || !player.arrived || !dimension) continue;
      entity.body = dimension.createBody(player.arrival.x, player.arrival.z);
      follow(entity);
      dimension.entities.set(entity.id, entity);
      dimension.streamer.loadAround(player.arrival.x, player.arrival.z, pointsIn(entity.dimension));
    }
    for (const [id, dimension] of loaded) dimension.streamer.update(pointsIn(id), CHUNK_BUDGET_MS);
    time += deltaSeconds;
    for (const player of players.values()) {
      const entity = player.entity;
      if (!entity.body) continue;
      player.playing += deltaSeconds;
      // Stunned, rooted or dead: the body stands (ABILITIES.md, *States on a unit*).
      const free = canMove(entity.combat?.flags);
      const input = free ? player.input : { moveX: 0, moveZ: 0, run: false, jump: false };
      const { x, y, z } = entity;
      entity.body.step(deltaSeconds, input, entityStat(rules, entity, "speed", 1));
      player.input = { ...player.input, jump: false };
      follow(entity);
      // Moved by its own doing - not pushed - breaks a cast that moving breaks.
      const tried = input.jump || input.moveX !== 0 || input.moveZ !== 0;
      if (entity.combat && tried && !entity.body.pushed && Math.hypot(entity.x - x, entity.y - y, entity.z - z) > 0.02) entity.combat.moved = true;
    }
    // Creatures think and move (CREATURES.md), then every magic runs.
    if (creatureSystem) {
      creatureSystem.step(deltaSeconds);
      if (options.onKill) for (const kill of creatureSystem.drainKills()) options.onKill(kill);
    }
    skills.step(loaded.values());
    const events = skills.drainEvents();
    itemSystem?.combatEvents(events);
    // XP from what happened, and level-ups as combat events for those near (PROGRESSION.md).
    progression?.combatEvents(events);
    const progressed = progression?.drain() ?? null;
    if (progressed) {
      for (const [entity, list] of progressed) for (const event of list) progressEvents.push({ entity, event });
      if (progressEvents.length > 256) progressEvents.splice(0, progressEvents.length - 256);
    }
    // A level gained or a death is saved at once (FRONTEND.md, *When the server saves*).
    if (saves) {
      const now = new Set<number>();
      for (const [id, list] of progressed ?? []) if (list.some((e) => e.kind === "levelUp")) now.add(id);
      for (const { event } of events) if (event.kind === EVENT_KIND.death && players.get(event.target)?.character) now.add(event.target);
      for (const id of now) {
        const connection = connections.find((c) => c.player?.entity.id === id);
        const player = players.get(id);
        if (player?.character) void writeCharacter(player, connection);
      }
      if (time - lastAutosave >= (saves.interval ?? 30)) {
        lastAutosave = time;
        // A save still under way is not queued behind: the next one is due soon enough.
        if (writing.size === 0) void saveAll();
      }
    }
    itemSystem?.step(loaded.values());
    for (const dimension of loaded.values()) stepResources(dimension.entities.values(), deltaSeconds);
    tick++;
    // What each client is told: the entities around its player, then where they have moved to.
    for (const connection of connections) {
      const entity = connection.player?.entity;
      const viewer = entity?.body ? entity : null;
      const around = viewer ? loaded.get(viewer.dimension)?.entities.values() ?? [] : [];
      const messages = connection.replicator.update(viewer, around, tick, connection.player?.ackSeq ?? 0, time, events);
      // Items go after the entity messages and before the snapshot, which is last.
      const snapshot = messages.pop()!;
      if (connection.items) messages.push(...connection.items.update(viewer, connection.replicator.known, findEntity));
      // Its own progress (PROGRESSION.md): whole when it changed or on arrival, and the step's events.
      if (progression && entity?.progress) {
        messages.push(...progressMessages(progression.ctx, entity, progressed?.get(entity.id), !connection.progressSent));
        connection.progressSent = true;
      }
      messages.push(snapshot);
      for (const message of messages) connection.end.send(message);
    }
  }

  return {
    connect: (end) => {
      connections.push({ end, player: null, replicator: createReplicator(rules), items: itemSystem && options.items ? createItemReplicator(options.items, itemSystem) : null, progressSent: false, selecting: false, entering: false });
    },
    step,
    save: saveAll,
    get tick() {
      return tick;
    },
    get time() {
      return time;
    },
    debug: {
      rules,
      dimensions: loaded,
      players,
      entity: findEntity,
      skills,
      items: itemSystem,
      creatures: creatureSystem,
      delta,
      progression,
      progressEvents,
    },
  };
}

/** A look a client asked for, kept to what one can be: names of a few plain characters, a u32 seed.
 *  Whether the names are races and outfits is the clients' business - the server never reads them. */
function cleanLook(look: EntityAppearance): EntityAppearance {
  const name = (s: unknown): string => (typeof s === "string" && /^[A-Za-z0-9_-]{0,32}$/.test(s) ? s : "");
  const choices = cleanChoices(look.choices);
  return { seed: Number(look.seed) >>> 0, race: name(look.race), outfit: name(look.outfit), sex: look.sex === "male" || look.sex === "female" ? look.sex : "", ...(choices ? { choices } : {}) };
}
