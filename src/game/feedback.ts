// Feedback in the game (see FEEDBACK.md): the combat events of each step played as cues - sounds
// and particle effects now, hit feel to come - at the units the mirror knows (on their bodies'
// bones where they have bodies), heard and seen from the camera. The sound effects start with the
// page's audio (the first click or key press); they and the particles live for the page, across
// dimensions, and each dimension's scene gets its own particle drawers.

import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { createParticleSystem, type ParticleSystem } from "../particles/system";
import { createParticleRenderer, type ParticleRenderer } from "../particles/render";
import { whenAudio } from "../audio/context";
import { createSfx, type Sfx, type Vec3 } from "../audio/sfx";
import { createCuePlayer, type Bone, type CueContext, type UnitTraits } from "../feedback/cues";
import type { FeedbackRules } from "../feedback/rules";
import type { GameRules } from "../sim/rules/gameRules";
import type { ItemRules } from "../sim/rules/itemRules";
import type { CombatEvent } from "../sim/skills/events";
import type { BodyKit } from "./characterBody";
import type { EntityMirror, MirroredEntity } from "./entityMirror";

export interface GameFeedback {
  /** A step's combat events. */
  events: (events: readonly CombatEvent[]) => void;
  /** A client event (`lootOpen`, `itemTake`...) at a unit or a point. */
  client: (name: string, context: CueContext, match?: { rarity?: string }) => void;
  /** The scene being drawn, for the particles: on entering a dimension, null on leaving. */
  setScene: (scene: Scene | null) => void;
  /** Each frame: steps the particles and puts the listener on the camera. */
  update: (camera: Camera | null) => void;
  /** The Effects volume, 0..1. */
  setVolume: (volume: number) => void;
  /** The sound effects player, once audio has started - for the console. */
  sfx: () => Sfx | null;
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
}

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
  mirror.onDespawn((entity) => traitCache.delete(entity.id));

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
  }, () => sfx, () => particles);

  const particles = createParticleSystem(rules);
  let renderer: ParticleRenderer | null = null;
  let lastFrame = performance.now();

  const at: Vec3 = { x: 0, y: 0, z: 0 };
  const forward: Vec3 = { x: 0, y: 0, z: 1 };
  const up: Vec3 = { x: 0, y: 1, z: 0 };
  return {
    events: (events) => cues.events(events),
    client: (name, context, match) => cues.client(name, context, match),
    setScene(scene) {
      renderer?.dispose();
      renderer = null;
      particles.clear();
      if (scene) renderer = createParticleRenderer(scene, particles, rules);
    },
    update(camera) {
      const time = performance.now();
      const dt = Math.min(0.1, (time - lastFrame) / 1000);
      lastFrame = time;
      const eye = camera?.globalPosition ?? null;
      particles.update(dt, eye);
      renderer?.update();
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
    sfx: () => sfx,
    particles,
    stats: () => ({ ...(renderer?.stats() ?? { sprites: 0, meshes: 0 }), effects: particles.effects() }),
  };
}
