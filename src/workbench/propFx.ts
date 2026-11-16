// Flames on the props in a workbench preview (PROP_EFFECTS.md): the particle system built from the
// packs as the fx page builds it, the prop effects manager running on what the stage put down.

import type { Scene } from "@babylonjs/core";
import { resolveFeedback, type FeedbackRules } from "../feedback/rules";
import { resolveGameRules } from "../sim/rules/gameRules";
import { resolveCreatureRules } from "../sim/rules/creatureRules";
import { WORLD_SEED } from "../world/world";
import type { PackSource } from "../world/content/resolveContent";
import { createParticleSystem } from "../particles/system";
import { createParticleRenderer } from "../particles/render";
import { createPropEffects } from "../world/props/propEffects";
import type { StagePlaced } from "./stage";

let cached: { key: string; rules: FeedbackRules } | null = null;

/** The feedback rules the packs make, kept while the particle files stay as they are. */
function rulesOf(packs: PackSource[]): FeedbackRules {
  const key = packs
    .flatMap((pack) => pack.files.filter((file) => /(^|\/)(particles|particleTextures|cues|sounds)\//.test(file.path)).map((file) => `${pack.id}/${file.path}:${file.text}`))
    .join("\n");
  if (cached?.key === key) return cached.rules;
  const game = resolveGameRules(packs);
  resolveCreatureRules(packs, game, WORLD_SEED);
  const rules = resolveFeedback(packs, game);
  cached = { key, rules };
  return rules;
}

/** Runs the flames of what the stage holds; returns what stops them. */
export function runPropEffects(packs: PackSource[], scene: Scene, placed: StagePlaced[]): () => void {
  if (!placed.some((p) => p.model.effects?.length)) return () => undefined;
  const rules = rulesOf(packs);
  const particles = createParticleSystem(rules);
  const renderer = createParticleRenderer(scene, particles, rules);
  const effects = createPropEffects(particles, (id) => rules.effects.has(id));
  for (const p of placed) if (p.model.effects?.length) effects.add(p.model.effects, p.place);
  const step = scene.onBeforeRenderObservable.add(() => {
    const camera = scene.activeCamera;
    if (!camera) return;
    const dt = Math.min(0.1, scene.getEngine().getDeltaTime() / 1000);
    const eye = { x: camera.globalPosition.x, y: camera.globalPosition.y, z: camera.globalPosition.z };
    effects.update(eye, dt);
    particles.update(dt, eye);
    renderer.update();
  });
  return () => {
    scene.onBeforeRenderObservable.remove(step);
    effects.clear();
    particles.clear();
    renderer.dispose();
  };
}
