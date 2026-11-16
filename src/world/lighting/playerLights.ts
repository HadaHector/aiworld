import { Color3, Light, PointLight, Vector3, type Mesh, type Scene } from "@babylonjs/core";
import type { ModelLight } from "../buildings/buildingTypes";
import type { CollisionWorld } from "../collision/index";
import { falloff } from "./lightBake";
import type { SunLighting } from "./sunLighting";

/** How many of the houses' lights light the player at once. */
const COUNT = 3;
/** How fast a light fades in or out as a wall comes between it and the player (per second). */
const FADE = 6;
/** A ray to the player starts this far out of the light, clear of whatever holds it. */
const CLEAR_OF_SOURCE = 0.3;
/** How many of the lights the player sees light the bodies round it (creatures, other players). */
const AROUND = 4;
/** How far past its own reach from the player a light is still one of those. */
export const AROUND_REACH = 12;
/** Babylon's point light fades straight to nothing at its range; at this share of the bake's radius
 *  it is half as strong a third of the way out, as the bake's is (lightBake.ts, falloff). */
const AROUND_RANGE = 0.6;

export interface PlayerLights {
  /** Lights `mesh` (whose middle is at its position) by the houses' lights nearest it - each frame. */
  update: (deltaSeconds: number) => void;
  /** Has the same lights light another mesh too - the player's body and gear (game/playerBody.ts). */
  include: (other: Mesh) => void;
}

/**
 * The player lit by the houses' own lights - a fire, a lantern, a window's daylight - without
 * shadows (see LIGHTS.md): the few nearest it, as a fixed pool of Babylon point lights moved and
 * dimmed each frame (a StandardMaterial recompiles when its count of lights changes, so none are
 * ever added or taken away). Lit only `mesh`: the world's own shaders ignore Babylon's lights, but
 * a stray StandardMaterial need not pay for them.
 *
 * So a fire in the next room does not light the player through the wall, each light is checked by a
 * ray from it to the player against the collision world, and fades out while it is blocked.
 */
export function createPlayerLights(
  scene: Scene,
  mesh: Mesh,
  lightsNear: (x: number, y: number, z: number) => ModelLight[],
  collision: CollisionWorld,
  sun: SunLighting,
): PlayerLights {
  const pool = Array.from({ length: COUNT }, (_, i) => {
    const light = new PointLight(`playerLight${i}`, Vector3.Zero(), scene);
    light.includedOnlyMeshes = [mesh];
    light.specular = Color3.Black();
    // Its strength is worked out here, as the bake works out a texel's: the light's own fall-off
    // only keeps it from reaching further than it should.
    light.falloffType = Light.FALLOFF_STANDARD;
    light.intensity = 0;
    return light;
  });
  /** How much of each light the player sees, eased: 1 in plain view, 0 behind a wall. */
  const seen = new Map<ModelLight, number>();
  // The bodies round the player - creatures, other players - lit by the few lights the player sees,
  // each by its own distance from them (Babylon's fall-off, per pixel): any StandardMaterial but the
  // player's own, which has the pool above. A torch the player cannot see lights nothing; a body
  // behind the wall from one the player can is lit through it - seldom seen from where the player is.
  const around = Array.from({ length: AROUND }, (_, i) => {
    const light = new PointLight(`aroundLight${i}`, Vector3.Zero(), scene);
    light.excludedMeshes = [mesh];
    light.specular = Color3.Black();
    light.falloffType = Light.FALLOFF_STANDARD;
    light.intensity = 0;
    return light;
  });
  const daylight = new Color3();

  function update(deltaSeconds: number): void {
    const p = mesh.position;
    // The daylight through a window, as the building shader has it.
    sun.ambientColor.scaleToRef(sun.ambientIntensity, daylight);
    daylight.r += sun.color.r * sun.intensity * 0.5;
    daylight.g += sun.color.g * sun.intensity * 0.5;
    daylight.b += sun.color.b * sun.intensity * 0.5;

    const near = lightsNear(p.x, p.y, p.z);
    const lit: { light: ModelLight; strength: number }[] = [];
    const shown: { light: ModelLight; distance: number; strength: number }[] = [];
    // The nearest few, past their reach too (for the bodies round the player).
    const nearest = near
      .map((light) => ({ light, distance: Math.hypot(p.x - light.position[0], p.y - light.position[1], p.z - light.position[2]) }))
      .filter((one) => one.distance < one.light.radius + AROUND_REACH)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, AROUND * 2);
    for (const { light, distance } of nearest) {
      const [lx, ly, lz] = light.position;
      const dx = p.x - lx, dy = p.y - ly, dz = p.z - lz;
      let strength = falloff(light, distance);
      if (light.facing) strength *= Math.max(0, (dx * light.facing[0] + dy * light.facing[1] + dz * light.facing[2]) / Math.max(distance, 1e-4));
      const reach = distance - CLEAR_OF_SOURCE - 0.4;
      const blocked = reach > 0 && collision.raycastAny({ x: lx + (dx / distance) * CLEAR_OF_SOURCE, y: ly + (dy / distance) * CLEAR_OF_SOURCE, z: lz + (dz / distance) * CLEAR_OF_SOURCE }, { x: dx, y: dy, z: dz }, reach);
      const was = seen.get(light) ?? (blocked ? 0 : 1);
      const now = blocked ? Math.max(0, was - FADE * deltaSeconds) : Math.min(1, was + FADE * deltaSeconds);
      seen.set(light, now);
      if (now <= 0) continue;
      if (strength > 0) lit.push({ light, strength: strength * now });
      if (!light.sky) shown.push({ light, distance, strength: light.intensity * now });
    }
    around.forEach((point, i) => {
      const one = shown[i];
      if (!one) {
        point.intensity = 0;
        return;
      }
      point.position.set(...one.light.position);
      point.range = one.light.radius * AROUND_RANGE;
      point.intensity = one.strength;
      point.diffuse.set(...one.light.color);
    });
    // Forget the lights left behind.
    if (seen.size > near.length * 2 + 16) for (const light of seen.keys()) if (!near.includes(light)) seen.delete(light);

    lit.sort((a, b) => b.strength - a.strength);
    pool.forEach((point, i) => {
      const one = lit[i];
      if (!one) {
        point.intensity = 0;
        return;
      }
      point.position.set(...one.light.position);
      point.range = 1000;
      point.intensity = one.strength;
      if (one.light.sky) point.diffuse.copyFrom(daylight);
      else point.diffuse.set(...one.light.color);
    });
  }

  return {
    update,
    include(other) {
      for (const light of pool) light.includedOnlyMeshes = [...light.includedOnlyMeshes.filter((m) => !m.isDisposed()), other];
      for (const light of around) light.excludedMeshes = [...light.excludedMeshes.filter((m) => !m.isDisposed()), other];
    },
  };
}
