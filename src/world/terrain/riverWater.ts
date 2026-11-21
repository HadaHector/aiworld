import { Effect, Mesh, ShaderMaterial, VertexData, type Scene } from "@babylonjs/core";
import { WATER_SURFACE, type FlatWater } from "../water";
import type { SunLighting } from "../lighting/sunLighting";
import type { SkyDome } from "../sky/skyDome";
import type { RiverProfile } from "./rivers/riverLevels";
import { LIT_SHADING_GLSL, LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS, createLitShading } from "../materials/litShading";
import { WATER_ALPHA, WATER_DEEP_COLOR, WATER_SHALLOW_COLOR, WATER_TINT_FULL_DEPTH } from "./ocean";

// Water that is not the sea (WATER.md, *Water at its own level*): a river's surface as a ribbon that
// follows its centreline and steps down with it, and each flat body (a pond, a cave's pool) as a plane at
// its level. Unlike the ocean plane - which draws only reflection and glint, leaving the water's colour
// to the terrain shader, which tints against the one sea level - this water is above that level, so it
// draws its own body colour, by the depth of water under each vertex.

/** Across a river the ribbon has this many columns of quads. */
const RIBBON_COLUMNS = 8;
/** The scan for a river's waterline steps out from the centreline this far at a time, metres. */
const SHORE_SCAN_STEP = 1;
/** The ribbon reaches this far past the waterline it found, so the ground, not the ribbon's edge,
 *  draws the shore. */
const SHORE_OVERLAP = 1.5;
/** Past a river's source the ribbon runs on this far beyond where the ground meets its water. */
const SPRING_OVERRUN = 4;
/** An open edge (no bank) lies this far over the ground it is laid on. */
const DRAPE_LIFT = 0.05;
/** A river's ribbon ends this far under the sea's surface where it runs into the sea. */
const SEA_TUCK = 0.04;
/** Stations whose surface is no more than this over the sea's are left to the ocean plane. */
const SEA_COVERS = 0.05;
/** How fast a river's surface pattern runs downstream, metres a second - one speed for the whole river. */
const FLOW_SPEED = 1.1;
/** The plane for a flat body is lifted this little over its level, so a pool level with the sea never
 *  fights the ocean plane. */
const FLAT_LIFT = 0.01;

const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec3 position;
in vec2 uv;
in float waterDepth;
in vec4 flow;
uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
out vec3 vWorldPosition;
out vec3 vPositionFromCamera;
out vec2 vFrame;
out vec4 vFlow;
out float vDepth;
void main(void) {
  vec4 worldPosition = world * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  vPositionFromCamera = (view * worldPosition).xyz;
  vFrame = uv;
  vFlow = flow;
  vDepth = waterDepth;
  gl_Position = projection * view * worldPosition;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
${LIT_SHADING_GLSL}
in vec3 vWorldPosition;
in vec3 vPositionFromCamera;
in vec2 vFrame;
in vec4 vFlow;
in float vDepth;
out vec4 outColor;

uniform vec3 skyHorizon;
uniform vec3 skyZenith;
uniform float time;
uniform float rain;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// As the ocean's waves (ocean.ts): a scrolling noise's slope standing in for a wave's.
vec2 waveGradient(vec2 p, float scale, float strength) {
  vec2 uv = p * scale;
  float e = 0.35;
  return vec2(valueNoise(uv + vec2(e, 0.0)) - valueNoise(uv - vec2(e, 0.0)), valueNoise(uv + vec2(0.0, e)) - valueNoise(uv - vec2(0.0, e))) * strength;
}

void main(void) {
  // The pattern lives in the water's own frame - vFrame is (across, along) in metres, along growing
  // upstream - and runs down it at one speed for the whole body (vFlow.z: 0 for still water), so it
  // never shears: a speed that changed from vertex to vertex, times the clock, would smear it into
  // streaks. Ripples are drawn out along the current. vFlow.xy is the direction upstream in the world,
  // to turn the slope back into a world normal; vFlow.w how steeply the water falls there.
  float run = time * vFlow.z;
  vec2 p = vec2(vFrame.x, vFrame.y + run);
  vec2 q = vec2(vFrame.x, vFrame.y * 0.45 + run * 0.45);
  vec2 g = waveGradient(q, 0.3, 0.55) + waveGradient(p * 1.6 + 13.1, 0.55, 0.3) + waveGradient(vec2(vFrame.x, vFrame.y + run * 1.4), 1.3, 0.15);
  float rainTime = time * 7.0;
  g += waveGradient(vWorldPosition.xz + vec2(rainTime, -rainTime * 0.7), 2.8, 0.9 * rain);
  vec2 along = length(vFlow.xy) > 0.001 ? normalize(vFlow.xy) : vec2(0.0, 1.0);
  vec2 side = vec2(along.y, -along.x);
  vec2 grad = side * g.x + along * g.y;
  vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));

  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  vec3 lightDir = normalize(lightDirection);
  float ndl = max(dot(n, lightDir), 0.0);
  vec3 halfVec = normalize(viewDir + lightDir);
  float specular = pow(max(dot(n, halfVec), 0.0), 200.0) * lightIntensity * 1.5 * (1.0 - 0.75 * rain);
  float fresnel = pow(1.0 - clamp(dot(viewDir, n), 0.0, 1.0), 4.0);
  vec3 reflectDir = reflect(-viewDir, n);
  vec3 reflectedSky = mix(skyHorizon, skyZenith, smoothstep(0.0, 0.6, clamp(reflectDir.y, 0.0, 1.0)));
  reflectedSky = mix(reflectedSky, (skyHorizon + skyZenith) * 0.45, rain * 0.7);

  float sunLit = clamp((computeShadow(vWorldPosition, vec3(0.0, 1.0, 0.0), vPositionFromCamera.z) - SHADOW_DARKNESS) / (1.0 - SHADOW_DARKNESS), 0.0, 1.0);
  vec3 light = ambientColor * ambientIntensity + lightColor * lightIntensity * ndl * mix(0.35, 1.0, sunLit);

  // The water's own body: shallow to deep by the water under this point, fading to nothing at the shore
  // as the terrain's tint does for the sea.
  float deep = smoothstep(0.0, 2.5, vDepth);
  vec3 body = mix(vec3(${WATER_SHALLOW_COLOR.map((c) => c.toFixed(3)).join(", ")}), vec3(${WATER_DEEP_COLOR.map((c) => c.toFixed(3)).join(", ")}), deep) * light;
  float bodyAlpha = ${WATER_ALPHA.toFixed(3)} * smoothstep(0.0, ${WATER_TINT_FULL_DEPTH.toFixed(3)}, vDepth) * (0.7 + 0.45 * deep);
  // Fast water is broken: a little white where it runs quick and shallow.
  float foam = clamp(vFlow.w * 12.0, 0.0, 1.0) * (1.0 - deep * 0.5) * smoothstep(0.5, 0.8, valueNoise(vec2(vFrame.x * 0.9, (vFrame.y + run * 1.6) * 0.5)));
  body = mix(body, light * 0.9, foam * 0.6);

  float reflectAlpha = clamp(fresnel * 0.85 + 0.1, 0.0, 1.0) * ${WATER_ALPHA.toFixed(3)};
  vec3 glint = lightColor * specular * sunLit;
  float alpha = clamp(bodyAlpha + reflectAlpha * (1.0 - bodyAlpha) + max(glint.r, max(glint.g, glint.b)) + foam * 0.3, 0.0, 1.0);
  vec3 color = mix(body, reflectedSky, reflectAlpha / max(alpha, 0.001)) + glint;

  outColor = vec4(applyFog(color, length(vPositionFromCamera)), alpha);
}
`;

interface RibbonArrays {
  /** Where the ocean plane is cut away under a river: capsules, x0, z0, x1, z1, radius each. */
  holes: number[];
  positions: number[];
  uvs: number[];
  depths: number[];
  flows: number[];
  indices: number[];
}

/** The distance out from (x, z) along (nx, nz) at which the ground first stands at `level` (plus the
 *  overlap), or the reach with `open` set where it never does. */
function shoreDistance(heightAt: (x: number, z: number) => number, x: number, z: number, nx: number, nz: number, level: number, reach: number): { distance: number; open: boolean } {
  for (let d = SHORE_SCAN_STEP; d < reach; d += SHORE_SCAN_STEP) {
    if (heightAt(x + nx * d, z + nz * d) >= level) return { distance: d + SHORE_OVERLAP, open: false };
  }
  return { distance: reach, open: true };
}

/** One river's ribbon, as runs of stations over the sea's own surface. */
function addRiverRibbon(out: RibbonArrays, profile: RiverProfile, heightAt: (x: number, z: number) => number): void {
  const count = profile.level.length;
  const step = profile.length / (count - 1);
  let previousRow = -1;
  let previous: { x: number; z: number; radius: number; seaUnder: boolean } | null = null;
  const emit = (i: number, level: number): void => {
    const a = Math.max(0, i - 1);
    const b = Math.min(count - 1, i + 1);
    const tx = profile.x[b] - profile.x[a];
    const tz = profile.z[b] - profile.z[a];
    const tl = Math.hypot(tx, tz) || 1;
    // Across the river, and downstream (toward the mouth: station 0).
    const nx = -tz / tl;
    const nz = tx / tl;
    const fall = (profile.level[b] - profile.level[a]) / Math.max(1e-6, step * (b - a));
    const upX = tx / tl;
    const upZ = tz / tl;
    const x = profile.x[i];
    const z = profile.z[i];
    const leftShore = shoreDistance(heightAt, x, z, -nx, -nz, level, profile.reach[i]);
    const rightShore = shoreDistance(heightAt, x, z, nx, nz, level, profile.reach[i]);
    const left = leftShore.distance;
    const right = rightShore.distance;
    const row = out.positions.length / 3;
    let seaUnder = false;
    for (let c = 0; c <= RIBBON_COLUMNS; c++) {
      const d = -left + ((left + right) * c) / RIBBON_COLUMNS;
      const px = x + nx * d;
      const pz = z + nz * d;
      // Where no bank holds the water in (where two valleys meet, or at the sea), its edge is laid
      // down onto the ground, so it runs over rather than standing as a wall in the air.
      const open = (c === 0 && leftShore.open) || (c === RIBBON_COLUMNS && rightShore.open);
      out.positions.push(px, open ? Math.min(level, Math.max(heightAt(px, pz), WATER_SURFACE) + DRAPE_LIFT) : level, pz);
      out.uvs.push(d, i * step);
      out.flows.push(upX, upZ, FLOW_SPEED, fall);
      const ground = heightAt(px, pz);
      out.depths.push(Math.max(0, level - ground));
      if (ground < WATER_SURFACE && !open) seaUnder = true;
    }
    const here = { x, z, radius: Math.max(left, right), seaUnder };
    if (previousRow >= 0) {
      for (let c = 0; c < RIBBON_COLUMNS; c++) {
        const p0 = previousRow + c;
        const p1 = row + c;
        // Station i is upstream of i - 1; wound so the face looks up.
        out.indices.push(p0, p0 + 1, p1, p1, p0 + 1, p1 + 1);
      }
      // Where the river's water stands over ground that is under the sea's surface, the ocean plane is
      // cut away beneath it: it would otherwise show inside the channel, a second surface under the first.
      if (previous && (previous.seaUnder || here.seaUnder)) out.holes.push(previous.x, previous.z, x, z, Math.max(previous.radius, here.radius));
    }
    previousRow = row;
    previous = here;
  };
  for (let i = 0; i < count; i++) {
    const level = profile.level[i];
    if (level <= WATER_SURFACE + SEA_COVERS) {
      previousRow = -1;
      previous = null;
      continue;
    }
    // A run starting from the sea begins with the station before it, tucked just under the sea's surface,
    // so the river runs down into the sea rather than ending in the air over it.
    if (previousRow < 0 && i > 0) emit(i - 1, WATER_SURFACE - SEA_TUCK);
    emit(i, level);
  }
  // The spring: the ribbon runs straight on past the source until it is well under the ground there, so
  // the ground, not the ribbon's square end, draws where the water starts.
  if (previousRow >= 0 && count >= 2) {
    const n = count - 1;
    const ux = profile.x[n] - profile.x[n - 1];
    const uz = profile.z[n] - profile.z[n - 1];
    const ul = Math.hypot(ux, uz) || 1;
    const level = profile.level[n];
    const ahead = shoreDistance(heightAt, profile.x[n], profile.z[n], ux / ul, uz / ul, level, profile.reach[n]).distance + SPRING_OVERRUN;
    const cap = out.positions.length / 3;
    for (let c = 0; c <= RIBBON_COLUMNS; c++) {
      const k = (previousRow + c) * 3;
      const forward = ahead;
      const px = out.positions[k] + (ux / ul) * forward;
      const pz = out.positions[k + 2] + (uz / ul) * forward;
      out.positions.push(px, level, pz);
      out.uvs.push(out.uvs[(previousRow + c) * 2], n * step + forward);
      out.flows.push(ux / ul, uz / ul, FLOW_SPEED, 0);
      out.depths.push(0);
    }
    for (let c = 0; c < RIBBON_COLUMNS; c++) {
      const p0 = previousRow + c;
      const p1 = cap + c;
      out.indices.push(p0, p0 + 1, p1, p1, p0 + 1, p1 + 1);
    }
  }
}

/** A flat body's plane, as a fan over its polygon (convex enough for a pond or a pool). */
function addFlat(out: RibbonArrays, body: FlatWater, heightAt: (x: number, z: number) => number): void {
  const row = out.positions.length / 3;
  let cx = 0;
  let cz = 0;
  for (const p of body.polygon) {
    cx += p.x / body.polygon.length;
    cz += p.z / body.polygon.length;
  }
  const depthAt = (x: number, z: number): number => (body.kind === "pool" ? body.level - (body.bottom ?? body.level - 1) : Math.max(0, body.level - heightAt(x, z)));
  out.positions.push(cx, body.level + FLAT_LIFT, cz);
  out.uvs.push(cx, cz);
  out.flows.push(0, 1, 0, 0);
  out.depths.push(depthAt(cx, cz));
  for (const p of body.polygon) {
    out.positions.push(p.x, body.level + FLAT_LIFT, p.z);
    out.uvs.push(p.x, p.z);
    out.flows.push(0, 1, 0, 0);
    out.depths.push(depthAt(p.x, p.z));
  }
  const n = body.polygon.length;
  // Either winding: both faces are drawn for a flat body (a pool is also seen from below its rim).
  for (let k = 0; k < n; k++) out.indices.push(row, row + 1 + k, row + 1 + ((k + 1) % n));
}

export interface InlandWater {
  /** Where the ocean plane must not be drawn: under a river's water above the sea (see OceanPlane.setHoles). */
  readonly oceanHoles: readonly number[];
  /** Builds (again) the flat bodies' planes - after a feature adds one. */
  refreshFlats(): void;
  setRain(amount: number): void;
  dispose(): void;
}

/**
 * The world's water above the sea: every river at its own level, and the flat bodies. Nothing is built
 * for a world whose rivers sit at sea level and that has no flat bodies. Hidden underground (G1's
 * stopgap, as the ocean plane).
 */
export function createInlandWater(
  scene: Scene,
  sunLighting: SunLighting,
  sky: SkyDome,
  rivers: readonly RiverProfile[],
  flats: () => readonly FlatWater[],
  heightAt: (x: number, z: number) => number,
): InlandWater {
  Effect.ShadersStore["inlandWaterVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["inlandWaterFragmentShader"] = FRAGMENT_SHADER;
  const material = new ShaderMaterial("inlandWaterMaterial", scene, "inlandWater", {
    attributes: ["position", "uv", "waterDepth", "flow"],
    uniforms: ["world", "view", "projection", "skyHorizon", "skyZenith", "time", "rain", ...LIT_SHADING_UNIFORMS],
    samplers: LIT_SHADING_SAMPLERS,
  });
  material.backFaceCulling = false;
  material.alpha = 0.999;
  material.setFloat("rain", 0);
  createLitShading(scene, sunLighting).register(material);

  const meshFrom = (name: string, arrays: RibbonArrays): Mesh | null => {
    if (arrays.indices.length === 0) return null;
    const mesh = new Mesh(name, scene);
    const data = new VertexData();
    data.positions = arrays.positions;
    data.uvs = arrays.uvs;
    data.indices = arrays.indices;
    data.applyToMesh(mesh);
    mesh.setVerticesData("waterDepth", arrays.depths, false, 1);
    mesh.setVerticesData("flow", arrays.flows, false, 4);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.alwaysSelectAsActiveMesh = false;
    return mesh;
  };

  const riverArrays: RibbonArrays = { holes: [], positions: [], uvs: [], depths: [], flows: [], indices: [] };
  for (const profile of rivers) addRiverRibbon(riverArrays, profile, heightAt);
  const riverMesh = meshFrom("riverWater", riverArrays);
  let flatMesh: Mesh | null = null;
  const refreshFlats = (): void => {
    flatMesh?.dispose();
    const arrays: RibbonArrays = { holes: [], positions: [], uvs: [], depths: [], flows: [], indices: [] };
    for (const body of flats()) addFlat(arrays, body, heightAt);
    flatMesh = meshFrom("flatWater", arrays);
  };
  refreshFlats();

  let time = 0;
  const observer = scene.onBeforeRenderObservable.add(() => {
    const open = sunLighting.underground < 0.01;
    riverMesh?.setEnabled(open);
    // A pool is underground: shown there, as the rest of a cave is.
    if (flatMesh) flatMesh.setEnabled(true);
    if (!riverMesh && !flatMesh) return;
    time += scene.getEngine().getDeltaTime() / 1000;
    material.setFloat("time", time);
    material.setColor3("skyHorizon", sky.horizon);
    material.setColor3("skyZenith", sky.zenith);
  });

  return {
    oceanHoles: riverArrays.holes,
    refreshFlats,
    setRain: (amount) => material.setFloat("rain", amount),
    dispose: () => {
      scene.onBeforeRenderObservable.remove(observer);
      riverMesh?.dispose();
      flatMesh?.dispose();
      material.dispose();
    },
  };
}
