// A cave's light baked into its rock (DUNGEONS.md, *Light*): stored per vertex - surface nets'
// vertices are about a voxel apart, and a fire's light across rock is soft anyway, so nothing has to
// be unwrapped. Each vertex sums every fixture's light that reaches it, by its falloff and how
// squarely the rock faces it, where a ray from the light gets to it past the rock. Pure.
import type { ModelLight } from "../buildings/buildingTypes";
import { createCollisionWorld, vec3 } from "../collision/index";
import { falloff } from "../lighting/lightBake";
import { caveColliders, type CaveMesh } from "./caveField";

/** A ray toward a light starts this far off the rock, and stops this far short of the light. */
const OFF_ROCK = 0.15;
const SHORT_OF_LIGHT = 0.5;
/** How much of a light still reaches rock turned edge-on to it (light scattered round the rock). */
const WRAP = 0.25;

/** Each chunk's light: r, g, b per vertex. */
export function bakeCaveLight(cave: CaveMesh, lights: readonly ModelLight[]): { light: Float32Array[]; rays: number; ms: number } {
  const started = performance.now();
  const world = createCollisionWorld();
  world.addBatch(caveColliders(cave));
  let rays = 0;
  const light = cave.chunks.map((chunk) => {
    const P = chunk.positions, N = chunk.normals;
    const count = P.length / 3;
    const out = new Float32Array(count * 3);
    // The lights reaching the chunk's box at all.
    const size = (chunk.n - 1) * chunk.cell;
    const [ox, oy, oz] = chunk.origin;
    const reaching = lights.filter((l) => {
      const [lx, ly, lz] = l.position;
      const dx = Math.max(ox - lx, 0, lx - (ox + size)), dy = Math.max(oy - ly, 0, ly - (oy + size)), dz = Math.max(oz - lz, 0, lz - (oz + size));
      return Math.hypot(dx, dy, dz) < l.radius;
    });
    if (reaching.length === 0) return out;
    for (let v = 0; v < count; v++) {
      const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
      const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
      let r = 0, g = 0, b = 0;
      for (const l of reaching) {
        const dx = l.position[0] - px, dy = l.position[1] - py, dz = l.position[2] - pz;
        const d = Math.hypot(dx, dy, dz);
        if (d >= l.radius || d < 1e-3) continue;
        const facing = (dx * nx + dy * ny + dz * nz) / d;
        if (facing <= -WRAP) continue;
        const strength = falloff(l, d) * Math.max(0, (facing + WRAP) / (1 + WRAP));
        if (strength <= 1e-4) continue;
        // In the light's sight: a ray from just off the rock to just short of the light.
        const from = vec3(px + nx * OFF_ROCK, py + ny * OFF_ROCK, pz + nz * OFF_ROCK);
        const to = { x: l.position[0] - from.x, y: l.position[1] - from.y, z: l.position[2] - from.z };
        const reach = Math.hypot(to.x, to.y, to.z) - SHORT_OF_LIGHT;
        rays++;
        if (reach > 0 && world.raycastAny(from, to, reach)) continue;
        r += l.color[0] * strength;
        g += l.color[1] * strength;
        b += l.color[2] * strength;
      }
      out[v * 3] = r;
      out[v * 3 + 1] = g;
      out[v * 3 + 2] = b;
    }
    return out;
  });
  return { light, rays, ms: performance.now() - started };
}
