// Feedback in the game (see FEEDBACK.md): the combat events of each step played as cues - sounds,
// particle effects and hit feel - at the units the mirror knows (on their bodies' bones where they
// have bodies), heard and seen from the camera, which shakes in the player's own fights; and what
// the client sees happen itself - footsteps, loot glinting and being opened and taken, items
// equipped, used and dropped, a target picked. The sound effects start with the page's audio (the
// first click or key press); they and the particles live for the page, across dimensions, and each
// dimension's scene gets its own particle drawers.

import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { createFeel, type Feel, type Feelable } from "../feedback/feel";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { createParticleSystem, type ParticleSystem } from "../particles/system";
import { createParticleRenderer, type ParticleRenderer } from "../particles/render";
import { whenAudio } from "../audio/context";
import { createSfx, type Sfx, type Vec3 } from "../audio/sfx";
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
import type { CueHandle } from "../feedback/cues";

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
  /** Each frame: steps the particles and puts the listener on the camera. */
  update: (camera: Camera | null) => void;
  /** The Effects volume, 0..1. */
  setVolume: (volume: number) => void;
  /** The Screen shake setting, 0..1: 0 turns it off. */
  setShake: (scale: number) => void;
  feel: Feel;
  /** The sound effects player, once audio has started - for the console. */
  sfx: () => Sfx | null;
  cues: CuePlayer;
  particles: ParticleSystem;
  /** Particles drawn last frame. */
  stats: () => { sprites: number; meshes: number; effects: number };
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
  /** Where the packs are served from. */
  baseUrl?: string;
  /** Where a bone of a unit's body is, when it has one drawn (the player's, entityMeshes'). */
  bodyPlace: (unit: number, bone: Bone, out: Vector3) => boolean;
  /** A unit's drawn body or capsule, for hit feel. */
  feelable: (unit: number) => Feelable | null;
  /** The Screen shake setting to start with. */
  shake?: number;
  /** How many steps a unit's body has taken, or -1 for one without a body. */
  steps: (unit: number) => number;
  /** The own player's things, for what loot holds and what an item is. */
  belongings: BelongingsMirror;
}

/** Footsteps are heard from units this near the player, at most. */
const FOOTSTEP_REACH = 25;

const BABYLON_FORWARD = new Vector3(0, 0, 1);
const scratch = new Vector3();

/** How high up a unit's bones are, as a share of its height, until bodies say (step 3). */
const BONE_HEIGHT: Record<Bone, number> = { chest: 0.65, head: 0.92, feet: 0.03, mainHand: 0.55, offHand: 0.55, hands: 0.6, weapon: 0.6 };

export function createGameFeedback(options: GameFeedbackOptions): GameFeedback {
  const { rules, game, items, kit, mirror } = options;
  const baseUrl = options.baseUrl ?? import.meta.env.BASE_URL;
  let sfx: Sfx | null = null;
  let volume = options.volume;
  whenAudio((audio) => {
    sfx = createSfx(audio.ctx, audio.effects, rules, (sound, file) => `${baseUrl}packs/${sound.file.split("/")[0]}/${file}`);
    sfx.setVolume(volume);
    sfx.prewarm();
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
  }, () => sfx, () => particles, () => feel);
  const feel = createFeel();
  feel.setShake(options.shake ?? 1);
  // A unit gone from view takes what lasts on it (its cast, its auras) with it.
  mirror.onDespawn((entity) => {
    traitCache.delete(entity.id);
    cues.forget(entity.id);
  });

  const particles = createParticleSystem(rules);
  let renderer: ParticleRenderer | null = null;
  let surfaces: SurfaceProbe | null = null;
  let lastFrame = performance.now();

  // --- what the client sees happen ---
  const self = (target = options.player()): CueContext => ({ source: options.player(), target, skill: null, crit: false, periodic: false });
  /** Each unit's steps last frame, or for a capsule the ground it has covered since its last one. */
  const stepsSeen = new Map<number, { steps: number; walked: number; x: number; z: number }>();
  const footstep = (entity: MirroredEntity): void => {
    const surface = surfaces?.at(entity.x, entity.y, entity.z) ?? "dirt";
    cues.client("footstep", { source: entity.id, target: 0, skill: null, crit: false, periodic: false, values: { surface } });
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
  /** Glints looping over everything that has loot to take. */
  const glints = new Map<number, CueHandle>();
  const glintAll = (): void => {
    for (const entity of mirror.entities.values()) {
      if (entity.lootable && !glints.has(entity.id)) {
        const handle = cues.client("lootable", { source: options.player(), target: entity.id, skill: null, crit: false, periodic: false });
        if (handle) glints.set(entity.id, handle);
      }
    }
    for (const [id, handle] of glints) {
      if (mirror.entities.get(id)?.lootable) continue;
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
      case "itemEquip": {
        // Equipping sounds like what the piece is made of.
        const item = options.belongings.containers[message.from.container]?.[message.from.slot];
        const def = item ? items.types[items.typeIndex.get(item.type) ?? -1] : undefined;
        let armor: string | undefined;
        for (const id of def?.gear ?? []) {
          const piece = kit.gear.get(id);
          for (const surface of [...(piece?.paint ?? []), ...(piece?.shells ?? []), ...(piece?.skirts ?? []), ...(piece?.pieces ?? [])]) armor ??= rules.config.armors[surface.material];
        }
        cues.client("equip", { ...self(), values: armor ? { armor } : undefined }, { rarity: item ? rarityOf(item.type) : "" });
        return;
      }
      case "itemUse":
        cues.client("use", self());
        return;
    }
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
    setScene(scene, world) {
      renderer?.dispose();
      renderer = null;
      particles.clear();
      cues.stopAll();
      for (const handle of glints.values()) handle.stop();
      glints.clear();
      stepsSeen.clear();
      surfaces = world ? createSurfaceProbe(world, rules) : null;
      if (scene) renderer = createParticleRenderer(scene, particles, rules);
    },
    update(camera) {
      const time = performance.now();
      const dt = Math.min(0.1, (time - lastFrame) / 1000);
      lastFrame = time;
      const eye = camera?.globalPosition ?? null;
      stepAll();
      glintAll();
      cues.update();
      particles.update(dt, eye);
      renderer?.update();
      // The shake moves what the camera looks at across the screen, leaving its orbit alone.
      const shake = feel.update(dt);
      const offset = (camera as ArcRotateCamera | null)?.targetScreenOffset;
      offset?.set(shake.x, shake.y);
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
    setShake: (v) => feel.setShake(v),
    feel,
    sfx: () => sfx,
    cues,
    particles,
    stats: () => ({ ...(renderer?.stats() ?? { sprites: 0, meshes: 0 }), effects: particles.effects() }),
  };
}
