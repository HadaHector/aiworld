import type { Engine } from "@babylonjs/core";
import { DEFAULT_DRAW_DISTANCE, nextPaint } from "../world/world";
import { PROTOCOL_VERSION, type ClientMessage, type EntityMotion, type Transfer } from "../sim/protocol";
import { createEntityMirror } from "./entityMirror";
import { createEntityMeshes, type EntityMeshes } from "./entityMeshes";
import { createEntityPanel } from "../debug/entityPanel";
import { describeEntity } from "../sim/entityText";
import { createDimensionView, type DimensionView, type ViewSettings } from "./dimensionView";
import type { ZoneLabel } from "../debug/zoneLabel";
import { describeMemory, memoryReport } from "../debug/memoryPanel";
import type { PositionPanel, ViewSnapshot } from "../debug/positionPanel";
import type { LoadingScreen } from "../ui/loadingScreen";
import type { MusicControl } from "../ui/musicControl";
import { createGameFeedback, type GameFeedback } from "./feedback";
import { welcomeProblems, type Connection } from "./connection";
import { createLocalChannel } from "../sim/channel";
import type { WorldContent } from "../world/content/worldContent";
import type { GameMusic } from "../music/gameMusic";
import { BIOME_STYLES, BUILDING_STYLES, DEFAULT_STYLE } from "../music/places";
import { createBelongingsMirror } from "./belongingsMirror";
import { gearOfItems } from "./itemGear";
import { createInventoryScreen, createLootWindow } from "../ui/inventoryScreen";
import { GROUND_ITEM_TEMPLATE } from "../sim/items/itemSystem";
import { appearanceOf, type PlayerLook } from "./playerBody";
import { createBodyKit } from "./characterBody";
import { createCombatHud } from "./combatHud";
import { createFloatingText, type FloatingText } from "./floatingText";
import { createProgressMirror } from "./progressMirror";
import { createProgressPanel } from "../ui/progressPanel";
import { createRuleBook } from "../ui/ruleBook";
import { createMenuBar } from "../ui/menuBar";
import { createActionBar } from "../ui/actionBar";
import { createSpellBook } from "../ui/spellBook";
import { dock, type Hud } from "../ui/hud";
import { createHealthBars, type HealthBars } from "./healthBars";
import { nextEnemy } from "./targeting";
import { EVENT_KIND } from "../sim/skills/events";
import { FLAG } from "../sim/skills/flags";

/** What lasts the whole page, that a session draws into and plays through (see FRONTEND.md). */
export interface Page {
  engine: Engine;
  canvas: HTMLCanvasElement;
  loadingScreen: LoadingScreen;
  /** Stops on the loading screen with what went wrong. */
  failLoading: (title: string, error: unknown) => never;
  hud: Hud;
  zoneLabel: ZoneLabel;
  positionPanel: PositionPanel;
  musicControl: MusicControl;
  music: GameMusic;
}

/** Who the player is, until characters are saved and chosen (FRONTEND.md, *Dev shortcut*). */
export interface QuickCharacter {
  name: string;
  look: PlayerLook;
  /** Whether `look.race` was chosen, rather than left to the people's. */
  raceGiven: boolean;
  /** Slot to origin id; anything else is ignored. */
  origins: Record<string, string>;
  /** Debug: the dimension to start in, "" for the server's choice. */
  dimension: string;
}

export interface SessionOptions {
  /** The world's server, and the rules its seed and config made (game/connection.ts). */
  connection: Connection;
  /** Who plays: a quick, unsaved character made from these (`?play`), or a saved one by id, chosen
   *  from the connection's character list (FRONTEND.md, *Handshake*). */
  enter: { quick: QuickCharacter } | { character: string; dimension?: string };
}

/** One world being played: what `dispose` takes down again, leaving the page as it found it. */
export interface Session {
  /** Sounds and effects, for the page's volume and shake settings. */
  feedback: GameFeedback;
  /** Moves the view - the position panel's Go. */
  goto: (target: Partial<ViewSnapshot> & { x: number; z: number }) => void;
  dispose: () => void;
}

/**
 * Plays a character in a world, over its connection: builds the HUD's windows, bars and keys around
 * it, and draws the dimensions the server sends it to. Resolves once the first one is drawn; throws
 * (with the loading screen stopped on why) if the server will not let the character in.
 */
export async function startSession(page: Page, options: SessionOptions): Promise<Session> {
  const { engine, canvas, loadingScreen, hud, zoneLabel, positionPanel, musicControl, music } = page;
  const { connection } = options;
  const { seed, server, client } = connection;
  // Every listener on the window and canvas goes when the session does.
  const listening = new AbortController();
  const signal = listening.signal;
  function listenWindow<K extends keyof WindowEventMap>(type: K, handler: (e: WindowEventMap[K]) => void): void {
    window.addEventListener(type, handler, { signal });
  }
  function listenCanvas<K extends keyof HTMLElementEventMap>(type: K, handler: (e: HTMLElementEventMap[K]) => void): void {
    canvas.addEventListener(type, handler, { signal });
  }
  /** What else stops when the session does: listeners on the HUD, buttons put in its regions. */
  const unlisten: (() => void)[] = [];

  // The packs as this world's config keeps them, and the rules its seed made of them.
  const { packSet, startContent, game: gameRules, items: itemRules, creatures: creatureRules, progression: progressionRules, feedback: feedbackRules } = connection.rules;

  const quick = "quick" in options.enter ? options.enter.quick : null;
  // Who the player is, as far as their body goes: a quick character's from its options, a saved
  // one's as Entered says (see CHARACTERS.md).
  const playerLook: PlayerLook = quick ? { ...quick.look } : { race: "human", outfit: "scout", seed: 7 };
  // Who a quick player is in the game's rules - its origins (see PROGRESSION.md, *Origins*), one per
  // slot. A slot left out or named wrong takes its default.
  const requestedOrigins: Record<string, string> = {};
  for (const slot of progressionRules.config.slots) {
    const id = quick?.origins[slot.id];
    const origin = id === undefined ? undefined : progressionRules.origins[progressionRules.originIndex.get(id) ?? -1];
    requestedOrigins[slot.id] = origin && origin.slot === slot.id ? origin.id : slot.default;
  }
  // A people's body race is the player's unless the character names one.
  if (quick && !quick.raceGiven) {
    for (const id of Object.values(requestedOrigins)) {
      const look = progressionRules.origins[progressionRules.originIndex.get(id) ?? -1]?.raw.look;
      if (look && typeof look === "object" && typeof (look as { race?: unknown }).race === "string") playerLook.race = (look as { race: string }).race;
    }
  }
  /** Races, gear and outfits for everyone else's bodies, resolved once. */
  const bodyKit = createBodyKit(packSet.sources);

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
  /** The own player's disciplines, talents and what it has learned (see PROGRESSION.md). */
  const progressMirror = createProgressMirror();
  /** The other entities drawn in the current view's scene. */
  let entityMeshes: EntityMeshes | null = null;
  /** Damage and healing numbers over the units the own player fights, in the current view. */
  let floatingText: FloatingText | null = null;
  let healthBars: HealthBars | null = null;
  /** The unit the player has selected (see ABILITIES.md): 0 for none. */
  let targetId = 0;
  /** Why the server last refused what was asked - entering the world, above all. */
  let refusal = "";

  /** Applies whatever the server has said since last time - where the player is now, above all. */
  function takeServerMessages(): void {
    for (const message of client.receive()) {
      // What the own player wears goes on its body (ITEMS.md, *Equipment*).
      if (message.type === "entityGear" && message.id === playerId) view?.dress(gearOfItems(itemRules, message.gear));
      if (mirror.apply(message)) continue;
      if (belongings.apply(message)) continue;
      if (progressMirror.apply(message)) continue;
      if (message.type === "welcome") {
        // A quick player's Welcome; a saved one's came to the character list.
        if (message.playerId) playerId = message.playerId;
        for (const problem of welcomeProblems(message, seed, connection.rules)) console.warn(problem);
      } else if (message.type === "entered") {
        playerId = message.playerId;
        const look = message.look;
        Object.assign(playerLook, { race: look.race || "human", outfit: look.outfit || "scout", sex: look.sex || undefined, seed: look.seed, choices: look.choices });
      } else if (message.type === "refused") {
        refusal = message.reason;
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
        feedback.events(message.events);
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
    client.send(message);
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

  // Windows opening and closing, the action bar's drags (FEEDBACK.md).
  queueMicrotask(() => feedback.watchScreens(hud.windows));
  // Sounds, effects and hit feel for what happens (see FEEDBACK.md), from the combat events.
  const feedback = createGameFeedback({
    rules: feedbackRules,
    game: gameRules,
    items: itemRules,
    kit: bodyKit,
    mirror,
    player: () => playerId,
    target: () => targetId,
    ownOutfit: () => playerLook.outfit,
    volume: musicControl.effects,
    bodyPlace: (unit, bone, out) => (unit === playerId ? (view?.character.place(bone, out) ?? false) : (entityMeshes?.place(unit, bone, out) ?? false)),
    feelable: (unit) => (unit === playerId ? (view?.character.feelable() ?? null) : (entityMeshes?.feelable(unit) ?? null)),
    shake: musicControl.shake,
    steps: (unit) => (unit === playerId ? (view?.character.steps() ?? -1) : (entityMeshes?.steps(unit) ?? -1)),
    belongings,
  });

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
    feedback.setScene(null);
    floatingText?.dispose();
    floatingText = null;
    healthBars?.dispose();
    healthBars = null;
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
      page.failLoading(`The content for "${transfer.dimension}" could not be loaded`, error);
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
      hud: { graphics: hud.options.graphics, debugSettings: hud.debug.settings, debugStats: hud.debug.stats },
    });
    connection.provide(transfer.dimension, next.shared);
    view = next;
    const world = next.world;
    floatingText = createFloatingText(next.scene, mirror, gameRules, () => playerId);
    healthBars = createHealthBars(next.scene, mirror, gameRules, () => playerId);
    feedback.setScene(next.scene, next.world);
    entityMeshes = createEntityMeshes(next.scene, mirror, gameRules, () => playerId, {
      kit: bodyKit,
      worldSeed: transfer.seed,
      onBody: (meshes) => meshes.forEach((mesh) => world.castShadow(mesh)),
      items: itemRules,
    });
    client.send({ type: "arrived" });
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
    client.send({ type: "intent", seq: intentSeq, ...intent });
    for (const extra of extraPlayers) extra.step();
    server.step(deltaSeconds);
    takeServerMessages();
    if (pendingTransfer) return;
    if (targetId && !mirror.entities.has(targetId)) setTarget(0);
    entityMeshes?.setTarget(targetId);
    entityMeshes?.update();
    combatHud.update(targetId);
    actionBar.update();
    floatingText?.update();
    healthBars?.update(targetId);
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
    feedback.update(v.scene.activeCamera);
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
  /** Spawn points near the player as map dots: red hostile, yellow neutral, purple camps; grey while
   *  all of a point's members are dead. */
  function creaturePoints(radius: number): { x: number; z: number; color: string; title: string }[] {
    const own = mirror.entities.get(playerId);
    if (!own || !server.debug.creatures) return [];
    return server.debug.creatures.debug.points(currentDimension, own.x, own.z, radius).map((p) => {
      const dead = p.members.every((m) => server.debug.delta.get(m.key) !== undefined);
      const hostile = p.members.some((m) => m.kind.template.hostility === "hostile");
      const color = dead ? "rgb(140,140,140)" : p.camp ? "rgb(190,120,255)" : hostile ? "rgb(235,70,60)" : "rgb(240,215,60)";
      return { x: p.x, z: p.z, color, title: `${p.key}: ${p.camp ? `${p.camp.id}, ` : ""}${p.members.map((m) => `${m.kind.template.name} L${m.level}`).join(", ")}` };
    });
  }

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
  const extraPlayers: { step: () => void; close: () => void }[] = [];
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
      close: () => extra.client.close(),
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
  const sendItem = (message: ClientMessage): void => {
    client.send(message);
    // Its sound at once, as the hand does it (FEEDBACK.md).
    feedback.itemIntent(message);
  };
  const inventory = createInventoryScreen({ game: gameRules, items: itemRules, mirror: belongings, send: sendItem });
  const lootWindow = createLootWindow({ game: gameRules, items: itemRules, mirror: belongings, send: sendItem });
  /** A window in the windows region: no taller than it, scrolling inside. */
  function dockWindow(element: HTMLElement): void {
    dock(element, hud.windows);
    element.style.maxHeight = "100%";
    element.style.overflowY = "auto";
    element.style.overflowX = "hidden";
    element.style.boxSizing = "border-box";
    // Windows keep their size: when they do not fit side by side, the HUD closes the oldest instead.
    element.style.flexShrink = "0";
  }
  dockWindow(inventory.element);
  dockWindow(lootWindow.element);
  dockWindow(entityPanel.element);
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
  listenWindow("keydown", (e) => {
    if (!view || entering || e.repeat) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (e.key.toLowerCase() === "e") interact();
  });

  // Combat (see ABILITIES.md): a target, spells on keys 1-9, the frames and the log.
  function setTarget(id: number): void {
    if (id && id !== targetId) feedback.client("target", { source: playerId, target: id, skill: null, crit: false, periodic: false });
    targetId = id;
    client.send({ type: "target", id });
    if (id && entityPanel.visible) entityPanel.select(id);
  }
  function castSpell(skill: number): void {
    intentSeq = (intentSeq + 1) & 0xffff;
    client.send({ type: "cast", seq: intentSeq, skill, target: 0, x: NaN, z: NaN });
  }
  const combatHud = createCombatHud({
    rules: gameRules,
    mirror,
    ownId: () => playerId,
    onRespawn: () => command({ type: "respawn" }),
    regions: { frames: hud.frames, actions: hud.actions, log: hud.log },
    experience() {
      const level = progressionRules.config.level;
      const d = progressMirror.progress?.disciplines.find((x) => x.discipline === level);
      if (!d) return null;
      const name = progressionRules.disciplines[level].name;
      return { label: `${name} ${d.level}: ${Math.floor(d.xp)} / ${Math.ceil(d.next)} XP`, fraction: d.level >= d.cap ? 1 : d.xp / d.next };
    },
  });

  // The action bar (ui/actionBar.ts) in the combat HUD's place for it, and the spell book (L) it is
  // filled from: the player arranges spells, the attack and items to use on it.
  const actionBar = createActionBar(combatHud.barSlot, {
    game: gameRules,
    items: itemRules,
    mirror,
    belongings,
    ownId: () => playerId,
    character: quick ? Object.values(requestedOrigins).join(".") : `saved:${"character" in options.enter ? options.enter.character : ""}`,
    cast: castSpell,
    setAttacking: (on) => client.send({ type: "attack", on }),
    useItem: (bagSlot) => sendItem({ type: "itemUse", from: { container: 0, slot: bagSlot } }),
    teleport: (byKey) => aimTeleport(byKey),
  });
  const spellBook = createSpellBook({
    game: gameRules,
    mirror,
    progress: progressMirror,
    cast: castSpell,
    setAttacking: (on) => client.send({ type: "attack", on }),
    teleport: () => aimTeleport(false),
  });
  listenWindow("keydown", (e) => {
    if (!view || entering || e.repeat) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (e.key.toLowerCase() === "l") spellBook.toggle();
  });

  // Progression (see PROGRESSION.md): P toggles the panel; XP and level-ups float over the player and
  // are client events for the feedback system's cues.
  const progressPanel = createProgressPanel({
    game: gameRules,
    rules: progressionRules,
    items: itemRules,
    progress: progressMirror,
    entities: mirror,
    ownId: () => playerId,
    send: (message) => client.send(message),
    openBook: (key) => (key ? ruleBook.open(key) : ruleBook.toggle()),
  });
  progressMirror.onEvents((events) => {
    const context = { source: playerId, target: playerId, skill: null, crit: false, periodic: false };
    for (const e of events) {
      const discipline = progressionRules.disciplines[e.discipline];
      if (e.kind === "xp" && e.discipline === progressionRules.config.level) floatingText?.say(playerId, `+${Math.round(e.amount)} XP`, "#c9a8ff");
      if (e.kind === "levelUp" && discipline) {
        floatingText?.say(playerId, `${discipline.name} ${e.level}!`, "#ffd27a", true);
        feedback.client(e.discipline === progressionRules.config.level ? "levelUp" : "disciplineUp", context);
      }
      if (e.kind === "xp") feedback.client("xpGained", context);
      if (e.kind === "learned") feedback.client("learned", { ...context, skill: gameRules.skills[e.skill] ?? null });
      if (e.kind === "talent" && e.amount >= 0) feedback.client("talentPicked", context);
    }
  });
  listenWindow("keydown", (e) => {
    if (!view || entering || e.repeat) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (e.key.toLowerCase() === "p") progressPanel.toggle();
    if (e.key.toLowerCase() === "k") ruleBook.toggle();
  });
  // How this game works, written from its rules (PROGRESSION.md, *The client*): K.
  const ruleBook = createRuleBook({
    game: gameRules,
    progression: progressionRules,
    items: itemRules,
    own() {
      const p = progressMirror.progress;
      const me = mirror.entities.get(playerId);
      if (!p || !me) return null;
      return { stats: me.stats, levels: new Map(p.disciplines.map((d) => [d.discipline, d.level])), origins: p.origins.filter((o) => o >= 0) };
    },
  });
  // The screens that open from keys, as a row of buttons too; the debug tools sit in the debug panel.
  const menuBar = createMenuBar([
    { icon: "bag", label: "Inventory", key: "B", toggle: () => inventory.toggle(), open: () => inventory.visible },
    { icon: "progress", label: "Progression", key: "P", toggle: () => progressPanel.toggle(), open: () => progressPanel.visible },
    { icon: "spells", label: "Spell book", key: "L", toggle: () => spellBook.toggle(), open: () => spellBook.visible },
    { icon: "book", label: "Rule book", key: "K", toggle: () => ruleBook.toggle(), open: () => ruleBook.visible },
    { icon: "options", label: "Options", key: "O", toggle: () => (hud.optionsVisible = !hud.optionsVisible), open: () => hud.optionsVisible },
    { icon: "debug", label: "Debug panel", key: "F2", toggle: () => (hud.debugVisible = !hud.debugVisible), open: () => hud.debugVisible, debug: true },
  ]);
  dock(menuBar.element, hud.menu);
  unlisten.push(hud.onMenuVertical((vertical) => menuBar.setVertical(vertical)));
  unlisten.push(hud.onActionsWidth((width) => actionBar.fitWidth(width)));
  dockWindow(progressPanel.element);
  dockWindow(spellBook.element);
  // The debug panel's tools: what M, T and I open.
  for (const [label, key, open] of [
    ["Inspector", "I", () => entityPanel.toggle()],
    ["Debug map", "M", () => view?.debugMap.toggle()],
    ["Textures", "T", () => view?.textureBrowser.toggle()],
  ] as const) {
    const button = document.createElement("button");
    button.textContent = `${label} (${key})`;
    button.style.cssText = "font: 11px sans-serif; color: #eee; background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; padding: 3px 8px; cursor: pointer;";
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", open);
    hud.debug.tools.appendChild(button);
    unlisten.push(() => button.remove());
  }
  hud.debug.tools.style.flexDirection = "row";
  listenWindow("keydown", (e) => {
    if (!view || entering || e.repeat) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (e.key.toLowerCase() === "o") hud.optionsVisible = !hud.optionsVisible;
    if (e.key === "F2") {
      e.preventDefault();
      hud.debugVisible = !hud.debugVisible;
    }
  });
  listenWindow("keydown", (e) => {
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
      if (teleportArmed) setTeleportArmed(false);
      else if (mirror.entities.get(playerId)?.cast) client.send({ type: "stopCast" });
      else if (targetId) setTarget(0);
      return;
    }
    if (e.repeat) return;
    // The action bar's keys: 1-9, 0, - and =. The attack is on the bar too (its first slot to begin with).
    const slot = actionBar.keys.indexOf(e.key);
    if (slot >= 0) actionBar.press(slot, true);
  });
  {
    let down: { x: number; y: number } | null = null;
    listenCanvas("pointerdown", (e) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    });
    listenCanvas("pointerup", (e) => {
      if (e.button !== 0 || !down || !view || !entityMeshes) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      // An aimed teleport takes this click.
      if (teleportArmed) {
        setTeleportArmed(false);
        teleportAt(e.clientX, e.clientY);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const meshes = entityMeshes;
      const pick = view.scene.pick(e.clientX - rect.left, e.clientY - rect.top, (mesh) => meshes.entityOf(mesh) !== null);
      const id = pick?.hit ? meshes.entityOf(pick.pickedMesh) : null;
      if (id === null) return;
      // A click targets it; the inspector, if open, follows.
      setTarget(id);
    });
  }

  // The debug teleport (an action on the bar and in the spell book): to where the pointer is, on what
  // it hits in the collision world - a roof, a floor, a tree - or, past where that reaches, on the
  // ground drawn. From its key it goes at once to the pointer; from a click on its slot it waits for
  // the next click on the world.
  let teleportArmed = false;
  let pointer: { x: number; y: number } | null = null;
  listenCanvas("pointermove", (e) => (pointer = { x: e.clientX, y: e.clientY }));
  listenCanvas("pointerleave", () => (pointer = null));
  function setTeleportArmed(on: boolean): void {
    teleportArmed = on;
    canvas.style.cursor = on ? "crosshair" : "";
  }
  function aimTeleport(byKey: boolean): void {
    if (byKey && pointer) teleportAt(pointer.x, pointer.y);
    else setTeleportArmed(true);
  }
  function teleportAt(clientX: number, clientY: number): void {
    if (!view) return;
    const { scene, world, character } = view;
    const rect = canvas.getBoundingClientRect();
    const ray = scene.createPickingRay(clientX - rect.left, clientY - rect.top, null, scene.activeCamera);
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
  }

  // Right-click (a click, not a drag - a drag turns the camera) to interact with what is under the
  // pointer: open a corpse's or a chest's loot, pick up an item on the ground, see a trainer's lessons,
  // or target and attack an enemy.
  {
    let down: { x: number; y: number } | null = null;
    listenCanvas("contextmenu", (e) => e.preventDefault());
    listenCanvas("pointerdown", (e) => {
      if (e.button === 2) down = { x: e.clientX, y: e.clientY };
    });
    listenCanvas("pointerup", (e) => {
      if (e.button !== 2 || !down || !view || !entityMeshes) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      if (teleportArmed) return setTeleportArmed(false);
      const rect = canvas.getBoundingClientRect();
      const meshes = entityMeshes;
      const pick = view.scene.pick(e.clientX - rect.left, e.clientY - rect.top, (mesh) => meshes.entityOf(mesh) !== null);
      const id = pick?.hit ? meshes.entityOf(pick.pickedMesh) : null;
      const entity = id === null ? undefined : mirror.entities.get(id);
      if (id === null || !entity) return;
      if (entity.lootable || entity.templateId === GROUND_ITEM_TEMPLATE) return interact(id);
      if (progressionRules.config.trainers.has(entity.templateId)) {
        if (!progressPanel.visible) progressPanel.toggle();
        return;
      }
      setTarget(id);
      const dead = (entity.flags & (1 << FLAG.dead)) !== 0;
      const enemy = entity.template?.hostility === "hostile" || entity.template?.hostility === "neutral";
      if (enemy && !dead && id !== playerId) client.send({ type: "attack", on: true });
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
  (window as unknown as { __aiworld?: unknown }).__aiworld = {
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
    /** Sounds, effects and cues (FEEDBACK.md): `feedback.sfx()?.play("swing")`, `feedback.sfx()?.voices()`. */
    feedback,
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
    /** Creatures (see CREATURES.md), from this page's own server - single player only. */
    creatures: {
      rules: creatureRules,
      /** Every kind this world has, with its traits. */
      kinds: () => creatureRules.kindList.map((k) => `${k.id}: ${k.template.name}${k.traits.length ? ` (${k.traits.join(", ")})` : ""}`),
      /** The zone the player stands in: its ring, level band, roster and camps. */
      zone() {
        const own = mirror.entities.get(playerId);
        const zone = own && server.debug.creatures?.debug.zoneAt(currentDimension, own.x, own.z);
        return zone && { id: zone.id, name: zone.name, biome: zone.biome, ring: zone.ring, levels: zone.levels, roster: zone.roster.map((r) => `${r.kind.id} ${r.weight.toFixed(1)}`), camps: zone.camps.map((c) => c.camp.id) };
      },
      /** The spawn points within `radius` of the player, nearest first, with what stands at each and
       *  when its dead come back. */
      points(radius = 300) {
        const own = mirror.entities.get(playerId);
        if (!own || !server.debug.creatures) return [];
        return server.debug.creatures.debug
          .points(currentDimension, own.x, own.z, radius)
          .map((p) => ({ key: p.key, distance: Math.round(Math.hypot(p.x - own.x, p.z - own.z)), x: Math.round(p.x), z: Math.round(p.z), camp: p.camp?.id ?? "", members: p.members.map((m) => `${m.kind.id} L${m.level}${server.debug.delta.get(m.key) !== undefined ? ` (back in ${Math.ceil(server.debug.delta.get(m.key)! - server.time)} s)` : ""}`) }))
          .sort((a, b) => a.distance - b.distance);
      },
      /** Marks the spawn points within `radius` on the debug map (M); `showPoints(0)` clears them. */
      showPoints(radius = 800) {
        const points = radius > 0 ? creaturePoints(radius) : null;
        view?.debugMap.setSpawnPoints(points);
        return points?.length ?? 0;
      },
      /** Makes a creature of a kind 6 m in front of the player, at a level (the zone's lowest if left out). */
      spawn(kind: string, level?: number) {
        const own = mirror.entities.get(playerId);
        if (!own) return undefined;
        return server.debug.creatures?.debug.spawn(currentDimension, kind, own.x + Math.sin(own.facing) * 6, own.z + Math.cos(own.facing) * 6, level)?.id;
      },
      /** What is dead and until when (the world delta). */
      delta: () => server.debug.delta.entries().map(([key, until]) => `${key}: back in ${Math.ceil(until - server.time)} s`),
      /** Kills since the last call (what progression will turn into XP). */
      kills: () => server.debug.creatures?.drainKills() ?? [],
      /** The server's own creature system. */
      server: () => server.debug.creatures,
    },
    /** Progression (see PROGRESSION.md): what this page was told of the own progress, and the messages
     *  a player sends. Disciplines and trees by id. */
    progress: {
      rules: progressionRules,
      mirror: progressMirror,
      mine: () => progressMirror.progress,
      xp: (discipline: string, amount: number) => client.send({ type: "debugXp", discipline: progressionRules.disciplineIndex.get(discipline) ?? -1, amount }),
      level: (discipline: string, level: number) => client.send({ type: "debugLevel", discipline: progressionRules.disciplineIndex.get(discipline) ?? -1, level }),
      pick(tree: string, node: string) {
        const t = progressionRules.treeIndex.get(tree) ?? -1;
        client.send({ type: "talentPick", tree: t, node: progressionRules.trees[t]?.nodes.find((n) => n.id === node)?.index ?? -1 });
      },
      reset: (tree: string) => client.send({ type: "talentReset", tree: progressionRules.treeIndex.get(tree) ?? -1 }),
      learn: (trainer: number, skill: string) => client.send({ type: "learn", trainer, skill: gameRules.skillIndex.get(skill) ?? -1 }),
      learnAll: () => client.send({ type: "debugLearnAll" }),
      /** The own character's progress as it would be saved, and loading one into it - single player only. */
      export: () => {
        const me = server.debug.entity(playerId);
        return me ? server.debug.progression?.export(me) : null;
      },
      import: (saved: Parameters<NonNullable<typeof server.debug.progression>["import"]>[1]) => {
        const me = server.debug.entity(playerId);
        return me ? server.debug.progression?.import(me, saved) : null;
      },
      panel: progressPanel,
      book: ruleBook,
      server: () => server.debug.progression,
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

  listenWindow("keydown", (e) => {
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

  // Joining is travelling: the server answers Hello with a Transfer to the first dimension - the
  // character's `dimension` asks for one (debug).
  if (quick) {
    command({ type: "hello", protocol: PROTOCOL_VERSION, name: quick.name, dimension: quick.dimension, look: appearanceOf(playerLook), origins: requestedOrigins });
  } else if ("character" in options.enter) {
    // The connection has said Hello and been told the characters; the character is read from the
    // store before the server answers.
    command({ type: "enterWorld", character: options.enter.character, dimension: options.enter.dimension ?? "" });
    for (let waited = 0; !pendingTransfer && !refusal && waited < 600; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      server.step(0);
      takeServerMessages();
    }
  }
  if (!pendingTransfer) {
    listening.abort();
    page.failLoading("The character could not enter the world", new Error(refusal || "The server sent no dimension to enter."));
  }
  // A saved world is written when the page is hidden: the tab may be closed next.
  if (connection.saved) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void connection.save();
    }, { signal });
  }
  await follow(true);

  function render(): void {
    if (entering) return;
    if (pendingTransfer) {
      void follow(false);
      return;
    }
    view?.scene.render();
  }
  engine.runRenderLoop(render);

  return {
    feedback,
    goto: (target) => view?.gotoView(target),
    dispose() {
      listening.abort();
      engine.stopRenderLoop(render);
      // The server saves the character, lets it go and drops the dimensions nobody is left in; the
      // connection stays, back at its character list.
      client.send({ type: "logout" });
      for (const extra of extraPlayers) extra.close();
      server.step(0);
      for (const stop of unlisten.splice(0)) stop();
      leave();
      entityPanel.dispose();
      inventory.dispose();
      lootWindow.dispose();
      combatHud.dispose();
      actionBar.dispose();
      spellBook.dispose();
      progressPanel.dispose();
      ruleBook.dispose();
      menuBar.dispose();
      feedback.dispose();
      delete (window as unknown as { __aiworld?: unknown }).__aiworld;
    },
  };
}
