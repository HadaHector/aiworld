import { Color3, Constants, Effect, Mesh, RawTexture, ShaderMaterial, Texture, Vector2, Vector3, VertexData, type Scene } from "@babylonjs/core";
import { mulberry32 } from "../rng";
import { WIND } from "../foliage/wind";
import { lerp } from "../mathUtils";

/**
 * One kind of precipitation: how many particles at full strength, the box of air around the camera
 * they fill, how they fall, and how each is drawn.
 */
interface FallSpec {
  name: string;
  count: number;
  /** The box around the camera, metres (x, y, z) - the particles wrap round inside it, so the same
   *  few thousand are always falling about the viewer wherever they go. */
  box: [number, number, number];
  /** Falling speed, metres a second. */
  fall: number;
  /** How far the wind carries it, per unit of wind strength, metres a second. */
  drift: number;
  /** A flake's wandering either side of its line, metres. */
  sway: number;
  /** A streak along the way it falls (rain), or a round flake facing the camera (snow). */
  streak: boolean;
  /** Its size: a streak's width and length, a flake's radius twice. */
  width: number;
  length: number;
  color: Color3;
  opacity: number;
}

const RAIN: FallSpec = { name: "rain", count: 18000, box: [40, 28, 40], fall: 14, drift: 2.5, sway: 0, streak: true, width: 0.018, length: 0.42, color: new Color3(0.72, 0.76, 0.82), opacity: 0.28 };
const SNOW: FallSpec = { name: "snow", count: 16000, box: [44, 28, 44], fall: 1.3, drift: 1.6, sway: 0.45, streak: false, width: 0.03, length: 0.03, color: new Color3(0.96, 0.97, 1.0), opacity: 0.9 };

const VERTEX_SHADER = `
precision highp float;
attribute vec3 position;
attribute vec4 seed;
uniform mat4 viewProjection;
uniform vec3 eye;
uniform vec3 cameraRight;
uniform vec3 cameraUp;
uniform float time;
uniform float amount;
uniform vec3 velocity;
uniform vec3 travel;
uniform vec3 box;
uniform float sway;
uniform float streak;
uniform vec2 size;
varying vec2 vCorner;
varying float vFade;

void main(void) {
  // Only the first share of the particles falls: a drizzle is the same rain, thinned out.
  if (seed.w > amount) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // How far the air has carried everything so far (summed frame by frame on the CPU, so a change
  // of wind changes only the speed from now on, never where every particle already is).
  vec3 p = seed.xyz * box + travel;
  p.x += sin(time * 0.9 + seed.w * 40.0) * sway;
  p.z += cos(time * 0.7 + seed.x * 50.0) * sway;
  // Wrapped round into the box about the eye, so the air around the viewer is always full.
  vec3 origin = eye - box * 0.5;
  p = origin + mod(p - origin, box);

  vec3 corner;
  if (streak > 0.5) {
    // A streak along its fall, turned about that line to face the eye.
    vec3 along = normalize(velocity);
    vec3 side = normalize(cross(along, normalize(eye - p)));
    corner = side * position.x * size.x + along * position.y * size.y;
  } else {
    corner = cameraRight * position.x * size.x + cameraUp * position.y * size.y;
  }

  // Faded in from the box's sides, so none pops in or out as it wraps, and out right at the eye.
  vec3 fromEye = abs(p - eye) / (box * 0.5);
  float edge = max(max(fromEye.x, fromEye.y), fromEye.z);
  vFade = (1.0 - smoothstep(0.7, 1.0, edge)) * smoothstep(1.0, 3.5, distance(p, eye));
  vCorner = position.xy;
  gl_Position = viewProjection * vec4(p + corner, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;
uniform vec3 color;
uniform float opacity;
uniform float streak;
varying vec2 vCorner;
varying float vFade;

void main(void) {
  float alpha;
  if (streak > 0.5) {
    // Soft across, tapering to both ends.
    alpha = (1.0 - abs(vCorner.x)) * (1.0 - vCorner.y * vCorner.y);
  } else {
    alpha = 1.0 - smoothstep(0.35, 1.0, length(vCorner));
  }
  alpha *= opacity * vFade;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

/** How many splashes there are at full rain, how far round the player they land, and how long one
 *  lasts, seconds. */
const SPLASH_COUNT = 900;
const SPLASH_RADIUS = 16;
const SPLASH_LIFE = 0.35;

const SPLASH_VERTEX_SHADER = `
precision highp float;
attribute vec3 position;
attribute vec4 splash;
attribute float water;
uniform mat4 viewProjection;
uniform vec3 cameraRight;
uniform float time;
varying vec2 vCorner;
varying float vAge;
varying float vPart;
varying float vWater;

void main(void) {
  float age = (time - splash.w) / ${SPLASH_LIFE.toFixed(3)};
  // On land only the spray: a flat ring there would cut into any slope it lay on.
  if (age < 0.0 || age > 1.0 || (position.z < 0.5 && water < 0.5)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 corner;
  if (position.z < 0.5) {
    // The ring, lying on the ground and spreading.
    corner = vec3(position.x, 0.0, position.y) * mix(0.04, 0.22, sqrt(age));
  } else {
    // The spray, standing up off it and facing the camera.
    // Smaller on land, where a drop mostly soaks in.
    float spray = mix(0.6, 1.0, water);
    corner = (cameraRight * position.x * 0.08 + vec3(0.0, (position.y * 0.5 + 0.5) * 0.14, 0.0)) * spray;
  }
  vWater = water;
  vCorner = position.xy;
  vAge = age;
  vPart = position.z;
  gl_Position = viewProjection * vec4(splash.xyz + corner, 1.0);
}
`;

const SPLASH_FRAGMENT_SHADER = `
precision highp float;
uniform vec3 color;
uniform float opacity;
varying vec2 vCorner;
varying float vAge;
varying float vPart;
varying float vWater;

void main(void) {
  float alpha;
  if (vPart < 0.5) {
    // A thin ring at the quad's edge, fading as it spreads.
    float r = length(vCorner);
    alpha = smoothstep(0.7, 0.88, r) * (1.0 - smoothstep(0.9, 1.0, r)) * (1.0 - vAge);
  } else {
    // A few droplets thrown up in a crown: thin upright streaks, highest in the middle, gone by
    // half the splash's life.
    float x = vCorner.x;
    float y = vCorner.y * 0.5 + 0.5;
    float lanes = abs(fract(x * 2.5 + 0.5) - 0.5) * 2.0;
    float height = 0.35 + 0.65 * (1.0 - abs(x));
    float rise = min(1.0, vAge * 4.0) * height;
    alpha = (1.0 - smoothstep(0.25, 0.6, lanes)) * step(y, rise) * (1.0 - smoothstep(0.25, 0.5, vAge)) * (1.0 - abs(x));
  }
  // Faint on land: a hint of the drops landing, not a show.
  alpha *= opacity * mix(0.35, 1.0, vWater);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

/** `value` brought into [0, size). */
function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

export interface Precipitation {
  /** Sets how hard it rains and snows (0-1 each) and how bright the light is that the drops and
   *  flakes are seen by - every frame. */
  update: (rain: number, snow: number, light: Color3, leaves?: number) => void;
  /** Where the splashes land round: the player's feet. */
  setCentre: (x: number, z: number) => void;
  dispose: () => void;
}

/**
 * Rain and snow: a few thousand particles in a box of air that follows the camera, each a quad whose
 * place is worked out in the vertex shader from its own random seed and the time - so falling costs
 * the CPU nothing, and a weather's amount only says how many of them are drawn (the rest are put
 * outside the screen). Rain falls as streaks along its slant, snow as soft flakes drifting and
 * wandering; both blow with the weather's wind.
 */
export function createPrecipitation(scene: Scene, heightAt: (x: number, z: number) => number, coverAt: (x: number, z: number) => number = () => 1): Precipitation {
  Effect.ShadersStore["precipitationVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["precipitationFragmentShader"] = FRAGMENT_SHADER;
  Effect.ShadersStore["splashVertexShader"] = SPLASH_VERTEX_SHADER;
  Effect.ShadersStore["splashFragmentShader"] = SPLASH_FRAGMENT_SHADER;
  const splashes = buildSplashes(scene, heightAt);

  let time = 0;
  scene.onBeforeRenderObservable.add(() => {
    // Wrapped now and then, before the shader's floats lose their place - a box-full of particles
    // jumping once an hour, unseen in the rain.
    time = (time + scene.getEngine().getDeltaTime() / 1000) % 3600;
  });

  const layers = [RAIN, SNOW].map((spec) => ({ ...buildLayer(scene, spec), velocity: new Vector3(), travel: new Vector3() }));
  const lit = new Color3();
  const leaves = buildLeaves(scene);
  const leafLight = new Color3();
  let lastTime = 0;

  function update(rain: number, snow: number, light: Color3, leafAmount = 0): void {
    const camera = scene.activeCamera;
    if (!camera) return;
    const view = camera.getViewMatrix();
    // The camera's right and up, out of its view matrix's rows.
    const right = new Vector3(view.m[0], view.m[4], view.m[8]);
    const up = new Vector3(view.m[1], view.m[5], view.m[9]);
    splashes.update(rain, time, right, light);
    updateLeaves(leafAmount, right, up, camera.globalPosition, light);
    // The frame's step, from the same clock the shader sways by (wrapped hourly: a wrap is no step).
    const step = time >= lastTime ? time - lastTime : 0;
    lastTime = time;
    [rain, snow].forEach((amount, i) => {
      const { spec, mesh, material, velocity, travel } = layers[i];
      mesh.setEnabled(amount > 0.001);
      velocity.set(WIND.x * spec.drift, -spec.fall, WIND.y * spec.drift);
      // Carried on whether drawn or not, wrapped within the box so it never grows out of a float.
      travel.set(
        wrap(travel.x + velocity.x * step, spec.box[0]),
        wrap(travel.y + velocity.y * step, spec.box[1]),
        wrap(travel.z + velocity.z * step, spec.box[2]),
      );
      if (amount <= 0.001) return;
      // Lit mostly by how bright the light is, a little by its colour - snow stays white under a
      // warm sky, only dimmer.
      const brightness = (light.r + light.g + light.b) / 3;
      lit.set(lerp(brightness, light.r, 0.3), lerp(brightness, light.g, 0.3), lerp(brightness, light.b, 0.3));
      spec.color.multiplyToRef(lit, lit);
      material.setFloat("time", time);
      material.setFloat("amount", amount);
      material.setVector3("velocity", velocity);
      material.setVector3("travel", travel);
      material.setVector3("eye", camera.globalPosition);
      material.setVector3("cameraRight", right);
      material.setVector3("cameraUp", up);
      material.setColor3("color", lit);
    });
  }

  // The leaves fall slowly and blow with the wind; their place is carried on the CPU as rain's is.
  let leafTime = 0;
  // The grid of tree cover the leaves are masked by: laid a couple of rows a frame round the player,
  // swapped in whole when done, and begun again when the player strays from its middle.
  const gridCentre = new Vector3(0, 0, COVER_CELLS * COVER_CELL);
  const building = { x: NaN, z: NaN, row: COVER_CELLS, data: new Uint8Array(COVER_CELLS * COVER_CELLS * 4) };
  let centreSet = false;
  function layCover(eye: Vector3): void {
    if (building.row >= COVER_CELLS && (!centreSet || Math.hypot(eye.x - gridCentre.x, eye.z - gridCentre.y) > COVER_RELAY)) {
      building.x = Math.round(eye.x / COVER_CELL) * COVER_CELL;
      building.z = Math.round(eye.z / COVER_CELL) * COVER_CELL;
      building.row = 0;
    }
    if (building.row >= COVER_CELLS) return;
    // The first laying is done at once, so the leaves never stand in a cleared wood for a moment.
    const rows = centreSet ? COVER_ROWS_PER_FRAME : COVER_CELLS;
    for (let n = 0; n < rows && building.row < COVER_CELLS; n++, building.row++) {
      const z = building.z + (building.row + 0.5 - COVER_CELLS / 2) * COVER_CELL;
      for (let i = 0; i < COVER_CELLS; i++) {
        const x = building.x + (i + 0.5 - COVER_CELLS / 2) * COVER_CELL;
        const at = (building.row * COVER_CELLS + i) * 4;
        const level = Math.round(Math.max(0, Math.min(1, coverAt(x, z))) * 255);
        building.data[at] = level;
        building.data[at + 1] = level;
        building.data[at + 2] = level;
        building.data[at + 3] = 255;
      }
    }
    if (building.row >= COVER_CELLS) {
      leaves.coverData.set(building.data);
      leaves.cover.update(leaves.coverData);
      gridCentre.set(building.x, building.z, COVER_CELLS * COVER_CELL);
      leaves.material.setVector3("coverGrid", gridCentre);
      centreSet = true;
    }
  }

  function updateLeaves(amount: number, right: Vector3, up: Vector3, eye: Vector3, light: Color3): void {
    const { mesh, material, travel } = leaves;
    const step = time >= leafTime ? time - leafTime : 0;
    leafTime = time;
    mesh.setEnabled(amount > 0.001);
    travel.set(
      wrap(travel.x + WIND.x * LEAVES.drift * step, LEAVES.box[0]),
      wrap(travel.y - LEAVES.fall * step, LEAVES.box[1]),
      wrap(travel.z + WIND.y * LEAVES.drift * step, LEAVES.box[2]),
    );
    if (amount <= 0.001) return;
    layCover(eye);
    // Lit by the day, brightened a little so they read against the dark wood - but only by day: the lift
    // fades with the light, and at night they are darkened further, so they never glow in the dark.
    const brightness = (light.r + light.g + light.b) / 3;
    const day = Math.min(1, brightness / 0.6);
    const lift = 0.08 * day;
    const scale = 1.1 * (0.45 + 0.55 * day);
    leafLight.set(Math.min(1.2, light.r * scale + lift), Math.min(1.2, light.g * scale + lift), Math.min(1.2, light.b * scale + lift));
    material.setFloat("time", time);
    material.setFloat("amount", amount);
    material.setVector3("travel", travel);
    material.setVector3("eye", eye);
    material.setVector3("cameraRight", right);
    material.setVector3("cameraUp", up);
    material.setColor3("light", leafLight);
  }

  function dispose(): void {
    leaves.mesh.dispose();
    leaves.material.dispose();
    for (const { mesh, material } of layers) {
      mesh.dispose();
      material.dispose();
    }
    splashes.dispose();
  }

  return { update, setCentre: splashes.setCentre, dispose };
}

/**
 * Where the rain lands: a pool of splashes round the player, each dropped at a random spot at the
 * ground's own height (or on the water, where that is higher), living SPLASH_LIFE and then dropped
 * somewhere else - as many of them alive as the rain is heavy. A ring spreading on the ground and a
 * crown of droplets thrown up, both drawn by the shader from the splash's place and birth; the CPU
 * only picks the spots, a few hundred heights a second.
 */
function buildSplashes(scene: Scene, heightAt: (x: number, z: number) => number) {
  const random = mulberry32(0x5b1a);
  const positions = new Float32Array(SPLASH_COUNT * 8 * 3);
  const data = new Float32Array(SPLASH_COUNT * 8 * 4);
  const indices = new Uint32Array(SPLASH_COUNT * 12);
  const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let i = 0; i < SPLASH_COUNT; i++) {
    for (let part = 0; part < 2; part++) {
      const base = i * 8 + part * 4;
      for (let c = 0; c < 4; c++) positions.set([corners[c * 2], corners[c * 2 + 1], part], (base + c) * 3);
      indices.set([base, base + 1, base + 2, base, base + 2, base + 3], (i * 2 + part) * 6);
    }
  }
  // Every splash starts long dead: born far in the past.
  for (let i = 0; i < SPLASH_COUNT * 8; i++) data[i * 4 + 3] = -1000;
  const births = new Float32Array(SPLASH_COUNT).fill(-1000);
  // 1 where a splash lands on water, 0 on land - per vertex, the same for all eight of a splash's.
  const onWater = new Float32Array(SPLASH_COUNT * 8);

  const mesh = new Mesh("precipitation_splashes", scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.applyToMesh(mesh);
  mesh.setVerticesData("splash", data, true, 4);
  mesh.setVerticesData("water", onWater, true, 1);
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.isPickable = false;
  mesh.setEnabled(false);

  const material = new ShaderMaterial("precipitation_splashes", scene, "splash", {
    attributes: ["position", "splash", "water"],
    uniforms: ["viewProjection", "cameraRight", "time", "color", "opacity"],
    needAlphaBlending: true,
  });
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.alphaMode = Constants.ALPHA_COMBINE;
  material.setFloat("opacity", 0.55);
  mesh.material = material;

  let centreX = 0;
  let centreZ = 0;
  const lit = new Color3();
  const tint = new Color3(0.8, 0.84, 0.9);

  function update(rain: number, time: number, right: Vector3, light: Color3): void {
    mesh.setEnabled(rain > 0.001);
    if (rain <= 0.001) return;
    // As many alive as the rain is heavy: the first share of the pool.
    const alive = Math.round(SPLASH_COUNT * rain);
    let changed = false;
    for (let i = 0; i < alive; i++) {
      if (time >= births[i] - SPLASH_LIFE && time - births[i] < SPLASH_LIFE) continue;
      // Born a little apart in time, so they don't all land in step.
      const birth = time + random() * SPLASH_LIFE * 0.5;
      const angle = random() * Math.PI * 2;
      const distance = Math.sqrt(random()) * SPLASH_RADIUS;
      const x = centreX + Math.cos(angle) * distance;
      const z = centreZ + Math.sin(angle) * distance;
      const ground = heightAt(x, z);
      const y = Math.max(ground, 0) + 0.02;
      births[i] = birth;
      for (let v = 0; v < 8; v++) data.set([x, y, z, birth], (i * 8 + v) * 4);
      onWater.fill(ground < 0 ? 1 : 0, i * 8, i * 8 + 8);
      changed = true;
    }
    if (changed) {
      mesh.updateVerticesData("splash", data);
      mesh.updateVerticesData("water", onWater);
    }
    tint.multiplyToRef(light, lit);
    material.setColor3("color", lit);
    material.setFloat("time", time);
    material.setVector3("cameraRight", right);
  }

  function setCentre(x: number, z: number): void {
    centreX = x;
    centreZ = z;
  }

  function dispose(): void {
    mesh.dispose();
    material.dispose();
  }

  return { update, setCentre, dispose };
}


function buildLayer(scene: Scene, spec: FallSpec): { spec: FallSpec; mesh: Mesh; material: ShaderMaterial } {
  const random = mulberry32(spec.name === "rain" ? 0x7a1 : 0x5a0);
  const positions = new Float32Array(spec.count * 12);
  const seeds = new Float32Array(spec.count * 16);
  const indices = new Uint32Array(spec.count * 6);
  const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let i = 0; i < spec.count; i++) {
    // Evenly spread through the box; the last seed is the particle's rank, so a share of the
    // amount draws a share of them, scattered rather than in a corner.
    const seed = [random(), random(), random(), (i + random()) / spec.count];
    for (let c = 0; c < 4; c++) {
      positions.set([corners[c * 2], corners[c * 2 + 1], 0], i * 12 + c * 3);
      seeds.set(seed, i * 16 + c * 4);
    }
    indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const mesh = new Mesh(`precipitation_${spec.name}`, scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.applyToMesh(mesh);
  mesh.setVerticesData("seed", seeds, false, 4);
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.setEnabled(false);

  const material = new ShaderMaterial(`precipitation_${spec.name}`, scene, "precipitation", {
    attributes: ["position", "seed"],
    uniforms: ["viewProjection", "eye", "cameraRight", "cameraUp", "time", "amount", "velocity", "travel", "box", "sway", "streak", "size", "color", "opacity"],
    needAlphaBlending: true,
  });
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.alphaMode = Constants.ALPHA_COMBINE;
  material.setVector3("box", new Vector3(...spec.box));
  material.setFloat("sway", spec.sway);
  material.setFloat("streak", spec.streak ? 1 : 0);
  material.setVector2("size", new Vector2(spec.width, spec.length));
  material.setFloat("opacity", spec.opacity);
  material.setColor3("color", spec.color);
  mesh.material = material;
  return { spec, mesh, material };
}

// --- Falling leaves (the autumn wood's air layer) ---------------------------------------------------
// The same trick as rain and snow - a box of air about the camera, every place worked out in the
// vertex shader from a random seed and the clock - but each particle is a tumbling leaf: it turns in
// the plane facing the eye, flips edge-on now and then, sways wide on its way down, and wears one of
// the wood's colours (crimson, orange, gold, russet), picked from its seed.

const LEAVES = { count: 2600, box: [38, 22, 38] as [number, number, number], fall: 0.85, drift: 2.2, sway: 1.4, size: 0.085 };

const LEAF_VERTEX_SHADER = `
precision highp float;
attribute vec3 position;
attribute vec4 seed;
uniform mat4 viewProjection;
uniform vec3 eye;
uniform vec3 cameraRight;
uniform vec3 cameraUp;
uniform float time;
uniform float amount;
uniform vec3 travel;
uniform vec3 box;
uniform float sway;
uniform float size;
uniform vec3 light;
uniform sampler2D coverMap;
uniform vec3 coverGrid;
varying vec2 vCorner;
varying vec3 vColor;
varying float vFade;

vec3 leafColour(float h) {
  vec3 crimson = vec3(0.62, 0.10, 0.05);
  vec3 orange = vec3(0.86, 0.38, 0.07);
  vec3 gold = vec3(0.92, 0.68, 0.14);
  vec3 russet = vec3(0.48, 0.24, 0.08);
  if (h < 0.25) return crimson;
  if (h < 0.55) return orange;
  if (h < 0.85) return gold;
  return russet;
}

void main(void) {
  if (seed.w > amount) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float own = fract(seed.x * 91.7 + seed.z * 37.3);
  vec3 p = seed.xyz * box + travel;
  // Each leaf swings on its own slow, wide arc as it falls.
  float phase = seed.w * 61.0 + own * 6.28;
  p.x += sin(time * (0.5 + own * 0.5) + phase) * sway;
  p.z += cos(time * (0.4 + own * 0.5) + phase * 1.3) * sway;
  p.y += sin(time * 1.3 + phase) * 0.15;
  vec3 origin = eye - box * 0.5;
  p = origin + mod(p - origin, box);

  // Turned in the view plane, and flipped about its own axis so it narrows to a sliver and back.
  float spin = time * (0.6 + own * 1.8) * (own > 0.5 ? 1.0 : -1.0) + phase;
  float flip = 0.25 + 0.75 * abs(cos(time * (0.8 + own) + phase * 2.0));
  vec2 c = position.xy * vec2(1.0, flip);
  vec2 turned = vec2(c.x * cos(spin) - c.y * sin(spin), c.x * sin(spin) + c.y * cos(spin));
  float big = size * (0.7 + own * 0.8);
  vec3 corner = (cameraRight * turned.x + cameraUp * turned.y) * big;

  vec3 fromEye = abs(p - eye) / (box * 0.5);
  float edge = max(max(fromEye.x, fromEye.y), fromEye.z);
  // Only under trees: the cover (0-1) of the ground beneath it, read from a grid about the player.
  vec2 gridUv = (p.xz - coverGrid.xy) / coverGrid.z + 0.5;
  float cover = texture2D(coverMap, clamp(gridUv, 0.0, 1.0)).r;
  vFade = (1.0 - smoothstep(0.75, 1.0, edge)) * smoothstep(1.2, 3.0, distance(p, eye)) * smoothstep(0.25, 0.65, cover);
  // Lit by the day's light, and a little darker on its turned side.
  vColor = leafColour(fract(seed.y * 53.1 + seed.w * 7.0)) * light * (0.75 + 0.25 * flip);
  vCorner = position.xy;
  gl_Position = viewProjection * vec4(p + corner, 1.0);
}
`;

const LEAF_FRAGMENT_SHADER = `
precision highp float;
varying vec2 vCorner;
varying vec3 vColor;
varying float vFade;

void main(void) {
  // A pointed oval, with a pale midrib.
  float x = vCorner.x;
  float y = vCorner.y;
  float shape = 1.0 - (x * x * 1.6 + pow(abs(y), 1.6));
  if (shape < 0.0 || vFade < 0.01) discard;
  float rib = 1.0 - smoothstep(0.0, 0.12, abs(x));
  vec3 colour = mix(vColor, vColor * 1.35, rib * 0.5);
  gl_FragColor = vec4(colour, vFade);
}
`;

/** The cover grid under the leaves: cells a side, metres a cell, how far the player may stray from its
 *  centre before it is laid again, and how many rows are sampled a frame. */
const COVER_CELLS = 32;
const COVER_CELL = 1.5;
const COVER_RELAY = 4;
const COVER_ROWS_PER_FRAME = 2;

function buildLeaves(scene: Scene): { mesh: Mesh; material: ShaderMaterial; travel: Vector3; cover: RawTexture; coverData: Uint8Array } {
  Effect.ShadersStore["leavesVertexShader"] = LEAF_VERTEX_SHADER;
  Effect.ShadersStore["leavesFragmentShader"] = LEAF_FRAGMENT_SHADER;
  const random = mulberry32(0x1ea5);
  const { count, box } = LEAVES;
  const positions = new Float32Array(count * 12);
  const seeds = new Float32Array(count * 16);
  const indices = new Uint32Array(count * 6);
  const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let i = 0; i < count; i++) {
    const seed = [random(), random(), random(), (i + random()) / count];
    for (let c = 0; c < 4; c++) {
      positions.set([corners[c * 2], corners[c * 2 + 1], 0], i * 12 + c * 3);
      seeds.set(seed, i * 16 + c * 4);
    }
    indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const mesh = new Mesh("precipitation_leaves", scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.applyToMesh(mesh);
  mesh.setVerticesData("seed", seeds, false, 4);
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.setEnabled(false);
  const material = new ShaderMaterial("precipitation_leaves", scene, "leaves", {
    attributes: ["position", "seed"],
    uniforms: ["viewProjection", "eye", "cameraRight", "cameraUp", "time", "amount", "travel", "box", "sway", "size", "light", "coverGrid"],
    samplers: ["coverMap"],
    needAlphaBlending: true,
  });
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.alphaMode = Constants.ALPHA_COMBINE;
  material.setVector3("box", new Vector3(...box));
  material.setFloat("sway", LEAVES.sway);
  material.setFloat("size", LEAVES.size);
  // RGBA, the cover in every channel: a one-channel texture would not upload.
  const coverData = new Uint8Array(COVER_CELLS * COVER_CELLS * 4);
  const cover = RawTexture.CreateRGBATexture(coverData, COVER_CELLS, COVER_CELLS, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
  cover.name = "leaves_cover";
  cover.wrapU = Texture.CLAMP_ADDRESSMODE;
  cover.wrapV = Texture.CLAMP_ADDRESSMODE;
  material.setTexture("coverMap", cover);
  material.setVector3("coverGrid", new Vector3(0, 0, COVER_CELLS * COVER_CELL));
  mesh.material = material;
  return { mesh, material, travel: new Vector3(), cover, coverData };
}
