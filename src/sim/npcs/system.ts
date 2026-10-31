import { deriveSeed, mulberry32 } from "../../world/rng";
import { hashString, type DimensionDef } from "../../world/content/dimensions";
import { placedAxes, type Enterable } from "../../world/buildings/buildingCollision";
import type { SettlementLayout } from "../../world/settlements/settlementLayout";
import type { SettlementSite } from "../../world/settlements/settlementSites";
import type { ChosenStart } from "../../world/settlements/starts";
import type { Dimension } from "../dimension";
import type { Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import type { BarkLine, NpcRoleDef, StandAnchor } from "../rules/npcRules";
import type { WorldDelta } from "../creatures/worldDelta";
import { EVENT_KIND, type CombatEvent } from "../skills/events";
import { castForSettlement, type Cast, type CastContext, type CastNpc } from "./cast";
import { standingBetween } from "../factions";
import type { Text } from "../text";

/**
 * Settlements' people in the world (NPCS.md, *NPCs in the world*): each settlement near a player
 * has its cast's NPCs who are out made as entities, standing at their spots - in a room of an inn or
 * a chapel, by a door, round the square, along a street - and dropped once nobody has been near for
 * a while. A guard walks its round. NPCs bark at players who come by. One killed comes back after
 * `respawn`, through the world delta.
 */
export interface NpcWorld {
  time(): number;
  spawn(dimension: string, template: string, x: number, z: number, facing: number, key: string): Entity | undefined;
  despawn(entity: Entity): void;
  playersIn(dimension: string): Entity[];
  delta: WorldDelta;
  /** The world's classes, for class trainers. */
  classes: readonly { id: string; name: string }[];
  /** A settlement's cast has just been made: its quests are generated now, and the quest people
   *  they need added to it before anyone is placed (QUESTS.md, *The generator*). */
  castMade?(dimension: string, settlement: { site: SettlementSite; layout: SettlementLayout }, cast: Cast, context: CastContext): void;
  /** Says a bark: its text as said, to the players near. */
  bark(npc: Entity, text: Text, to: readonly Entity[]): void;
}

export interface NpcSystem {
  load(dimension: Dimension, definition: DimensionDef, seed: number, starts: readonly ChosenStart[]): void;
  unload(id: string): void;
  step(deltaSeconds: number): void;
  /** Hits on NPCs: they cry out. */
  combatEvents(events: readonly CombatEvent[]): void;
  /** The cast entry an NPC entity was made from. */
  npcOf(entity: Entity): CastNpc | undefined;
  /** The entity standing now for an NPC id, if its settlement is filled. */
  entityOf(id: string): Entity | undefined;
  /** A player talks to an NPC (NPCS.md, *Services*): it turns to them and greets them, and says what
   *  it offers - or why it will not talk (out of reach, dead, not friendly enough). */
  talk(player: Entity, npc: Entity): NpcTalk | string;
  debug: {
    cast(dimension: string, siteId: number): Cast | null;
    /** The NPC entities standing in a dimension now. */
    active(dimension: string): Entity[];
  };
}

/** What talking to an NPC gives: its greeting, and its role's services as the role writes them. */
export interface NpcTalk {
  npc: CastNpc;
  greeting: Text;
  services: Readonly<Record<string, unknown>>;
}

/** Where an NPC stands, and which way it faces. */
interface Spot {
  x: number;
  y: number | null;
  z: number;
  facing: number;
  indoors: boolean;
}

interface Patrol {
  points: { x: number; z: number }[];
  next: number;
  waitUntil: number;
}

interface Living {
  npc: CastNpc;
  entity: Entity;
  spot: Spot;
  patrol: Patrol | null;
  deadAt: number;
  lastBark: number;
  barked: Map<number, number>;
}

interface Settlement {
  site: SettlementSite;
  layout: SettlementLayout;
  cast: Cast | null;
  living: Map<number, Living>;
  active: boolean;
  lastNear: number;
}

interface DimensionState {
  dimension: Dimension;
  context: CastContext;
  settlements: Settlement[];
  folkOf: (site: SettlementSite) => string;
}

/** How far apart two NPCs stand at least, and how far round a spot one is looked for. */
const SPACING = 1.2;
const BODY_ROOM = 0.6;
/** How often settlements are looked at for players near, in seconds of world time. */
const LOOK_EVERY = 0.5;
/** How long a dead NPC lies before it is taken away. */
const CORPSE_TIME = 20;
/** One NPC's barks are at least this far apart, whoever they are for. */
const BARK_GAP = 12;
/** A player hears one bark at most this often, whoever says it. */
const HEARD_GAP = 6;
/** A bark is heard this far off. */
const HEARD = 20;
/** A patrol walks at this share of a body's walk, and waits this long at each point. */
const PATROL_PACE = 0.35;
const PATROL_WAIT: [number, number] = [3, 7];

export function createNpcSystem(rules: GameRules, world: NpcWorld): NpcSystem {
  const npcRules = rules.npcs;
  const states = new Map<string, DimensionState>();
  const byEntity = new Map<number, Living>();
  /** When each player (by entity id) was last barked at. */
  const heard = new Map<number, number>();
  let nextLook = 0;

  const roleOf = (npc: CastNpc): NpcRoleDef | undefined => (npc.role === null ? undefined : npcRules.roles[npcRules.roleIndex.get(npc.role) ?? -1]);

  /** A room's free floor slots in world space, most open first: from the furnishing's slot grid. */
  function roomSlots(enterable: Enterable, roomName: string): Spot[] {
    const { interior, house } = enterable;
    const room = interior.layout.rooms.find((r) => r.name === roomName);
    const grid = room && interior.furnished?.grids.find((g) => g.room === room.id);
    if (!room || !grid) return [];
    const level = interior.levels.find((l) => l.index === room.base);
    if (!level) return [];
    const a = placedAxes(house);
    const toWorld = (x: number, y: number, z: number) => ({
      x: house.x + a.x.x * x + a.y.x * y + a.z.x * z,
      y: house.y + a.x.y * x + a.y.y * y + a.z.y * z,
      z: house.z + a.x.z * x + a.y.z * y + a.z.z * z,
    });
    const free = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < grid.nx && j < grid.nz && grid.state[j * grid.nx + i] === "free";
    const centre = { x: grid.x0 + (grid.nx * grid.sx) / 2, z: grid.z0 + (grid.nz * grid.sz) / 2 };
    const slots: { at: { x: number; y: number; z: number }; open: number; facing: number }[] = [];
    for (let j = 0; j < grid.nz; j++) {
      for (let i = 0; i < grid.nx; i++) {
        if (!free(i, j)) continue;
        let open = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (free(i + di, j + dj)) open++;
        const lx = grid.x0 + (i + 0.5) * grid.sx;
        const lz = grid.z0 + (j + 0.5) * grid.sz;
        const at = toWorld(lx, level.floor, lz);
        const look = toWorld(centre.x, level.floor, centre.z);
        // Toward the room's middle; from the middle itself, out of the front.
        const facing = Math.hypot(look.x - at.x, look.z - at.z) > 0.5 ? Math.atan2(look.x - at.x, look.z - at.z) : Math.atan2(house.frontX, house.frontZ);
        slots.push({ at, open, facing });
      }
    }
    // The most open first, then a fixed order: the same spots every time.
    slots.sort((p, q) => q.open - p.open || p.at.x - q.at.x || p.at.z - q.at.z);
    return slots.map((s) => ({ x: s.at.x, y: s.at.y, z: s.at.z, facing: s.facing, indoors: true }));
  }

  /** Works out where every NPC who is out in a settlement stands, once: the same every time. */
  function placeAll(state: DimensionState, settlement: Settlement): Map<number, Spot> {
    const { layout } = settlement;
    const cast = settlement.cast!;
    const rng = mulberry32(deriveSeed(state.context.seed, 77_031 + settlement.site.id));
    const taken: Spot[] = [];
    const roomsUsed = new Map<string, Spot[]>();
    const spots = new Map<number, Spot>();
    const square = layout.square;
    const enterableAt = (houseIndex: number): Enterable | undefined => {
      const h = layout.houses[houseIndex];
      return state.dimension.buildings.enterable.find((e) => Math.abs(e.house.x - h.x) < 0.5 && Math.abs(e.house.z - h.z) < 0.5);
    };
    const houseOf = (npc: CastNpc, building: string | null): number => {
      if (building === null) return npc.work >= 0 ? npc.work : cast.households[npc.household].house;
      if (npc.work >= 0 && layout.houses[npc.work].building.id === building) return npc.work;
      // The nearest of that kind to the square.
      let best = -1;
      layout.houses.forEach((h, i) => {
        if (h.building.id !== building) return;
        if (best < 0 || Math.hypot(h.x - square.x, h.z - square.z) < Math.hypot(layout.houses[best].x - square.x, layout.houses[best].z - square.z)) best = i;
      });
      return best;
    };
    const roomy = (x: number, z: number): boolean => taken.every((t) => Math.hypot(t.x - x, t.z - z) >= SPACING) && state.dimension.trunks.clear(x, z, BODY_ROOM);
    /** A clear outdoor spot at or round a point: rings of tries a little further out each time. */
    const outdoors = (x: number, z: number, facing: number): Spot | null => {
      for (let ring = 0; ring < 6; ring++) {
        const tries = ring === 0 ? 1 : 8;
        for (let k = 0; k < tries; k++) {
          const angle = (k / tries) * Math.PI * 2 + ring;
          const px = x + Math.cos(angle) * ring * 0.9;
          const pz = z + Math.sin(angle) * ring * 0.9;
          if (roomy(px, pz)) return { x: px, y: null, z: pz, facing, indoors: false };
        }
      }
      return null;
    };
    const byDoor = (houseIndex: number): Spot | null => {
      const h = layout.houses[houseIndex];
      if (!h) return null;
      const side = (rng() - 0.5) * Math.min(4, h.width * 0.6);
      const out = h.depth / 2 + 2.5;
      return outdoors(h.x + h.frontX * out + h.frontZ * side, h.z + h.frontZ * out - h.frontX * side, Math.atan2(h.frontX, h.frontZ));
    };
    const tryAnchor = (npc: CastNpc, role: NpcRoleDef | undefined, anchor: StandAnchor): Spot | null => {
      if (anchor.classes && (!npc.class || !anchor.classes.includes(npc.class))) return null;
      if (anchor.at === "square") {
        const angle = rng() * Math.PI * 2;
        const r = square.radius * (0.55 + rng() * 0.35);
        const x = square.x + Math.cos(angle) * r;
        const z = square.z + Math.sin(angle) * r;
        return outdoors(x, z, Math.atan2(square.x - x, square.z - z));
      }
      if (anchor.at === "door") {
        const home = cast.households[npc.household].house;
        return home >= 0 ? byDoor(home) : null;
      }
      if (anchor.at === "street") {
        const street = layout.streets.length > 0 ? layout.streets[Math.floor(rng() * layout.streets.length)] : undefined;
        if (!street || street.points.length < 2) return null;
        const i = Math.min(street.points.length - 2, Math.floor(rng() * (street.points.length - 1)));
        const p = street.points[i];
        const q = street.points[i + 1];
        const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        const side = rng() < 0.5 ? -1 : 1;
        // On the verge, facing along the street.
        return outdoors(p.x + ((q.z - p.z) / len) * 2.2 * side, p.z - ((q.x - p.x) / len) * 2.2 * side, Math.atan2(q.x - p.x, q.z - p.z));
      }
      const building = anchor.building ?? role?.buildings[0] ?? null;
      const house = houseOf(npc, building);
      if (house < 0 || (building !== null && layout.houses[house].building.id !== building)) return null;
      if (anchor.room) {
        const enterable = enterableAt(house);
        if (!enterable) return null;
        const key = `${house}:${anchor.room}`;
        if (!roomsUsed.has(key)) roomsUsed.set(key, roomSlots(enterable, anchor.room));
        const slots = roomsUsed.get(key)!;
        const index = slots.findIndex((s) => taken.every((t) => Math.hypot(t.x - s.x, t.z - s.z) >= SPACING));
        return index < 0 ? null : slots.splice(index, 1)[0];
      }
      return byDoor(house);
    };
    for (const npc of cast.npcs) {
      if (!npc.out) continue;
      const role = roleOf(npc);
      let spot: Spot | null = null;
      // A quest person stands at its place (QUESTS.md, *Quest people*).
      if (npc.spot) spot = outdoors(npc.spot.x, npc.spot.z, rng() * Math.PI * 2);
      for (const anchor of spot ? [] : (role?.stand ?? [])) {
        spot = tryAnchor(npc, role, anchor);
        if (spot) break;
      }
      spot ??= tryAnchor(npc, role, { building: null, room: null, at: "square", classes: null }) ?? { x: square.x, y: null, z: square.z, facing: 0, indoors: false };
      taken.push(spot);
      spots.set(npc.index, spot);
    }
    return spots;
  }

  function patrolFor(layout: SettlementLayout, kind: NonNullable<NpcRoleDef["patrol"]>, rng: () => number): Patrol {
    const square = layout.square;
    const ring = Array.from({ length: 4 }, (_, k) => ({ x: square.x + Math.cos((k / 4) * Math.PI * 2) * square.radius * 0.8, z: square.z + Math.sin((k / 4) * Math.PI * 2) * square.radius * 0.8 }));
    const points =
      kind === "gates"
        ? [...layout.gates.flatMap((g) => [{ x: g.x * 0.85 + square.x * 0.15, z: g.z * 0.85 + square.z * 0.15 }, { x: square.x, z: square.z }])]
        : kind === "street" && layout.streets[0]
          ? layout.streets[0].points.map((p) => ({ x: p.x, z: p.z }))
          : ring;
    return { points: points.length > 0 ? points : ring, next: Math.floor(rng() * Math.max(1, points.length)), waitUntil: 0 };
  }

  function makeOne(state: DimensionState, settlement: Settlement, npc: CastNpc, spot: Spot): void {
    const role = roleOf(npc);
    const template = role && rules.templates.has(role.template) ? role.template : "npc";
    const entity = world.spawn(state.dimension.id, template, spot.x, spot.z, spot.facing, npc.id);
    if (!entity) return;
    if (spot.y !== null) entity.y = spot.y;
    entity.name = npc.name;
    entity.title = npc.title;
    entity.faction = state.folkOf(settlement.site);
    if (npc.class) entity.trainerClass = npc.class;
    entity.look = { seed: npc.seed, race: npc.race, outfit: npc.outfit, sex: npc.sex, choices: { ...npc.choices } };
    let patrol: Patrol | null = null;
    if (role?.patrol && !spot.indoors) {
      patrol = patrolFor(settlement.layout, role.patrol, mulberry32(deriveSeed(state.context.seed, hashString(npc.id))));
      entity.body = state.dimension.createBody(spot.x, spot.z);
      entity.body.face(spot.facing);
    }
    const living: Living = { npc, entity, spot, patrol, deadAt: 0, lastBark: -Infinity, barked: new Map() };
    settlement.living.set(npc.index, living);
    byEntity.set(entity.id, living);
  }

  const spotsOf = new WeakMap<Settlement, Map<number, Spot>>();
  /** A settlement's cast, made once - with its quests and quest people (QUESTS.md). */
  function castOfSettlement(state: DimensionState, settlement: Settlement): Cast | null {
    if (!settlement.cast) {
      settlement.cast = castForSettlement(state.dimension.world, settlement.site.id, state.context);
      if (settlement.cast) world.castMade?.(state.dimension.id, settlement, settlement.cast, state.context);
    }
    return settlement.cast;
  }

  function fill(state: DimensionState, settlement: Settlement): void {
    if (!castOfSettlement(state, settlement)) return;
    let spots = spotsOf.get(settlement);
    if (!spots) {
      spots = placeAll(state, settlement);
      spotsOf.set(settlement, spots);
    }
    const now = world.time();
    for (const npc of settlement.cast!.npcs) {
      if (!npc.out || settlement.living.has(npc.index)) continue;
      // Killed, and not back yet.
      if ((world.delta.get(npc.id) ?? -Infinity) > now) continue;
      makeOne(state, settlement, npc, spots.get(npc.index)!);
    }
    settlement.active = true;
  }

  function remove(settlement: Settlement, living: Living): void {
    world.despawn(living.entity);
    byEntity.delete(living.entity.id);
    settlement.living.delete(living.npc.index);
  }

  function release(settlement: Settlement): void {
    for (const living of [...settlement.living.values()]) remove(settlement, living);
    settlement.active = false;
  }

  /** A line for a moment: one whose mood and relations fit, by weight. */
  function chooseLine(living: Living, when: BarkLine["when"], rng: () => number): BarkLine | null {
    const set = npcRules.barks.get(roleOf(living.npc)?.barks ?? "");
    const fits = (set ?? []).filter((l) => l.when === when && (!l.moods || l.moods.includes(living.npc.mood)) && l.calls.every((c) => living.npc.relations.some((r) => r.call === c)));
    let roll = rng() * fits.reduce((sum, l) => sum + l.weight, 0);
    return fits.find((l) => (roll -= l.weight) < 0) ?? fits[0] ?? null;
  }

  /** A line for a moment, filled in: its relatives' names, its own, the settlement's, the player's. */
  function line(state: DimensionState, settlement: Settlement, living: Living, when: BarkLine["when"], player: Entity | null): Text | null {
    const cast = settlement.cast!;
    const rng = mulberry32(deriveSeed(state.context.seed, Math.floor(world.time() * 10) + living.entity.id));
    const chosen = chooseLine(living, when, rng);
    if (!chosen) return null;
    // The template as written, and what fills it (QUESTS.md, *Text*): the reader's client words it.
    const args: Record<string, string> = { name: living.npc.name, given: living.npc.given, title: living.npc.title, settlement: settlement.site.name, player: player?.name ?? "" };
    for (const call of chosen.calls) args[`call:${call}`] = cast.npcs[living.npc.relations.find((r) => r.call === call)?.to ?? -1]?.given ?? "";
    return { text: chosen.text, args };
  }

  function say(state: DimensionState, settlement: Settlement, living: Living, when: BarkLine["when"], player: Entity | null): void {
    const text = line(state, settlement, living, when, player);
    if (text === null) return;
    living.lastBark = world.time();
    if (player) {
      living.entity.facing = Math.atan2(player.x - living.entity.x, player.z - living.entity.z);
      living.entity.body?.face(living.entity.facing);
    }
    const near = world.playersIn(state.dimension.id).filter((p) => Math.hypot(p.x - living.entity.x, p.z - living.entity.z) <= HEARD);
    world.bark(living.entity, text, near);
  }

  function stepLiving(state: DimensionState, settlement: Settlement, living: Living, players: readonly Entity[], deltaSeconds: number): void {
    const now = world.time();
    const { entity } = living;
    if (entity.combat?.dead) {
      if (living.deadAt === 0) living.deadAt = now;
      if (now - living.deadAt >= CORPSE_TIME) {
        const [lo, hi] = npcRules.respawn;
        world.delta.set(living.npc.id, now + lo + Math.random() * (hi - lo));
        remove(settlement, living);
      }
      return;
    }
    // A patrol walks to its next point, waits there, and goes on.
    const patrol = living.patrol;
    if (patrol && entity.body && now >= patrol.waitUntil) {
      const goal = patrol.points[patrol.next % patrol.points.length];
      const dx = goal.x - entity.x;
      const dz = goal.z - entity.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.2) {
        patrol.next = (patrol.next + 1) % patrol.points.length;
        patrol.waitUntil = now + PATROL_WAIT[0] + Math.random() * (PATROL_WAIT[1] - PATROL_WAIT[0]);
      } else {
        entity.body.step(deltaSeconds, { moveX: (dx / d) * PATROL_PACE, moveZ: (dz / d) * PATROL_PACE, run: false, jump: false }, 1);
        const { feet, grounded } = entity.body.motor.state;
        entity.x = feet.x;
        entity.y = feet.y;
        entity.z = feet.z;
        entity.grounded = grounded;
        entity.facing = entity.body.facing;
      }
    }
    // A bark for a player who comes by and has not heard one from it for a while.
    if (now - living.lastBark < BARK_GAP) return;
    for (const player of players) {
      if (Math.hypot(player.x - entity.x, player.z - entity.z) > npcRules.bark.range) continue;
      if (now - (living.barked.get(player.id) ?? -Infinity) < npcRules.bark.cooldown) continue;
      if (now - (heard.get(player.id) ?? -Infinity) < HEARD_GAP) continue;
      living.barked.set(player.id, now);
      heard.set(player.id, now);
      say(state, settlement, living, "near", player);
      return;
    }
  }

  return {
    load(dimension, definition, seed, starts) {
      const { world: data } = dimension;
      const layouts = new Map(data.settlementLayouts.map((l) => [l.siteId, l]));
      const settlements: Settlement[] = data.settlements
        .filter((site) => layouts.has(site.id))
        .map((site) => ({ site, layout: layouts.get(site.id)!, cast: null, living: new Map(), active: false, lastNear: -Infinity }));
      const context: CastContext = {
        seed,
        dimension: definition.id,
        voices: data.content.voices,
        rules: npcRules,
        classes: world.classes,
        starts: new Set(starts.flatMap((s) => (s.settlement === null ? [] : [s.settlement]))),
      };
      states.set(dimension.id, { dimension, context, settlements, folkOf: (site) => `folk@${definition.id}/${site.areaId}` });
    },
    unload(id) {
      const state = states.get(id);
      if (!state) return;
      // Its entities went with the dimension.
      for (const settlement of state.settlements) for (const living of settlement.living.values()) byEntity.delete(living.entity.id);
      states.delete(id);
    },
    step(deltaSeconds) {
      const now = world.time();
      const look = now >= nextLook;
      if (look) nextLook = now + LOOK_EVERY;
      for (const state of states.values()) {
        const players = world.playersIn(state.dimension.id);
        for (const settlement of state.settlements) {
          const { layout } = settlement;
          // Filled the moment a player comes near; then, now and then, the dead who are due back
          // made again - or all of it dropped once nobody has been near for long enough.
          if (look || !settlement.active) {
            // Near the settlement, or near one of its quest people out at their places.
            const outside = settlement.cast?.npcs.flatMap((n) => (n.spot ? [n.spot] : [])) ?? [];
            const nearest = Math.min(
              Infinity,
              ...players.map((p) => Math.min(Math.hypot(p.x - layout.x, p.z - layout.z) - layout.radius, ...outside.map((o) => Math.hypot(p.x - o.x, p.z - o.z)))),
            );
            if (nearest <= npcRules.activeRadius) {
              settlement.lastNear = now;
              fill(state, settlement);
            } else if (settlement.active && nearest > npcRules.releaseRadius && now - settlement.lastNear > npcRules.releaseAfter) {
              release(settlement);
            }
          }
          if (!settlement.active) continue;
          for (const living of [...settlement.living.values()]) stepLiving(state, settlement, living, players, deltaSeconds);
        }
      }
    },
    combatEvents(events) {
      for (const event of events) {
        if (event.kind !== EVENT_KIND.hit) continue;
        const living = byEntity.get(event.target);
        if (!living || living.entity.combat?.dead || world.time() - living.lastBark < 3) continue;
        for (const state of states.values()) {
          const settlement = state.settlements.find((s) => s.living.get(living.npc.index) === living);
          if (settlement) say(state, settlement, living, "hit", null);
        }
      }
    },
    npcOf: (entity) => byEntity.get(entity.id)?.npc,
    entityOf(id) {
      for (const living of byEntity.values()) if (living.npc.id === id) return living.entity;
      return undefined;
    },
    talk(player, npc) {
      const living = byEntity.get(npc.id);
      if (!living) return "notNpc";
      if (npc.combat?.dead) return "dead";
      const reach = npcRules.talkRange + npc.template.look.radius + player.template.look.radius;
      if (npc.dimension !== player.dimension || Math.hypot(npc.x - player.x, npc.z - player.z) > reach) return "range";
      const standing = standingBetween(rules.factions, { faction: player.faction ?? player.template.faction, standing: player.standing }, { faction: npc.faction ?? npc.template.faction });
      if (standing < (rules.factions.tiers.find((t) => t.id === "unfriendly")?.from ?? 0)) return "unfriendly";
      const state = states.get(npc.dimension)!;
      const settlement = state.settlements.find((s) => s.living.get(living.npc.index) === living)!;
      // It turns to whoever talks to it.
      npc.facing = Math.atan2(player.x - npc.x, player.z - npc.z);
      npc.body?.face(npc.facing);
      const greeting = line(state, settlement, living, "click", player) ?? { text: "", args: {} };
      return { npc: living.npc, greeting, services: roleOf(living.npc)?.services ?? {} };
    },
    debug: {
      cast(dimension, siteId) {
        const state = states.get(dimension);
        const settlement = state?.settlements.find((s) => s.site.id === siteId);
        if (!state || !settlement) return null;
        return castOfSettlement(state, settlement);
      },
      active: (dimension) => (states.get(dimension)?.settlements ?? []).flatMap((s) => [...s.living.values()].map((l) => l.entity)),
    },
  };
}
