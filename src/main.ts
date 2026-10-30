// First, so it can wrap the buffer constructors before anything allocates (`?memory`).
import "./debug/installMemoryTracking";
import { createEngine } from "./core/engine";
import { WORLD_SEED } from "./world/worldData";
import { createZoneLabel } from "./debug/zoneLabel";
import { createPositionPanel } from "./debug/positionPanel";
import { createLoadingScreen } from "./ui/loadingScreen";
import { createMusicControl } from "./ui/musicControl";
import { createGameMusic } from "./music/gameMusic";
import { configNameFromUrl, fetchPackSources, fetchWorldConfig } from "./world/content/loadContent";
import { DEFAULT_CONFIG } from "./world/content/worldConfig";
import type { PackSource } from "./world/content/resolveContent";
import { connectLocal, type Connection } from "./game/connection";
import { createFrontend, type Frontend } from "./frontend/frontend";
import { resolveFrontend, type FrontendRules } from "./frontend/frontendRules";
import { createIndexedDbStore } from "./save/indexedDbStore";
import { ContentError, formatIssue } from "./world/content/contentReader";
import { lookFromUrl } from "./game/playerBody";
import { createHud, dock } from "./ui/hud";
import { GOLD, QUIET_PANEL, TITLE_FONT } from "./ui/theme";
import { startSession, type Page, type Session } from "./game/session";

// What lasts the whole page (see FRONTEND.md): the engine, the loading screen, the HUD's regions,
// the music. A game - one world played - is a session started into it and disposed of again.
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

const engine = createEngine(canvas);
// Where everything on screen goes (ui/hud.ts): regions that keep the panels apart at any width.
const hud = createHud();
const zoneLabel = createZoneLabel();
dock(zoneLabel.element, hud.info);
// The zone name is the player's, not a debug readout: the game's look (ui/theme.ts).
zoneLabel.element.style.cssText = `${QUIET_PANEL} padding: 4px 10px; font: 600 13px/1.3 ${TITLE_FONT}; color: ${GOLD}; letter-spacing: 0.03em; text-shadow: 0 1px 2px #000; white-space: nowrap;`;
const positionPanel = createPositionPanel((v) => session?.goto(v));
dock(positionPanel.element, hud.debug.position);
// Music for wherever the player is - see MUSIC.md. It starts with the first click or key press.
const musicControl = createMusicControl(
  (volume) => music.setVolume(volume),
  (volume) => session?.feedback.setVolume(volume),
  (shake) => session?.feedback.setShake(shake),
);
// The volumes and the shake are options (O), beside the graphics the dimension view adds.
dock(musicControl.element, hud.options.sound);
const music = createGameMusic(musicControl.volume);
// While the loading screen is up the page generates worlds, holding its main thread for seconds -
// where the music's scheduler runs: it schedules far ahead then, so the music plays through. The
// loading screen is up from the first paint.
{
  let held = true;
  music.hold(true);
  const show = loadingScreen.show;
  const hide = loadingScreen.hide;
  loadingScreen.show = () => {
    if (!held) music.hold((held = true));
    show();
  };
  loadingScreen.hide = () => {
    if (held) music.hold((held = false));
    hide();
  };
}

const page: Page = { engine, canvas, loadingScreen, failLoading, hud, zoneLabel, positionPanel, musicControl, music };

// Every pack's files, fetched once for the page: each world narrows them to what its config keeps.
// A broken pack stops here, with every problem listed on the loading screen.
let sources: PackSource[];
let frontendRules: FrontendRules;
try {
  loadingScreen.update("Loading content packs", 0, 0);
  sources = await fetchPackSources(import.meta.env.BASE_URL, DEFAULT_CONFIG);
  frontendRules = resolveFrontend(sources);
} catch (error) {
  failLoading("The content packs could not be loaded", error);
}

const params = new URLSearchParams(location.search);
/** The game being played, if any - for the page's volume and shake settings. */
let session: Session | null = null;

/**
 * `?play` skips the menu (FRONTEND.md, *Dev shortcut*). On its own it is a quick, unsaved game, as
 * the bare address was before the menu: who the player is from the address - ?race=dwarf&outfit=
 * knight&sex=female&look=7 for the body, ?people=dwarf&class=mage for the origins, ?dimension=isles to
 * start there, ?seed= and ?config= for the world. `?play=<world>` enters a saved world's last
 * character, `?play=<world>/<character>` a named one.
 */
async function quickGame(): Promise<Session> {
  let connection: Connection;
  try {
    const config = await fetchWorldConfig(configNameFromUrl());
    connection = connectLocal({ sources, config, seed: Number(params.get("seed")) >>> 0 || WORLD_SEED });
  } catch (error) {
    failLoading("The content packs could not be loaded", error);
  }
  const started = await startSession(page, {
    connection,
    enter: { quick: { name: "player", look: lookFromUrl(), raceGiven: params.has("race"), origins: Object.fromEntries(params), dimension: params.get("dimension") ?? "" } },
  });
  // The quick game's connection is its own: it goes with the game.
  const dispose = started.dispose;
  return { ...started, dispose: () => (dispose(), connection.close()) };
}

const play = params.get("play");
let frontend: Frontend | null = null;
if (play === "") {
  session = await quickGame();
} else {
  frontend = createFrontend({ page, store: createIndexedDbStore(), sources, rules: frontendRules, onSession: (s) => (session = s), hidden: Boolean(play) });
  if (!play) loadingScreen.hide();
  else {
    const [world, character] = play.split("/");
    await frontend.play(world, character || undefined);
  }
}

/** The page, for the console: `await __aiworldPage.restart()` ends a quick game and starts it again,
 *  for checking that a session leaves nothing behind; `leave()` logs a saved game out to its world's
 *  characters, `leave(true)` to the main menu. */
(window as unknown as { __aiworldPage: unknown }).__aiworldPage = {
  async restart(): Promise<void> {
    if (frontend) return;
    session?.dispose();
    session = null;
    loadingScreen.show();
    session = await quickGame();
  },
  engine,
  /** Ends a quick game, leaving the page with none. */
  end(): void {
    if (frontend) return;
    session?.dispose();
    session = null;
  },
  leave: (toMenu = false) => frontend?.leaveGame(toMenu),
  get showcase() {
    return frontend?.showcase ?? null;
  },
  get session() {
    return session;
  },
};

window.addEventListener("resize", () => {
  engine.resize();
});
