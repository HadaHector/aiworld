import { createEngine } from "./core/engine";
import { WORLD_SEED } from "./world/worldData";
import { DEFAULT_DRAW_DISTANCE, nextPaint } from "./world/world";
import { createServer } from "./sim/server";
import { createLocalChannel } from "./sim/channel";
import { PROTOCOL_VERSION, type ClientMessage, type PlayerState, type Transfer } from "./sim/protocol";
import type { DimensionWorld } from "./sim/dimension";
import { createDimensionView, type DimensionView, type ViewSettings } from "./game/dimensionView";
import { createZoneLabel } from "./debug/zoneLabel";
import { createPositionPanel, type ViewSnapshot } from "./debug/positionPanel";
import { createLoadingScreen } from "./ui/loadingScreen";
import { createMusicControl } from "./ui/musicControl";
import { createGameMusic } from "./music/gameMusic";
import { BIOME_STYLES, BUILDING_STYLES, DEFAULT_STYLE } from "./music/places";
import { loadPackSet, type PackSet } from "./world/content/loadContent";
import { ContentError, formatIssue } from "./world/content/contentReader";
import type { WorldContent } from "./world/content/worldContent";

const canvasElement = document.getElementById("renderCanvas");
if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error("Expected a #renderCanvas canvas element in index.html");
}
const canvas: HTMLCanvasElement = canvasElement;

const loadingScreen = createLoadingScreen();

/** Stops on the loading screen with what went wrong - a broken pack listing every problem in it. */
function failLoading(title: string, error: unknown): never {
  loadingScreen.fail(title, error instanceof ContentError ? error.issues.map(formatIssue) : [String(error)]);
  throw error;
}

// Everything the world is generated from that is content rather than code - biomes, materials,
// plants - comes from the packs in public/packs. A broken pack stops here, with every problem listed
// on the loading screen, rather than halfway through generating a world from it. The packs are
// fetched once; each dimension resolves its own content from them when it is entered.
let packSet: PackSet;
let startContent: WorldContent;
try {
  loadingScreen.update("Loading content packs", 0, 0);
  packSet = await loadPackSet();
  startContent = packSet.resolve(null);
} catch (error) {
  failLoading("The content packs could not be loaded", error);
}

const engine = createEngine(canvas);

// The simulation, in this page: single player is a server of one, over an in-memory channel - the
// same server `npm run server` runs on its own (see SIMULATION.md). It holds the dimensions (see
// DIMENSIONS.md), and takes each from this page's own build of it rather than generating it again:
// the same, read-only, from the same seed.
const built = new Map<string, (world: DimensionWorld) => void>();
const server = createServer({
  seed: WORLD_SEED,
  config: packSet.config.name,
  packs: packSet.packs,
  dimensions: startContent.dimensions,
  loadDimension: (definition) => new Promise<DimensionWorld>((resolve) => built.set(definition.id, resolve)),
});
const channel = createLocalChannel();
server.connect(channel.server);
let playerId = -1;
let intentSeq = 0;

/** The dimension being drawn - null while travelling, between one and the next. */
let view: DimensionView | null = null;
/** A Transfer not acted on yet: the next frame starts building where it leads. */
let pendingTransfer: Transfer | null = null;
/** Set while a dimension is being built: no frames are drawn and the server is not stepped. */
let entering = false;
/** Where the player is, as the last snapshot that had it said - null since the last Transfer. */
let me: PlayerState | null = null;

/** Applies whatever the server has said since last time - where the player is now, above all. */
function takeServerMessages(): void {
  for (const message of channel.client.receive()) {
    if (message.type === "welcome") playerId = message.playerId;
    else if (message.type === "transfer") {
      pendingTransfer = message;
      me = null;
    } else if (message.type === "snapshot") {
      const mine = message.players.find((p) => p.id === playerId);
      if (mine) {
        me = mine;
        view?.character.show(mine);
      }
    }
  }
}
/** Sends a command and has the server take it at once, so a teleport is done when this returns -
 *  what the console's `goto` and the map's clicks always had. */
function command(message: ClientMessage): void {
  channel.client.send(message);
  server.step(0);
  takeServerMessages();
}
/** Asks the server to move the player to another dimension, and starts building where it sends it -
 *  at once rather than on the next frame, which a background tab never draws. */
function travel(dimension: string): void {
  if (entering) return;
  command({ type: "travel", dimension });
  if (pendingTransfer) void follow(false);
}

// What the settings panel sets, kept from one dimension to the next.
const settings: ViewSettings = { drawDistance: DEFAULT_DRAW_DISTANCE, trees: true, grass: true, shadows: true, wireframe: false, timeOfDay: 12 };

const zoneLabel = createZoneLabel();
const positionPanel = createPositionPanel((v) => view?.gotoView(v));
// Music for wherever the player is - see MUSIC.md. It starts with the first click or key press.
const musicControl = createMusicControl((volume) => music.setVolume(volume));
const music = createGameMusic(musicControl.volume);

/**
 * Tears down the dimension being drawn. Not inside `enter`: an async function's suspended frame can
 * keep its locals - the old view among them - alive across every await of the next build, and a
 * full-size world needs all the memory the last one held.
 */
function leave(): void {
  if (!view) return;
  settings.timeOfDay = view.world.getTimeOfDay();
  const old = view;
  view = null;
  old.dispose();
}

/**
 * Builds the dimension a Transfer sends the player to, behind the loading screen: the old view torn
 * down first, then the new content, scene and world; the server handed the page's build; Arrived
 * said; and the first frame drawn once the server has put the body in. Joining goes through here
 * too - the server's first message after Welcome is a Transfer.
 */
async function enter(transfer: Transfer, resume: boolean): Promise<void> {
  entering = true;
  // Already up on the first load, timing from the page's start.
  if (view) loadingScreen.show();
  leave();

  let content: WorldContent;
  try {
    content = transfer.dimension === startContent.dimension.id ? startContent : packSet.resolve(transfer.dimension);
  } catch (error) {
    failLoading(`The content for "${transfer.dimension}" could not be loaded`, error);
  }
  const next = await createDimensionView({
    engine,
    canvas,
    content,
    seed: transfer.seed,
    arrival: { x: transfer.x, z: transfer.z },
    settings,
    onProgress: (phase, completed, total) => loadingScreen.update(phase, completed, total),
    teleport: (x, z) => command({ type: "teleport", x, z }),
    travel,
  });
  built.get(transfer.dimension)?.(next.shared);
  built.delete(transfer.dimension);
  view = next;
  channel.client.send({ type: "arrived" });
  // The server puts the body in once it has the dimension too - a moment, as its load resolves.
  while (!me) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    server.step(0);
    takeServerMessages();
  }
  next.scene.onBeforeRenderObservable.add(frame);
  // Back where the page was last left, so a reload after a change shows the same spot.
  const resumeView = resume ? next.lastView.restore() : null;
  if (resumeView) next.gotoView(resumeView);

  // Render one frame explicitly before revealing the world, so the overlay never fades to a blank
  // canvas. Deliberately not hooked to onAfterRenderObservable/the render loop: those are driven by
  // requestAnimationFrame, which the browser pauses in a background tab - loading the page in one
  // would otherwise leave the loading screen up indefinitely.
  loadingScreen.update("Compiling shaders and drawing the first frame", 0, 0);
  // A paint for that line first - or a moment's wait, in a background tab, which never paints.
  await nextPaint();
  next.scene.render();
  loadingScreen.hide();
  entering = false;
}

/** One frame of the dimension being drawn - run before its scene renders. */
function frame(): void {
  const v = view;
  if (!v) return;
  const { world, character, camera, spectator } = v;
  const deltaSeconds = engine.getDeltaTime() / 1000;
  // The world streams, and its weather and light follow, wherever is being looked from: the player,
  // or the spectator camera while it flies.
  // What the player wants, to the server; the server steps; where the player is, back. While the
  // spectator camera flies the keys are its own, and the player stands.
  const started = performance.now();
  const intent = spectator.active ? { moveX: 0, moveZ: 0, run: false, jump: false } : character.readIntent(camera);
  intentSeq = (intentSeq + 1) & 0xffff;
  channel.client.send({ type: "intent", seq: intentSeq, ...intent });
  server.step(deltaSeconds);
  takeServerMessages();
  if (pendingTransfer) return;
  if (!spectator.active) {
    v.playerLights.update(deltaSeconds);
    v.placeLabels.update(character.mesh.position, v.scene.activeCamera);
    v.collisionPanel.addPlayerMs(performance.now() - started);
    v.cameraCollision.update(deltaSeconds);
  }
  const focus = spectator.active ? spectator.camera.position : character.mesh.position;
  world.updateChunks(focus.x, focus.z);
  v.debugMap.updateMarker(focus.x, focus.z, camera.alpha);
  const here = world.sampleTerrain(focus.x, focus.z);
  const zoneName = world.areaNames.get(here.primaryAreaId) ?? "Uncharted";
  zoneLabel.update(zoneName, here.primaryBiome.name, world.weather.describe(here.primaryAreaId));
  positionPanel.update(character.mesh.position, camera, zoneName, here.primaryBiome.name);
  v.lastView.remember(character.mesh.position, camera);
  // Inside a building with music of its own, that; else the zone's.
  const feet = spectator.active ? spectator.camera.position : character.mesh.position;
  const building = world.buildingAt(feet.x, feet.y, feet.z);
  const buildingStyle = building && BUILDING_STYLES[building.id];
  music.update(
    buildingStyle
      ? { style: buildingStyle, place: building.key, inside: true }
      : { style: BIOME_STYLES[here.primaryBiome.id] ?? DEFAULT_STYLE, place: here.primaryAreaId, inside: false },
  );
  musicControl.setStatus(music.status());
  // Day-night first: it owns the clock, and updateAtmosphere reads that clock's current value
  // (world.ts's updateAtmosphere calls sunLighting.getTimeHours() itself) - calling it after this
  // is what makes that read this frame's time rather than last frame's.
  world.updateWeather(deltaSeconds, here.areaWeights, focus.x, focus.z);
  world.updateDayNight(deltaSeconds, here.areaWeights);
  world.updateAtmosphere(here.areaWeights);
}

// Right-click (a click, not a drag) to put the player where the pointer is: on what it hits in the
// collision world - a roof, a floor, a tree - or, past where that reaches, on the ground drawn.
{
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 2) down = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (e.button !== 2 || !down || !view) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 4) return;
    const { scene, world, character } = view;
    const rect = canvas.getBoundingClientRect();
    const ray = scene.createPickingRay(e.clientX - rect.left, e.clientY - rect.top, null, scene.activeCamera);
    const origin = { x: ray.origin.x, y: ray.origin.y, z: ray.origin.z };
    const direction = { x: ray.direction.x, y: ray.direction.y, z: ray.direction.z };
    const hit = world.collision.world.raycast(origin, direction, 3000);
    if (hit) {
      // Stood on what it hit - or, on a wall, just in front of it.
      const radius = character.settings.radius;
      const lift = hit.normal.y > 0.5 ? 0.05 : 0;
      const off = hit.normal.y > 0.5 ? 0 : radius * 1.2;
      command({ type: "teleportTo", x: hit.point.x + hit.normal.x * off, y: hit.point.y + lift, z: hit.point.z + hit.normal.z * off });
      return;
    }
    const pick = scene.pickWithRay(ray, (mesh) => mesh.name.startsWith("terrainChunk_"));
    if (pick?.hit && pick.pickedPoint) command({ type: "teleport", x: pick.pickedPoint.x, z: pick.pickedPoint.z });
  });
}

/**
 * `goto`, then force every chunk around the new position to build right away instead of
 * streaming in over many frames - what a console session testing a spot always wants and `goto`
 * alone never gave it, so every session was hand-writing the same `for` loop calling
 * `updateChunks` a few thousand times afterward. `updateChunks` is already a no-op once its
 * queue is empty (see chunkManager.ts's `takeNearestQueued`), so an iteration count generous
 * enough for the worst case (a couple thousand chunks at the top of the draw-distance slider)
 * costs nothing extra once the ordinary case (a few hundred) has already drained.
 */
function gotoLoaded(target: Partial<ViewSnapshot> & { x: number; z: number }, iterations = 6000): void {
  if (!view) return;
  view.gotoView(target);
  for (let i = 0; i < iterations; i++) {
    view.world.updateChunks(target.x, target.z, true);
  }
}

/**
 * A deliberate, permanent debug surface. `goto` restores a view captured by the position panel's
 * copy button, which is what makes a reported location reproducible rather than a set of numbers
 * someone has to translate by hand; the rest is here so the console can poke at the live world
 * without the app having to be re-instrumented to investigate anything. `world`, `scene`, `camera`
 * and the rest are the current dimension's: they change on travel.
 */
(window as unknown as { __aiworld: unknown }).__aiworld = {
  goto: (target: Partial<ViewSnapshot> & { x: number; z: number }) => view?.gotoView(target),
  gotoLoaded,
  /** Goes to feature `id` (world.features): a settlement's square, or in front of a quarry looking
   *  into it - its floor, its face. */
  gotoFeature(id: number): void {
    const feature = view?.world.features[id];
    if (!feature) return;
    const q = feature.quarry;
    if (!q) {
      gotoLoaded({ x: feature.x, z: feature.z, beta: 1.1, radius: 60 });
      return;
    }
    const x = q.x + q.ax * (q.halfLength + 25);
    const z = q.z + q.az * (q.halfLength + 25);
    // The camera's alpha is measured from +x; it sits behind the character, so it looks along -dir.
    gotoLoaded({ x, z, alpha: Math.atan2(q.az, q.ax), beta: 1.25, radius: 30 });
  },
  /** Goes to another dimension (see DIMENSIONS.md) - `travel("isles")`. Resolves once it is drawn. */
  async travel(dimension: string): Promise<void> {
    travel(dimension);
    while (pendingTransfer || entering) await new Promise((resolve) => setTimeout(resolve, 50));
  },
  /** The dimension being drawn, by id. */
  get dimension() {
    return currentDimension;
  },
  get world() {
    return view?.world;
  },
  music,
  /** The player as drawn, with teleports that go through the server like the map's. */
  get character() {
    return (
      view && {
        ...view.character,
        teleport: (x: number, z: number) => command({ type: "teleport", x, z }),
        teleportTo: (feet: { x: number; y: number; z: number }) => command({ type: "teleportTo", ...feet }),
      }
    );
  },
  /** The simulation running in this page - `server.debug` has its dimensions and players. */
  server,
  get camera() {
    return view?.camera;
  },
  get spectator() {
    return view?.spectator;
  },
  /** The collision profiler's last half second (see debug/collisionPanel.ts). */
  collisionProfile: () => view?.collisionPanel.last,
  get scene() {
    return view?.scene;
  },
  engine,
};

window.addEventListener("keydown", (e) => {
  if (!view || entering) return;
  if (e.key.toLowerCase() === "m") {
    view.debugMap.toggle();
  }
  if (e.key.toLowerCase() === "t") {
    view.textureBrowser.toggle();
  }
});

/** The dimension last entered, by id. */
let currentDimension = "";

/** Starts building whatever dimension the server has sent the player to. */
async function follow(resume: boolean): Promise<void> {
  const transfer = pendingTransfer!;
  pendingTransfer = null;
  currentDimension = transfer.dimension;
  await enter(transfer, resume);
}

// Joining is travelling: the server answers Hello with a Transfer to the first dimension -
// `?dimension=isles` asks for one (debug).
command({ type: "hello", protocol: PROTOCOL_VERSION, name: "player", dimension: new URLSearchParams(location.search).get("dimension") ?? "" });
if (!pendingTransfer) throw new Error("The server sent no dimension to enter");
await follow(true);

engine.runRenderLoop(() => {
  if (entering) return;
  if (pendingTransfer) {
    void follow(false);
    return;
  }
  view?.scene.render();
});

window.addEventListener("resize", () => {
  engine.resize();
});
