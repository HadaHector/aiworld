// First, so it can wrap the buffer constructors before anything allocates (`?memory`).
import "./debug/installMemoryTracking";
import { createEngine } from "./core/engine";
import { WORLD_SEED } from "./world/worldData";
import { DEFAULT_DRAW_DISTANCE, nextPaint } from "./world/world";
import { createServer } from "./sim/server";
import { createLocalChannel } from "./sim/channel";
import { PROTOCOL_VERSION, type ClientMessage, type EntityMotion, type Transfer } from "./sim/protocol";
import { createEntityMirror } from "./game/entityMirror";
import { createEntityMeshes, type EntityMeshes } from "./game/entityMeshes";
import { createEntityPanel } from "./debug/entityPanel";
import { describeEntity } from "./sim/entityText";
import type { DimensionWorld } from "./sim/dimension";
import { createDimensionView, type DimensionView, type ViewSettings } from "./game/dimensionView";
import { createZoneLabel } from "./debug/zoneLabel";
import { describeMemory, memoryReport } from "./debug/memoryPanel";
import { createPositionPanel, type ViewSnapshot } from "./debug/positionPanel";
import { createLoadingScreen } from "./ui/loadingScreen";
import { createMusicControl } from "./ui/musicControl";
import { createGameMusic } from "./music/gameMusic";
import { BIOME_STYLES, BUILDING_STYLES, DEFAULT_STYLE } from "./music/places";
import { loadPackSet, type PackSet } from "./world/content/loadContent";
import { ContentError, formatIssue } from "./world/content/contentReader";
import type { WorldContent } from "./world/content/worldContent";
import { checkPlacements, resolveGameRules, type GameRules } from "./sim/rules/gameRules";
import { resolveItemRules, type ItemRules } from "./sim/rules/itemRules";
import { checkSkillRefs } from "./sim/rules/skillRules";
import { createBelongingsMirror } from "./game/belongingsMirror";
import { gearOfItems } from "./game/itemGear";
import { createInventoryScreen, createLootWindow } from "./ui/inventoryScreen";
import { GROUND_ITEM_TEMPLATE } from "./sim/items/itemSystem";
import { appearanceOf, lookFromUrl, type PlayerLook } from "./game/playerBody";
import { createBodyKit } from "./game/characterBody";
import { createCombatHud } from "./game/combatHud";
import { createFloatingText, type FloatingText } from "./game/floatingText";
import { nextEnemy } from "./game/targeting";
import { EVENT_KIND } from "./sim/skills/events";
import { FLAG } from "./sim/skills/flags";

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
let gameRules: GameRules;
let itemRules: ItemRules;
try {
  loadingScreen.update("Loading content packs", 0, 0);
  packSet = await loadPackSet();
  startContent = packSet.resolve(null);
  // Stats, resources and entity templates (see ENTITIES.md): once for the page, not per dimension.
  gameRules = resolveGameRules(packSet.sources);
  checkPlacements(gameRules, startContent.dimensions);
  // Items (see ITEMS.md): generated types depend on the world seed; the skills items name are checked.
  itemRules = resolveItemRules(packSet.sources, gameRules, WORLD_SEED);
  checkSkillRefs(gameRules, itemRules.abilityRefs);
} catch (error) {
  failLoading("The content packs could not be loaded", error);
}

const engine = createEngine(canvas);
// Who the player is, as far as their body goes - from the address, until there is character
// creation (see CHARACTERS.md): ?race=dwarf&outfit=knight&sex=female&look=7.
const playerLook = lookFromUrl();
/** Races, gear and outfits for everyone else's bodies, resolved once. */
const bodyKit = createBodyKit(packSet.sources);

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
  rules: gameRules,
  items: itemRules,
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
let me: EntityMotion | null = null;
/** Every entity the server has told this page of (see ENTITIES.md) - cleared on each Transfer. */
const mirror = createEntityMirror(gameRules);
/** The own player's bag, bank, equipment, wallet and open loot (see ITEMS.md) - as the server says. */
const belongings = createBelongingsMirror();
/** The other entities drawn in the current view's scene. */
let entityMeshes: EntityMeshes | null = null;
/** Damage and healing numbers over the units the own player fights, in the current view. */
let floatingText: FloatingText | null = null;
/** The unit the player has selected (see ABILITIES.md): 0 for none. */
let targetId = 0;

/** Applies whatever the server has said since last time - where the player is now, above all. */
function takeServerMessages(): void {
  for (const message of channel.client.receive()) {
    // What the own player wears goes on its body (ITEMS.md, *Equipment*).
    if (message.type === "entityGear" && message.id === playerId) view?.dress(gearOfItems(itemRules, message.gear));
    if (mirror.apply(message)) continue;
    if (belongings.apply(message)) continue;
    if (message.type === "welcome") {
      playerId = message.playerId;
      if (message.items !== itemRules.hash) console.warn(`The server's item rules (${message.items.toString(16)}) differ from this page's (${itemRules.hash.toString(16)}): items may show as the wrong things.`);
      if (message.rules !== gameRules.hash) console.warn(`The server's game rules (${message.rules.toString(16)}) differ from this page's (${gameRules.hash.toString(16)}): stats and resources may show under the wrong names.`);
    } else if (message.type === "transfer") {
      pendingTransfer = message;
      me = null;
      targetId = 0;
      mirror.clear();
      belongings.clear();
    } else if (message.type === "combatEvents") {
      // Swings are played on the body that swings; everything goes in the combat log.
      for (const event of message.events) {
        if (event.kind !== EVENT_KIND.animation || event.name !== "swing") continue;
        if (event.source === playerId) view?.character.swing();
        else entityMeshes?.swing(event.source);
      }
      combatHud.log(message.events);
      floatingText?.add(message.events);
    } else if (message.type === "snapshot") {
      const mine = message.entities.find((p) => p.id === playerId);
      if (mine) {
        me = mine;
        view?.character.show(mine, ((mirror.entities.get(playerId)?.flags ?? 0) & (1 << FLAG.dead)) !== 0);
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
  entityMeshes?.dispose();
  floatingText?.dispose();
  floatingText = null;
  entityMeshes = null;
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
    packs: packSet.sources,
    look: playerLook,
  });
  built.get(transfer.dimension)?.(next.shared);
  built.delete(transfer.dimension);
  view = next;
  const world = next.world;
  floatingText = createFloatingText(next.scene, mirror, gameRules, () => playerId);
  entityMeshes = createEntityMeshes(next.scene, mirror, gameRules, () => playerId, {
    kit: bodyKit,
    worldSeed: transfer.seed,
    onBody: (meshes) => meshes.forEach((mesh) => world.castShadow(mesh)),
    items: itemRules,
  });
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
  for (const extra of extraPlayers) extra.step();
  server.step(deltaSeconds);
  takeServerMessages();
  if (pendingTransfer) return;
  if (targetId && !mirror.entities.has(targetId)) setTarget(0);
  entityMeshes?.setTarget(targetId);
  entityMeshes?.update();
  combatHud.update(targetId);
  floatingText?.update();
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

/** A debug command for the server, taken at once. */
function debugCommand(message: ClientMessage): void {
  command(message);
}

/** Makes an entity from a template a few metres in front of the player. */
function spawnInFront(template: string): void {
  const own = mirror.entities.get(playerId);
  if (!own) return;
  debugCommand({ type: "debugSpawn", template, x: own.x + Math.sin(own.facing) * 4, z: own.z + Math.cos(own.facing) * 4 });
}

/**
 * Debug: a second player in this page's server, over its own channel, as `npm run server -- --bot`
 * has one - walking a slow circle, so its body can be seen walk. It answers each Transfer with
 * Arrived at once, and its messages are read and dropped every frame.
 */
const extraPlayers: { step: () => void }[] = [];
function addPlayer(look: Partial<PlayerLook> = {}): void {
  const extra = createLocalChannel();
  server.connect(extra.server);
  const full: PlayerLook = { race: "elf", outfit: "apprentice", seed: 1 + extraPlayers.length, ...look };
  extra.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: `player ${extraPlayers.length + 2}`, dimension: currentDimension, look: appearanceOf(full) });
  let seq = 0;
  const started = performance.now() / 1000;
  extraPlayers.push({
    step() {
      for (const message of extra.client.receive()) if (message.type === "transfer") extra.client.send({ type: "arrived" });
      const t = performance.now() / 1000 - started;
      seq = (seq + 1) & 0xffff;
      extra.client.send({ type: "intent", seq, moveX: Math.cos(t / 4) * 0.25, moveZ: Math.sin(t / 4) * 0.25, run: false, jump: false });
    },
  });
}

/** The server's own account of an entity - single player has the server in the page. */
function inspectOnServer(id: number): string[] | null {
  const entity = server.debug.entity(id);
  return entity ? describeEntity(gameRules, entity) : null;
}

// The entity inspector (see ENTITIES.md): I toggles it; a left click on an entity shows it.
const entityPanel = createEntityPanel({
  rules: gameRules,
  mirror,
  ownId: () => playerId,
  command: debugCommand,
  spawnDummy: () => spawnInFront("trainingDummy"),
  inspectOnServer,
  itemTypes: itemRules.types.map((t) => ({ id: t.id, name: t.name })),
});

// Items (see ITEMS.md): B toggles the inventory; E loots or picks up the nearest thing in reach.
const sendItem = (message: ClientMessage): void => channel.client.send(message);
const inventory = createInventoryScreen({ game: gameRules, items: itemRules, mirror: belongings, send: sendItem });
createLootWindow({ game: gameRules, items: itemRules, mirror: belongings, send: sendItem });
/** The nearest entity with loot in reach of the own player, or 0. */
function nearestLootable(): number {
  const me = mirror.entities.get(playerId);
  if (!me) return 0;
  let best = 0;
  let nearest = itemRules.config.lootRange;
  for (const entity of mirror.entities.values()) {
    if (!entity.lootable) continue;
    const range = entity.templateId === GROUND_ITEM_TEMPLATE ? itemRules.config.pickUpRange : itemRules.config.lootRange;
    const distance = Math.hypot(entity.x - me.x, entity.z - me.z);
    if (distance <= range && distance <= nearest) {
      nearest = distance;
      best = entity.id;
    }
  }
  return best;
}
function interact(id = nearestLootable()): void {
  const entity = mirror.entities.get(id);
  if (!entity) return;
  if (entity.templateId === GROUND_ITEM_TEMPLATE) sendItem({ type: "itemPickUp", entity: id });
  else sendItem({ type: "lootOpen", entity: id });
}
window.addEventListener("keydown", (e) => {
  if (!view || entering || e.repeat) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (e.key.toLowerCase() === "e") interact();
});

// Combat (see ABILITIES.md): a target, spells on keys 1-9, the frames and the log.
function setTarget(id: number): void {
  targetId = id;
  channel.client.send({ type: "target", id });
  if (id && entityPanel.visible) entityPanel.select(id);
}
function castSpell(skill: number): void {
  intentSeq = (intentSeq + 1) & 0xffff;
  channel.client.send({ type: "cast", seq: intentSeq, skill, target: 0, x: NaN, z: NaN });
}
const combatHud = createCombatHud({
  rules: gameRules,
  mirror,
  ownId: () => playerId,
  onKey: castSpell,
  onRespawn: () => command({ type: "respawn" }),
});
window.addEventListener("keydown", (e) => {
  if (!view || entering || view.spectator.active) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === "Tab") {
    e.preventDefault();
    // The camera sits at its alpha from +x round the player, looking back across it.
    const alpha = view.camera.alpha;
    setTarget(nextEnemy(mirror, playerId, targetId, { x: -Math.cos(alpha), z: -Math.sin(alpha) }));
    return;
  }
  if (e.key === "Escape") {
    if (mirror.entities.get(playerId)?.cast) channel.client.send({ type: "stopCast" });
    else if (targetId) setTarget(0);
    return;
  }
  if (e.repeat) return;
  if (e.key.toLowerCase() === "r") {
    channel.client.send({ type: "attack", on: !mirror.own.attacking });
    return;
  }
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) {
    const skill = combatHud.keys()[n - 1];
    if (skill !== undefined) castSpell(skill);
  }
});
{
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 0) down = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (e.button !== 0 || !down || !view || !entityMeshes) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 4) return;
    const rect = canvas.getBoundingClientRect();
    const meshes = entityMeshes;
    const pick = view.scene.pick(e.clientX - rect.left, e.clientY - rect.top, (mesh) => meshes.entityOf(mesh) !== null);
    const id = pick?.hit ? meshes.entityOf(pick.pickedMesh) : null;
    if (id === null) return;
    // A click targets it; the inspector, if open, follows.
    setTarget(id);
  });
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
  /** Entities, stats and resources (see ENTITIES.md): what this page was told, the server's own
   *  account, and the inspector's debug commands. `entity` 0 (the default) is the own player. */
  entities: {
    rules: gameRules,
    /** The own player, as the mirror has it. */
    mine: () => mirror.entities.get(playerId),
    /** Every entity this page knows. */
    list: () => [...mirror.entities.values()],
    /** The server's breakdown of an entity, as text. */
    inspect: (id = playerId) => inspectOnServer(id)?.join("\n"),
    /** The server's own entity - single player only. */
    server: (id = playerId) => server.debug.entity(id),
    /** Abilities (ABILITIES.md): target, cast by skill id, start a skill's magic on an entity, kill. */
    target: (id: number) => setTarget(id),
    cast: (skill: string) => castSpell(gameRules.skillIndex.get(skill) ?? -1),
    apply: (skill: string, entity = 0) => debugCommand({ type: "debugApply", entity, skill: gameRules.skillIndex.get(skill) ?? -1 }),
    kill: (entity = 0, revive = false) => debugCommand({ type: "debugKill", entity, revive }),
    modify: (stat: string, kind: string, value: number, source = "debug", entity = 0) =>
      debugCommand({ type: "debugModifier", entity, stat: gameRules.statIndex.get(stat) ?? -1, kind: gameRules.kindIndex.get(kind) ?? -1, value, source }),
    removeSource: (source = "debug", entity = 0) => debugCommand({ type: "debugRemoveSource", entity, source }),
    combat: (inCombat: boolean, entity = 0) => debugCommand({ type: "debugCombat", entity, inCombat }),
    resource: (resource: string, delta: number, entity = 0) => debugCommand({ type: "debugResource", entity, resource: gameRules.resourceIndex.get(resource) ?? -1, delta }),
    spawn: (template = "trainingDummy") => spawnInFront(template),
    /** A second player (and third...) walking a circle near the start - its look as given, else an elf. */
    addPlayer,
    despawn: (entity: number) => debugCommand({ type: "debugDespawn", entity }),
    panel: entityPanel,
  },
  /** Items (see ITEMS.md): what this page was told of the own belongings, and the messages a
   *  player sends. Containers: 0 bag, 1 bank, 2 equipment. */
  items: {
    rules: itemRules,
    belongings,
    bag: () => belongings.containers[0].map((s, i) => s && `${i}: ${s.type}${s.count > 1 ? ` x${s.count}` : ""}`).filter(Boolean),
    worn: () => belongings.containers[2].map((s, i) => s && `${itemRules.slots[i].id}: ${s.type}`).filter(Boolean),
    catalogue: () => itemRules.types.map((t) => t.id),
    give: (type: string, count = 1) => sendItem({ type: "debugItem", item: type, count }),
    move: (from: { container: number; slot: number }, to: { container: number; slot: number }, count = 0) => sendItem({ type: "itemMove", from, to, count }),
    equip: (slot: number) => sendItem({ type: "itemEquip", from: { container: 0, slot } }),
    unequip: (slot: string) => sendItem({ type: "itemUnequip", slot: itemRules.slotIndex.get(slot) ?? -1 }),
    use: (slot: number) => sendItem({ type: "itemUse", from: { container: 0, slot } }),
    drop: (slot: number, count = 0) => sendItem({ type: "itemDrop", from: { container: 0, slot }, count }),
    loot: (entity = nearestLootable()) => interact(entity),
    take: (slot = 0xffff) => sendItem({ type: "lootTake", slot }),
    wear: (what: "death" | "weapon" | "armour" | "repair") => sendItem({ type: "debugWear", what }),
    screen: inventory,
    /** The server's own item system - single player only. */
    server: () => server.debug.items,
  },
  get camera() {
    return view?.camera;
  },
  get spectator() {
    return view?.spectator;
  },
  /** Where the memory goes (see debug/memoryPanel.ts): printed, and returned for poking at.
   *  `?memory` in the URL counts every big CPU buffer by what made it. */
  memory() {
    if (!view) return null;
    const report = memoryReport(engine, view.scene);
    console.log(describeMemory(report));
    return report;
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
command({ type: "hello", protocol: PROTOCOL_VERSION, name: "player", dimension: new URLSearchParams(location.search).get("dimension") ?? "", look: appearanceOf(playerLook) });
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
