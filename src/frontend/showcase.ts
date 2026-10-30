import { Vector3, type Engine } from "@babylonjs/core";
import { createDimensionView, type DimensionView, type ViewSettings } from "../game/dimensionView";
import { DEFAULT_DRAW_DISTANCE } from "../world/world";
import type { PackSet } from "../world/content/loadContent";
import type { FrontendRules } from "./frontendRules";
import type { Hud } from "../ui/hud";
/** The world behind the main menu, drawn with the camera drifting over it. */
export interface Showcase {
  readonly view: DimensionView;
  dispose: () => void;
}

/**
 * Builds the showcase world (FRONTEND.md, *Main menu*): the pack's config, seed and dimension, with
 * nobody in it, the clock stopped at its hour, and the camera going slowly round its point - rising
 * and falling a little, a whole turn in its period, so it loops without a cut. Draws itself from the
 * moment it is built until disposed.
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
  world.setTimeOfDay(rules.hour);
  const centre = new Vector3(cx, world.heightAt(cx, cz) + rules.camera.look, cz);
  const eye = new Vector3();
  const started = performance.now();
  const arc = rules.camera.arc;

  const frame = (): void => {
    const t = (performance.now() - started) / 1000;
    const phase = (t / rules.camera.period) * Math.PI * 2;
    // Along the arc and back, slowing at the ends - or round and round.
    const angle = arc ? ((arc[0] + arc[1]) / 2 + ((arc[1] - arc[0]) / 2) * Math.sin(phase)) * (Math.PI / 180) : phase;
    const x = cx + Math.cos(angle) * rules.camera.radius;
    const z = cz + Math.sin(angle) * rules.camera.radius;
    // Over the higher of the ground below the camera and the point it circles, so a hill on the
    // way does not swallow it.
    const ground = Math.max(world.heightAt(x, z), centre.y - rules.camera.look);
    eye.set(x, ground + rules.camera.height + Math.sin(phase * 3) * rules.camera.bob, z);
    camera.setTarget(centre);
    camera.setPosition(eye);
    world.updateChunks(cx, cz);
    const here = world.sampleTerrain(cx, cz);
    world.updateWeather(engine.getDeltaTime() / 1000, here.areaWeights, cx, cz);
    // The clock stands still: a day-night step of nothing keeps the light where the hour put it.
    world.updateDayNight(0, here.areaWeights);
    world.updateAtmosphere(here.areaWeights);
  };
  scene.onBeforeRenderObservable.add(frame);
  const render = (): void => scene.render();
  engine.runRenderLoop(render);

  return {
    view,
    dispose() {
      engine.stopRenderLoop(render);
      view.dispose();
    },
  };
}
