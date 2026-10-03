import { Color3, Constants, Effect, Mesh, ShaderMaterial, Vector2, Vector3, VertexData, type Scene } from "@babylonjs/core";
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
  update: (rain: number, snow: number, light: Color3) => void;
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
export function createPrecipitation(scene: Scene, heightAt: (x: number, z: number) => number): Precipitation {
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
  let lastTime = 0;

  function update(rain: number, snow: number, light: Color3): void {
    const camera = scene.activeCamera;
    if (!camera) return;
    const view = camera.getViewMatrix();
    // The camera's right and up, out of its view matrix's rows.
    const right = new Vector3(view.m[0], view.m[4], view.m[8]);
    const up = new Vector3(view.m[1], view.m[5], view.m[9]);
    splashes.update(rain, time, right, light);
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

  function dispose(): void {
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
