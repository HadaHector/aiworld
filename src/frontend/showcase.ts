import { Vector3, type Engine } from "@babylonjs/core";
import { createDimensionView, type DimensionView, type ViewSettings } from "../game/dimensionView";
import { createBodyKit, createCharacterBody, type BodyKit, type BodyLook, type CharacterBody } from "../game/characterBody";
import { DEFAULT_DRAW_DISTANCE } from "../world/world";
import type { PackSet } from "../world/content/loadContent";
import type { FrontendRules } from "./frontendRules";
import type { Hud } from "../ui/hud";

/** The world behind the main menu, drawn with the camera drifting over it - or on the stage, where
 *  the character list and character creation show a character. */
export interface Showcase {
  readonly view: DimensionView;
  /** The races, gear and outfits bodies are built from. */
  readonly kit: BodyKit;
  /** Shows a character on the stage, the camera going to it; null sends the camera back to its
   *  drift. A look like the last one shown changes nothing; another builds the new body behind the
   *  old one, which stays until it is ready. */
  stage: (look: BodyLook | null, framing?: Framing) => void;
  /** The character on the stage swings once - when its class is picked. */
  flourish: () => void;
  /** Whether the stage is waiting for the character asked for: none built yet, or the one shown is
   *  an older look - for a "preparing" label. */
  readonly preparing: boolean;
  dispose: () => void;
}

/** Where the character stands in the picture: in the middle, or right of it - clear of a panel on the left. */
export type Framing = "centre" | "right";

/** Seconds the camera takes between its drift and the stage. */
const GLIDE = 1.4;
/** The stage camera's nearest (the face) and farthest (the whole body), in metres. */
const NEAR = 1.1;
const FAR = 4.5;

const ease = (t: number): number => t * t * (3 - 2 * t);

/**
 * Builds the showcase world (FRONTEND.md, *Main menu*): the pack's config, seed and dimension, with
 * nobody in it, the clock stopped at its hour, and the camera going slowly round its point (or
 * swaying over its arc) a little up and down. Draws itself from the moment it is built until disposed.
 */
export async function createShowcase(options: {
  engine: Engine;
  canvas: HTMLCanvasElement;
  packSet: PackSet;
  rules: FrontendRules["showcase"];
  hud: Hud;
  onProgress: (phase: string, completed: number, total: number) => void;
}): Promise<Showcase> {
  const { engine, canvas, rules } = options;
  const content = options.packSet.resolve(rules.dimension || null);
  const [cx, cz] = rules.camera.around;
  const settings: ViewSettings = { drawDistance: DEFAULT_DRAW_DISTANCE, trees: true, grass: true, shadows: true, wireframe: false, timeOfDay: rules.hour };
  const view = await createDimensionView({
    engine,
    canvas,
    content,
    seed: rules.seed,
    arrival: { x: cx, z: cz },
    settings,
    onProgress: options.onProgress,
    teleport: () => {},
    travel: () => {},
    packs: options.packSet.sources,
    look: { race: "human", outfit: "scout", seed: 1 },
    body: false,
    hud: { graphics: options.hud.options.graphics, debugSettings: options.hud.debug.settings, debugStats: options.hud.debug.stats },
  });
  const { scene, world, camera } = view;
  // The camera is the menu's, not the player's: no drag, no lock on the capsule.
  camera.detachControl();
  camera.lockedTarget = null;
  camera.upperBetaLimit = Math.PI / 2;
  camera.minZ = 0.1;
  world.setTimeOfDay(rules.hour);
  const centre = new Vector3(cx, world.heightAt(cx, cz) + rules.camera.look, cz);
  const eye = new Vector3();
  const target = new Vector3();
  const started = performance.now();
  const arc = rules.camera.arc;

  // --- The stage ---
  const kit = createBodyKit(options.packSet.sources);
  const [sx, sz] = rules.stage.at;
  const stageY = world.heightAt(sx, sz);
  const stageFacing = (rules.stage.facing * Math.PI) / 180;
  let body: CharacterBody | null = null;
  let shown = "";
  let wanted: BodyLook | null = null;
  let building = false;
  /** 0 drifting, 1 on the stage; eased between. */
  let staged = 0;
  let toStage = false;
  /** How far the player has turned the character, and how close the camera is (0 far, 1 the face). */
  let turn = 0;
  let zoom = 0.25;
  /** How far the camera looks to the character's right, in metres at the farthest: 0 centres it. */
  let aside = 0;
  let asideWanted = 0;
  const head = new Vector3();
  /** How high the character's head is over the stage, eased. A body's bones are where its pose put
   *  them only once it has been drawn: frames posed since it came in, to wait for that. */
  let headHeight = 1.6;
  let posed = 0;

  function build(): void {
    if (building || !wanted) return;
    const look = wanted;
    const key = JSON.stringify(look);
    if (key === shown) return;
    building = true;
    void createCharacterBody(scene, "stageBody", kit, look, rules.seed)
      .then((made) => {
        building = false;
        if (disposed) return made.dispose();
        body?.dispose();
        body = made;
        posed = 0;
        shown = key;
        for (const mesh of made.meshes) world.castShadow(mesh);
        build();
      })
      .catch((error: unknown) => {
        building = false;
        console.warn("The stage's character could not be built:", error);
      });
  }

  // Dragging turns the character, the wheel brings the camera in to its face and out again.
  const listening = new AbortController();
  let dragging: number | null = null;
  canvas.addEventListener("pointerdown", (e) => (dragging = toStage ? e.clientX : null), { signal: listening.signal });
  window.addEventListener("pointerup", () => (dragging = null), { signal: listening.signal });
  window.addEventListener("pointermove", (e) => {
    if (dragging === null) return;
    turn -= (e.clientX - dragging) * 0.008;
    dragging = e.clientX;
  }, { signal: listening.signal });
  canvas.addEventListener("wheel", (e) => {
    if (!toStage) return;
    e.preventDefault();
    zoom = Math.min(1, Math.max(0, zoom - e.deltaY * 0.0012));
  }, { signal: listening.signal, passive: false });

  let disposed = false;
  let lastFrame = performance.now();
  const frame = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const t = (now - started) / 1000;
    const phase = (t / rules.camera.period) * Math.PI * 2;
    // Along the arc and back, slowing at the ends - or round and round.
    const angle = arc ? ((arc[0] + arc[1]) / 2 + ((arc[1] - arc[0]) / 2) * Math.sin(phase)) * (Math.PI / 180) : phase;
    const x = cx + Math.cos(angle) * rules.camera.radius;
    const z = cz + Math.sin(angle) * rules.camera.radius;
    // Over the higher of the ground below the camera and the point it circles, so a hill on the
    // way does not swallow it.
    const ground = Math.max(world.heightAt(x, z), centre.y - rules.camera.look);
    eye.set(x, ground + rules.camera.height + Math.sin(phase * 3) * rules.camera.bob, z);
    target.copyFrom(centre);

    staged = Math.min(1, Math.max(0, staged + (toStage ? dt : -dt) / GLIDE));
    if (body) {
      // Standing on the stage, shifting its weight a little now and then; turned as dragged.
      const sway = 0.12 * Math.sin(t * 0.35) + 0.05 * Math.sin(t * 0.9);
      body.show({ x: sx, y: stageY, z: sz, facing: stageFacing + turn + sway, grounded: true });
    }
    if (staged > 0) {
      // In front of the character, at the distance zoomed to, looking at its chest - or its face.
      const k = ease(staged);
      const distance = FAR + (NEAR - FAR) * zoom * (2 - zoom);
      // A new body's first frames read its head where its bones last were - near the world's
      // origin - which put the camera in the ground for a frame.
      if (body && ++posed > 2) {
        body.place("head", head);
        const height = head.y - stageY;
        if (height > 0.6 && height < 3) headHeight += (height - headHeight) * Math.min(1, dt * 6);
      }
      const lookY = stageY + headHeight * (0.62 + 0.38 * zoom);
      // In front of it: a body faces along (sin, cos) of its facing.
      const fx = Math.sin(stageFacing);
      const fz = Math.cos(stageFacing);
      // To one side, so the character stands right of the middle; less so close to its face.
      aside += (asideWanted - aside) * Math.min(1, dt * 3);
      const side = aside * (distance / FAR);
      const sideX = fz * side;
      const sideZ = -fx * side;
      const at = new Vector3(sx + fx * distance + sideX, lookY + 0.1 + 0.25 * (1 - zoom), sz + fz * distance + sideZ);
      eye.scaleInPlace(1 - k).addInPlace(at.scaleInPlace(k));
      target.scaleInPlace(1 - k).addInPlace(new Vector3(sx + sideX, lookY, sz + sideZ).scaleInPlace(k));
    }
    camera.setTarget(target);
    camera.setPosition(eye);
    world.updateChunks(cx, cz);
    const here = world.sampleTerrain(cx, cz);
    world.updateWeather(dt, here.areaWeights, cx, cz);
    // The clock stands still: a day-night step of nothing keeps the light where the hour put it.
    world.updateDayNight(0, here.areaWeights);
    world.updateAtmosphere(here.areaWeights);
  };
  scene.onBeforeRenderObservable.add(frame);
  const render = (): void => scene.render();
  engine.runRenderLoop(render);

  return {
    view,
    kit,
    stage(look, framing = "centre") {
      toStage = look !== null;
      asideWanted = framing === "right" ? 1.1 : 0;
      if (!look) return;
      wanted = look;
      build();
    },
    flourish: () => body?.swing(),
    get preparing() {
      return toStage && wanted !== null && shown !== JSON.stringify(wanted);
    },
    dispose() {
      disposed = true;
      listening.abort();
      engine.stopRenderLoop(render);
      body?.dispose();
      view.dispose();
    },
  };
}
