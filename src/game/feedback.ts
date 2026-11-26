// Feedback in the game (see FEEDBACK.md): the combat events of each step played as cues - sounds,
// particle effects and hit feel - at the units the mirror knows (on their bodies' bones where they
// have bodies), heard and seen from the camera, which shakes in the player's own fights; and what
// the client sees happen itself - footsteps, loot glinting and being opened and taken, items
// equipped, used and dropped, a target picked. The sound effects start with the page's audio (the
// first click or key press); they and the particles live for the page, across dimensions, and each
// dimension's scene gets its own particle drawers.

import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { createScreenEffects } from "../feedback/screen";
import { createFeel, type Feel, type Feelable } from "../feedback/feel";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { createParticleSystem, type ParticleSystem } from "../particles/system";
import { createPropEffects, type PropEffects } from "../world/props/propEffects";
import { createParticleRenderer, type ParticleRenderer } from "../particles/render";
import { whenAudio } from "../audio/context";
import { createSfx, type Sfx, type Vec3 } from "../audio/sfx";
import { createAmbience, impulse, type Ambience } from "../audio/ambience";
import { SEA_REACH, WATER_REACH, type Bearing } from "../audio/ambienceMix";
import { SEA_LEVEL } from "../world/cells/areaField";
import { createUnderwaterLook, type UnderwaterLook } from "./underwater";
import { createCuePlayer, type Bone, type CueContext, type CuePlayer, type UnitTraits } from "../feedback/cues";
import type { FeedbackRules } from "../feedback/rules";
import type { GameRules } from "../sim/rules/gameRules";
import type { ItemRules } from "../sim/rules/itemRules";
import type { CombatEvent } from "../sim/skills/events";
import type { BodyKit } from "./characterBody";
import type { EntityMirror, MirroredEntity } from "./entityMirror";
import type { BelongingsMirror } from "./belongingsMirror";
import type { ClientMessage } from "../sim/protocol";
import type { World } from "../world/world";
import { createSurfaceProbe, type SurfaceProbe } from "./footsteps";
import { GROUND_ITEM_TEMPLATE, TAKE_ALL } from "../sim/items/itemSystem";
import { EQUIPMENT } from "../sim/items/items";
import { ACTION_DRAG_TYPE, takenByBar } from "../ui/actionBar";
import type { CueHandle } from "../feedback/cues";
import { FLAG } from "../sim/skills/flags";

export interface GameFeedback {
  /** A step's combat events. */
  events: (events: readonly CombatEvent[]) => void;
  /** A client event (`lootOpen`, `itemTake`...) at a unit or a point. */
  client: (name: string, context: CueContext, match?: { rarity?: string }) => void;
  /** The scene and world being drawn, for the particles and the ground under feet: on entering a
   *  dimension, null on leaving. */
  setScene: (scene: Scene | null, world?: World) => void;
  /** An item intent the player sends (take, drop, pick up, equip, use): its sound, at once. */
  itemIntent: (message: ClientMessage) => void;
  /** Listens to the screens: windows in `windows` opening and closing, and the action bar's drags. */
  watchScreens: (...windows: HTMLElement[]) => void;
  /** Each frame: steps the particles and puts the listener on the camera. */
  update: (camera: Camera | null) => void;
  /** The Effects volume, 0..1. */
  setVolume: (volume: number) => void;
  /** The Ambience volume, 0..1. */
  setAmbienceVolume: (volume: number) => void;
  /** The Screen shake setting, 0..1: 0 turns it off. */
  setShake: (scale: number) => void;
  feel: Feel;
  /** The sound effects player, once audio has started - for the console. */
  sfx: () => Sfx | null;
  /** The ambience (wind, rain, water, drips), once audio has started - for the console and the probes. */
  ambience: () => Ambience | null;
  /** What the underground the player is in is (a cave or a crypt), or null above ground. */
  setHollow: (kind: "cave" | "crypt" | null) => void;
  cues: CuePlayer;
  particles: ParticleSystem;
  /** The flames on props (PROP_EFFECTS.md): the world's, and a dungeon's once it is drawn. */
  flames: PropEffects;
  /** Particles drawn last frame. */
  stats: () => { sprites: number; meshes: number; effects: number };
  /** Stops every sound and effect and lets go of the screens and the audio - when a game ends. */
  dispose: () => void;
}

export interface GameFeedbackOptions {
  rules: FeedbackRules;
  game: GameRules;
  items: ItemRules;
  kit: BodyKit;
  mirror: EntityMirror;
  player: () => number;
  target: () => number;
  /** The own player's outfit, which the server does not send back to its own client. */
  ownOutfit: () => string;
  volume: number;
  /** The Ambience volume to start with. */
  ambienceVolume: number;
  /** Where the packs are served from. */
  baseUrl?: string;
  /** Where a bone of a unit's body is, when it has one drawn (the player's, entityMeshes'). */
  bodyPlace: (unit: number, bone: Bone, out: Vector3) => boolean;
  /** A unit's drawn body or capsule, for hit feel. */
  feelable: (unit: number) => Feelable | null;
  /** Words floating up over a unit (a cue's `text` part): the page's floating text. */
  say?: (unit: number, label: string, colour: string) => void;
  /** The Screen shake setting to start with. */
  shake?: number;
  /** How many steps a unit's body has taken, or -1 for one without a body. */
  steps: (unit: number) => number;
  /** The own player's things, for what loot holds and what an item is. */
  belongings: BelongingsMirror;
}

/** Footsteps are heard from units this near the player, at most. */
const FOOTSTEP_REACH = 25;
/** Seconds before a creature that let go calls out again when it turns on someone. */
const AGGRO_AGAIN = 4;
const DEAD = 1 << FLAG.dead;

/** The page's sound as heard from under water: everything above this goes. */
const MUFFLED_HZ = 600;
/** Metres of water under the sea's level where the ambience hears the sea rather than a river. */
const SEA_DEPTH = 1.5;
/** How alive a biome is with birds, 0..1; a biome not listed is 0.6. */
const LIFE: Record<string, number> = { autumnWood: 1, bluebellWood: 1, cloudForest: 0.9, rainforest: 1, meadow: 0.9, greenAlps: 0.7, desert: 0.15, sandSea: 0.1, saltFlat: 0.1, polarDesert: 0.05, icePeaks: 0.1, frostSteppe: 0.2 };
const time = (): number => performance.now();
const BABYLON_FORWARD = new Vector3(0, 0, 1);
const scratch = new Vector3();

/** How high up a unit's bones are, as a share of its height, until bodies say (step 3). */
const BONE_HEIGHT: Record<Bone, number> = { chest: 0.65, head: 0.92, feet: 0.03, mainHand: 0.55, offHand: 0.55, hands: 0.6, weapon: 0.6 };

export function createGameFeedback(options: GameFeedbackOptions): GameFeedback {
  const { rules, game, items, kit, mirror } = options;
  const baseUrl = options.baseUrl ?? import.meta.env.BASE_URL;
  let sfx: Sfx | null = null;
  let ambience: Ambience | null = null;
  let hollow: "cave" | "crypt" | null = null;
  /** The page's low-pass, closed while the camera is under water. */
  let muffle: BiquadFilterNode | null = null;
  /** Whether the camera is under water now. */
  let underwater = false;
  /** The effects' send into the stone reverb, opened underground. */
  let echo: GainNode | null = null;
  let volume = options.volume;
  let ambienceVolume = options.ambienceVolume;
  let disposed = false;
  /** What `watchScreens` started, for `dispose` to stop. */
  const unwatch: (() => void)[] = [];
  const stopWaiting = whenAudio((audio) => {
    if (disposed) return;
    sfx = createSfx(audio.ctx, audio.effects, rules, (sound, file) => `${baseUrl}packs/${sound.file.split("/")[0]}/${file}`);
    sfx.setVolume(volume);
    sfx.prewarm();
    ambience = createAmbience(audio.ctx, audio.ambient, rules.ambience, (path) => `${baseUrl}packs/${path}`);
    ambience.setVolume(ambienceVolume);
    muffle = audio.muffle;
    muffle.frequency.value = underwater ? MUFFLED_HZ : 22000;
    echo = audio.echo;
    if (!audio.echoRoom.buffer) audio.echoRoom.buffer = impulse(audio.ctx, 2.4);
  });

  // What a unit hits with and wears, worked out again only when what it shows changes.
  const traitCache = new Map<number, { key: string; traits: UnitTraits }>();
  const traitsOf = (entity: MirroredEntity): UnitTraits => {
    const outfit = entity.id === options.player() ? options.ownOutfit() : entity.look.outfit || entity.template?.look.outfit || "";
    const key = entity.gear ? entity.gear.join(",") : `outfit:${outfit}`;
    const cached = traitCache.get(entity.id);
    if (cached && cached.key === key) return cached.traits;
    const look = entity.template?.look.feedback ?? {};
    const types = (entity.gear ?? []).map((id) => items.types[items.typeIndex.get(id) ?? -1]).filter((t) => t !== undefined);
    const pieces = entity.gear ? types.flatMap((t) => t.gear) : (kit.outfits.get(outfit)?.gear ?? []);
    const { weapons, armors } = rules.config;
    // The weapon: a worn item's template or id, else a gear piece, that the table names.
    let weapon: string | undefined;
    for (const type of types) weapon ??= weapons[type.template] ?? weapons[type.id];
    for (const piece of pieces) weapon ??= weapons[piece];
    // The armour: the material of the outermost piece over the torso.
    let armor: string | undefined;
    for (const id of pieces) {
      const piece = kit.gear.get(id);
      if (!piece) continue;
      const torso = [...piece.paint.filter((p) => p.regions.includes("torso")), ...piece.shells.filter((s) => s.chain === "torso"), ...piece.skirts];
      for (const surface of torso) armor = armors[surface.material] ?? armor;
    }
    const traits: UnitTraits = { weapon: weapon ?? look.weapon ?? "unarmed", armor: armor ?? look.armor ?? "flesh", family: look.family };
    traitCache.set(entity.id, { key, traits });
    return traits;
  };

  const cues = createCuePlayer(rules, game, {
    player: options.player,
    target: options.target,
    targetOf: (unit) => mirror.entities.get(unit)?.target ?? 0,
    place(unit, bone) {
      const e = mirror.entities.get(unit);
      if (!e) return null;
      if (options.bodyPlace(unit, bone, scratch)) return { x: scratch.x, y: scratch.y, z: scratch.z };
      const height = e.template?.look.height ?? 1.8;
      const radius = e.template?.look.radius ?? 0.4;
      // Hands and the weapon a little ahead of the unit, the main hand to its right.
      const ahead = bone === "hands" || bone === "weapon" ? radius * 0.9 : bone === "mainHand" || bone === "offHand" ? radius * 0.5 : 0;
      const side = bone === "mainHand" || bone === "weapon" ? radius * 0.7 : bone === "offHand" ? -radius * 0.7 : 0;
      const sin = Math.sin(e.facing);
      const cos = Math.cos(e.facing);
      return { x: e.x + sin * ahead + cos * side, y: e.y + height * BONE_HEIGHT[bone], z: e.z + cos * ahead - sin * side };
    },
    traits(unit) {
      const e = mirror.entities.get(unit);
      return e ? traitsOf(e) : {};
    },
    feelable: options.feelable,
    maxHealth: (unit) => mirror.entities.get(unit)?.resources.get(game.health)?.max ?? 0,
    height: (unit) => mirror.entities.get(unit)?.template?.look.height ?? 1.8,
    say: (unit, label, colour) => options.say?.(unit, label, colour),
    screen: (part) => screens.show(part),
  }, () => sfx, () => particles, () => feel);
  const screens = createScreenEffects(rules);
  const feel = createFeel();
  feel.setShake(options.shake ?? 1);
  // A unit gone from view takes what lasts on it (its cast, its auras) with it.
  mirror.onDespawn((entity) => {
    traitCache.delete(entity.id);
    cues.forget(entity.id);
  });

  const particles = createParticleSystem(rules);
  const flames = createPropEffects(particles, (id) => rules.effects.has(id), {
    // A large fire's sound, heard from the few nearest: not before the audio has started.
    play: (sound, at) => sfx?.play(sound, { at }) ?? null,
  });
  let renderer: ParticleRenderer | null = null;
  let surfaces: SurfaceProbe | null = null;
  let worldNow: World | null = null;
  let look: UnderwaterLook | null = null;
  let lastFrame = performance.now();

  // --- what the client sees happen ---
  const self = (target = options.player()): CueContext => ({ source: options.player(), target, skill: null, crit: false, periodic: false });
  /** Each unit's steps last frame, or for a capsule the ground it has covered since its last one. */
  const stepsSeen = new Map<number, { steps: number; walked: number; x: number; z: number }>();
  const footstep = (entity: MirroredEntity): void => {
    const surface = surfaces?.at(entity.x, entity.y, entity.z) ?? "dirt";
    cues.client("footstep", { source: entity.id, target: 0, skill: null, crit: false, periodic: false, values: { surface } });
  };
  /** Each body's water last frame: crossing from wading to swimming and back splashes (WATER.md). */
  const waterSeen = new Map<number, number>();
  const splash = (entity: MirroredEntity, event: "splashIn" | "splashOut"): void => {
    cues.client(event, { source: entity.id, target: 0, skill: null, crit: false, periodic: false });
  };
  /** The camera crossing the surface: the look, the muffle, the cues - and a gasp for air if the breath ran low. */
  const breathIndex = game.resourceIndex.get("breath");
  const cameraWater = (eye: { x: number; y: number; z: number } | null): void => {
    if (!worldNow || !eye) return;
    const w = worldNow.waterAt(eye.x, eye.z);
    const under = w.depth > 0 && eye.y < w.surface && !worldNow.buildingAt(eye.x, eye.y, eye.z);
    if (under === underwater) return;
    underwater = under;
    look?.set(under);
    muffle?.frequency.setTargetAtTime(under ? MUFFLED_HZ : 22000, muffle.context.currentTime, 0.05);
    const me = options.player();
    cues.client(under ? "underwaterOn" : "underwaterOff", { source: me, target: 0, skill: null, crit: false, periodic: false });
    const breath = breathIndex === undefined ? undefined : mirror.entities.get(me)?.resources.get(breathIndex);
    if (!under && breath && breath.max > 0 && breath.current < breath.max * 0.5) cues.client("gasp", { source: me, target: 0, skill: null, crit: false, periodic: false });
  };
  const stepAll = (): void => {
    const me = mirror.entities.get(options.player());
    if (!me) return;
    for (const entity of mirror.entities.values()) {
      const look = entity.template?.look;
      if (!look || look.shape === "box" || entity.lootable) continue;
      if (Math.hypot(entity.x - me.x, entity.z - me.z) > FOOTSTEP_REACH) {
        stepsSeen.delete(entity.id);
        continue;
      }
      const swimming = entity.water >= 2 ? 1 : 0;
      const wasSwimming = waterSeen.get(entity.id);
      if (wasSwimming !== undefined && wasSwimming !== swimming) splash(entity, swimming ? "splashIn" : "splashOut");
      waterSeen.set(entity.id, swimming);
      const steps = options.steps(entity.id);
      const seen = stepsSeen.get(entity.id);
      if (!seen) {
        stepsSeen.set(entity.id, { steps, walked: 0, x: entity.x, z: entity.z });
        continue;
      }
      if (steps >= 0) {
        // A body says when its feet come down.
        if (steps > seen.steps) footstep(entity);
        seen.steps = steps;
      } else if (entity.grounded) {
        // A capsule steps at a stride from its size.
        const moved = Math.hypot(entity.x - seen.x, entity.z - seen.z);
        if (moved < 3) seen.walked += moved;
        if (seen.walked > 0.5 + look.height * 0.5) {
          seen.walked = 0;
          footstep(entity);
        }
      }
      seen.x = entity.x;
      seen.z = entity.z;
    }
  };
  /** Each creature's target last frame, and when it last called out: a creature turning on someone
   *  - its target going from nobody to a unit - is its aggro. */
  const targets = new Map<number, { target: number; called: number }>();
  const aggroAll = (): void => {
    const now = performance.now() / 1000;
    for (const entity of mirror.entities.values()) {
      // Creatures, the ones with a threat table that can die: not players, not the dummy.
      const template = entity.template;
      if (!template?.threat || !template.mortal || (entity.flags & DEAD) !== 0) {
        targets.delete(entity.id);
        continue;
      }
      const seen = targets.get(entity.id);
      if (!seen) {
        // Seen already fighting: it turned before it came into view.
        targets.set(entity.id, { target: entity.target, called: -Infinity });
        continue;
      }
      if (!seen.target && entity.target && now - seen.called > AGGRO_AGAIN) {
        seen.called = now;
        // Its own family's call, not its victim's.
        const family = traitsOf(entity).family;
        cues.client("aggro", { source: entity.id, target: entity.target, skill: null, crit: false, periodic: false, values: family ? { family } : undefined });
      }
      seen.target = entity.target;
    }
  };
  /** Glints looping over everything that has loot to take - and a quest's ground objects (QUESTS.md). */
  const glints = new Map<number, CueHandle>();
  const glinting = (entity: { lootable: boolean; templateId: string } | undefined): boolean => !!entity && (entity.lootable || entity.templateId === options.game.quests.objects.template);
  const glintAll = (): void => {
    for (const entity of mirror.entities.values()) {
      if (glinting(entity) && !glints.has(entity.id)) {
        const handle = cues.client("lootable", { source: options.player(), target: entity.id, skill: null, crit: false, periodic: false });
        if (handle) glints.set(entity.id, handle);
      }
    }
    for (const [id, handle] of glints) {
      if (glinting(mirror.entities.get(id))) continue;
      handle.stop();
      glints.delete(id);
    }
  };
  // Loot opening, as the server says, at what is opened.
  let openLoot = 0;
  options.belongings.onChange(() => {
    const loot = options.belongings.loot?.entity ?? 0;
    if (loot && loot !== openLoot) cues.client("lootOpen", self(loot));
    openLoot = loot;
  });
  /** An item's rarity's id, from its type. */
  const rarityOf = (type: string): string => {
    const def = items.types[items.typeIndex.get(type) ?? -1];
    return def ? (items.rarities[def.rarity]?.id ?? "") : "";
  };
  /** What an item type's gear is made of, as an armour kind (`armors`), or undefined. */
  const armorOf = (type: string): string | undefined => {
    const def = items.types[items.typeIndex.get(type) ?? -1];
    for (const id of def?.gear ?? []) {
      const piece = kit.gear.get(id);
      for (const surface of [...(piece?.paint ?? []), ...(piece?.shells ?? []), ...(piece?.skirts ?? []), ...(piece?.pieces ?? [])]) {
        const armor = rules.config.armors[surface.material];
        if (armor) return armor;
      }
    }
    return undefined;
  };
  const itemIntent = (message: ClientMessage): void => {
    switch (message.type) {
      case "lootTake": {
        const loot = options.belongings.loot;
        if (!loot) return;
        // Taking all sounds like its best item, and the coins.
        const taken = message.slot === TAKE_ALL ? loot.items.filter((i) => i !== null) : [loot.items[message.slot]].filter((i) => i !== null && i !== undefined);
        if (taken.length > 0) {
          const best = taken.map((i) => items.types[items.typeIndex.get(i!.type) ?? -1]?.rarity ?? 0).reduce((a, b) => Math.max(a, b), 0);
          cues.client("itemTake", self(loot.entity), { rarity: items.rarities[best]?.id ?? "" });
        }
        if (message.slot === TAKE_ALL && loot.money.some((m) => m > 0)) cues.client("moneyTake", self(loot.entity));
        return;
      }
      case "itemPickUp": {
        const entity = mirror.entities.get(message.entity);
        if (entity?.templateId === GROUND_ITEM_TEMPLATE) cues.client("itemPickUp", self(entity.id));
        return;
      }
      case "itemDrop":
        cues.client("itemDrop", self());
        return;
      case "itemEquip":
      case "itemUnequip": {
        // Putting on and taking off sound like what the piece is made of.
        const item = message.type === "itemEquip" ? options.belongings.containers[message.from.container]?.[message.from.slot] : options.belongings.containers[EQUIPMENT]?.[message.slot];
        const armor = item ? armorOf(item.type) : undefined;
        cues.client(message.type === "itemEquip" ? "equip" : "unequip", { ...self(), values: armor ? { armor } : undefined }, { rarity: item ? rarityOf(item.type) : "" });
        return;
      }
      case "itemUse":
        cues.client("use", self());
        return;
    }
  };

  // --- the ambience: what surrounds the camera, worked out a few times a second ---
  const RING = [3, 6, 10, 16, 24, WATER_REACH, 55, 72, SEA_REACH];
  let surroundAt = -Infinity;
  let waterDistance = Infinity;
  let seaDistance = Infinity;
  /** Which way the river and the sea lie: each spoke's hit pulls towards it, the nearer the harder. */
  const waterWay: Bearing = { x: 0, z: 0, focus: 0 };
  const seaWay: Bearing = { x: 0, z: 0, focus: 0 };
  let life = 1;
  let indoors = false;
  const surroundings = (eye: { x: number; y: number; z: number }): void => {
    const world = worldNow;
    if (!world || time() - surroundAt < 400) return;
    surroundAt = time();
    indoors = !!world.buildingAt(eye.x, eye.y, eye.z);
    const here = world.sampleTerrain(eye.x, eye.z);
    life = LIFE[here.primaryBiome.id] ?? 0.6;
    // The nearest water and the nearest sea, feeling out along eight spokes: the sea is water over
    // ground that lies well under the sea's level (a river or a pond lies above it, or barely under
    // it where it meets the sea).
    waterDistance = Infinity;
    seaDistance = Infinity;
    const pulls = { water: { x: 0, z: 0, w: 0 }, sea: { x: 0, z: 0, w: 0 } };
    const look = (x: number, z: number, r: number, a: number): void => {
      const w = world.waterAt(x, z);
      if (w.depth <= 0.05) return;
      const isSea = SEA_LEVEL - world.heightAt(x, z) >= SEA_DEPTH;
      if (isSea) seaDistance = Math.min(seaDistance, r);
      else waterDistance = Math.min(waterDistance, r);
      // (Standing in it pulls every way at once: a weight with no direction.)
      const weight = Math.max(0, 1 - r / (isSea ? SEA_REACH : WATER_REACH)) ** 2;
      const pull = isSea ? pulls.sea : pulls.water;
      pull.w += weight;
      if (r > 0) {
        pull.x += Math.cos(a) * weight;
        pull.z += Math.sin(a) * weight;
      }
    };
    look(eye.x, eye.z, 0, 0);
    for (const r of RING) {
      if (waterDistance <= r && seaDistance <= r) break;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + (r % 2) * 0.2;
        look(eye.x + Math.cos(a) * r, eye.z + Math.sin(a) * r, r, a);
      }
      // (A river is not heard past its reach: past it, only the sea is looked for.)
      if (r >= WATER_REACH && seaDistance < Infinity) break;
    }
    for (const [pull, way] of [[pulls.water, waterWay], [pulls.sea, seaWay]] as const) {
      const length = Math.hypot(pull.x, pull.z);
      way.x = pull.x;
      way.z = pull.z;
      way.focus = pull.w > 0 ? length / pull.w : 0;
    }
  };
  const facing = { x: 0, z: 1 };
  const ambient = (eye: { x: number; y: number; z: number } | null, camera: Camera | null): void => {
    if (!ambience || !worldNow || !eye) return;
    surroundings(eye);
    if (camera) {
      const f = camera.getDirection(BABYLON_FORWARD);
      if (Math.hypot(f.x, f.z) > 1e-3) {
        facing.x = f.x;
        facing.z = f.z;
      }
    }
    const blend = worldNow.weatherBlend();
    const share = worldNow.undergroundShare();
    ambience.update({
      wind: blend.wind,
      rain: blend.rain,
      snow: blend.snow,
      hour: worldNow.getTimeOfDay(),
      underground: share,
      hollow: share > 0 ? hollow : null,
      indoors,
      waterDistance,
      seaDistance,
      life,
      waterBearing: waterWay,
      seaBearing: seaWay,
      facing,
    });
    // The stone's reverb on the effects underground: footsteps and blows ring in a cave, a mine, a crypt.
    if (echo) echo.gain.setTargetAtTime(ambience.mix().echo * 0.35, echo.context.currentTime, 0.3);
  };

  const at: Vec3 = { x: 0, y: 0, z: 0 };
  const forward: Vec3 = { x: 0, y: 0, z: 1 };
  const up: Vec3 = { x: 0, y: 1, z: 0 };
  return {
    events: (events) => cues.events(events),
    client: (name, context, match) => {
      cues.client(name, context, match);
    },
    itemIntent,
    watchScreens(...regions) {
      const ui = (name: string): void => {
        cues.client(name, self());
      };
      // A window is open while it shows: hidden or shown again by anything - its key, its close
      // cross, the layout closing the oldest for room - it is heard. Windows are the container's
      // children, added at any time; their own style is what opens and closes them.
      const shown = new Map<Element, boolean>();
      const visible = (w: Element): boolean => (w as HTMLElement).style.display !== "none";
      for (const r of regions) for (const w of r.children) shown.set(w, visible(w));
      const observer = new MutationObserver((changes) => {
        for (const change of changes) {
          for (const w of change.type === "childList" ? [...change.addedNodes] : [change.target]) {
            if (!(w instanceof HTMLElement) || !regions.includes(w.parentElement as HTMLElement)) continue;
            const now = visible(w);
            const was = shown.get(w);
            shown.set(w, now);
            if (was !== undefined && was !== now) ui(now ? "windowOpen" : "windowClose");
          }
        }
      });
      for (const r of regions) observer.observe(r, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
      unwatch.push(() => observer.disconnect());
      const listening = new AbortController();
      unwatch.push(() => listening.abort());
      const listen = { capture: true, signal: listening.signal };
      // The action bar: a spell or item lifted from the book, the bag or the bar, put on the bar, or
      // dragged off it.
      document.addEventListener("dragstart", (e) => {
        if (e.dataTransfer?.types.includes(ACTION_DRAG_TYPE)) ui("barLift");
      }, listen);
      document.addEventListener("drop", (e) => {
        if (e.dataTransfer?.types.includes(ACTION_DRAG_TYPE)) setTimeout(() => takenByBar() && ui("barPlace"), 0);
      }, listen);
      document.addEventListener("dragend", (e) => {
        // From a slot of the bar, let go of anywhere but the bar: the slot is cleared.
        if (e.dataTransfer?.types.includes("text/x-aiworld-bar-slot") && !takenByBar()) ui("barClear");
      }, listen);
    },
    setScene(scene, world) {
      renderer?.dispose();
      renderer = null;
      particles.clear();
      flames.clear();
      if (world) for (const group of world.effectGroups) flames.add(group.effects, (x, y, z) => ({ x, y, z }), group.shown);
      cues.stopAll();
      for (const handle of glints.values()) handle.stop();
      glints.clear();
      stepsSeen.clear();
      waterSeen.clear();
      targets.clear();
      look?.dispose();
      look = null;
      underwater = false;
      muffle?.frequency.setTargetAtTime(22000, muffle.context.currentTime, 0.05);
      worldNow = world ?? null;
      surroundAt = -Infinity;
      waterDistance = Infinity;
      seaDistance = Infinity;
      waterWay.focus = 0;
      seaWay.focus = 0;
      indoors = false;
      surfaces = world ? createSurfaceProbe(world, rules) : null;
      if (scene && world) look = createUnderwaterLook(scene, game.water.look);
      if (scene) renderer = createParticleRenderer(scene, particles, rules, undefined, world ? (x, z) => world.sampleTerrain(x, z).height : null);
    },
    update(camera) {
      const time = performance.now();
      const dt = Math.min(0.1, (time - lastFrame) / 1000);
      lastFrame = time;
      const eye = camera?.globalPosition ?? null;
      stepAll();
      cameraWater(eye);
      glintAll();
      aggroAll();
      cues.update();
      if (worldNow) flames.setDistance(worldNow.flameSettings.distance);
      if (eye) flames.update(eye, dt);
      particles.update(dt, eye);
      renderer?.update();
      // The shake moves what the camera looks at across the screen, leaving its orbit alone.
      const shake = feel.update(dt);
      const offset = (camera as ArcRotateCamera | null)?.targetScreenOffset;
      offset?.set(shake.x, shake.y);
      ambient(eye, camera);
      if (!sfx || !camera) return;
      const p = camera.globalPosition;
      const f = camera.getDirection(BABYLON_FORWARD);
      at.x = p.x;
      at.y = p.y;
      at.z = p.z;
      forward.x = f.x;
      forward.y = f.y;
      forward.z = f.z;
      sfx.setListener(at, forward, up);
    },
    setVolume(v) {
      volume = v;
      sfx?.setVolume(v);
    },
    setAmbienceVolume(v) {
      ambienceVolume = v;
      ambience?.setVolume(v);
    },
    setShake: (v) => feel.setShake(v),
    feel,
    sfx: () => sfx,
    ambience: () => ambience,
    setHollow(kind) {
      hollow = kind;
    },
    cues,
    particles,
    flames,
    stats: () => ({ ...(renderer?.stats() ?? { sprites: 0, meshes: 0 }), effects: particles.effects() }),
    dispose() {
      disposed = true;
      screens.dispose();
      stopWaiting();
      this.setScene(null);
      for (const stop of unwatch.splice(0)) stop();
      sfx?.dispose();
      sfx = null;
      ambience?.dispose();
      ambience = null;
    },
  };
}
