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

export interface PlayerLights {
  /** Lights `mesh` (whose middle is at its position) by the houses' lights nearest it - each frame. */
  update: (deltaSeconds: number) => void;
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
    for (const light of near) {
      const [lx, ly, lz] = light.position;
      const dx = p.x - lx, dy = p.y - ly, dz = p.z - lz;
      const distance = Math.hypot(dx, dy, dz);
      let strength = falloff(light, distance);
      if (light.facing) strength *= Math.max(0, (dx * light.facing[0] + dy * light.facing[1] + dz * light.facing[2]) / Math.max(distance, 1e-4));
      if (strength <= 0) continue;
      const reach = distance - CLEAR_OF_SOURCE - 0.4;
      const blocked = reach > 0 && collision.raycastAny({ x: lx + (dx / distance) * CLEAR_OF_SOURCE, y: ly + (dy / distance) * CLEAR_OF_SOURCE, z: lz + (dz / distance) * CLEAR_OF_SOURCE }, { x: dx, y: dy, z: dz }, reach);
      const was = seen.get(light) ?? (blocked ? 0 : 1);
      const now = blocked ? Math.max(0, was - FADE * deltaSeconds) : Math.min(1, was + FADE * deltaSeconds);
      seen.set(light, now);
      if (now > 0) lit.push({ light, strength: strength * now });
    }
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

  return { update };
}
