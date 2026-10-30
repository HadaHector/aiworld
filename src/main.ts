// First, so it can wrap the buffer constructors before anything allocates (`?memory`).
import "./debug/installMemoryTracking";
import { createEngine } from "./core/engine";
import { WORLD_SEED } from "./world/worldData";
import { createZoneLabel } from "./debug/zoneLabel";
import { createPositionPanel } from "./debug/positionPanel";
import { createLoadingScreen } from "./ui/loadingScreen";
import { createMusicControl } from "./ui/musicControl";
import { createGameMusic } from "./music/gameMusic";
import { configNameFromUrl } from "./world/content/loadContent";
import { ContentError, formatIssue } from "./world/content/contentReader";
import { lookFromUrl } from "./game/playerBody";
import { createHud, dock } from "./ui/hud";
import { GOLD, QUIET_PANEL, TITLE_FONT } from "./ui/theme";
import { startSession, type Page, type Session, type SessionOptions } from "./game/session";

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

const page: Page = { engine, canvas, loadingScreen, failLoading, hud, zoneLabel, positionPanel, musicControl, music };

// Straight into a game, with who the player is from the address until there is character creation
// (see CHARACTERS.md, PROGRESSION.md): ?race=dwarf&outfit=knight&sex=female&look=7 for the body,
// ?people=dwarf&class=mage for the origins, ?dimension=isles to start there, ?seed= and ?config= for
// the world. `?play` will be what skips the main menu once there is one (FRONTEND.md, *Dev shortcut*).
const params = new URLSearchParams(location.search);
const options: SessionOptions = {
  seed: Number(params.get("seed")) >>> 0 || WORLD_SEED,
  config: configNameFromUrl(),
  character: {
    name: "player",
    look: lookFromUrl(),
    raceGiven: params.has("race"),
    origins: Object.fromEntries(params),
    dimension: params.get("dimension") ?? "",
  },
};
let session: Session | null = await startSession(page, options);

/** The page, for the console: `await __aiworldPage.restart()` ends the game and starts it again -
 *  what logging out and back in will do, for checking that a session leaves nothing behind. */
(window as unknown as { __aiworldPage: unknown }).__aiworldPage = {
  async restart(): Promise<void> {
    session?.dispose();
    session = null;
    loadingScreen.show();
    session = await startSession(page, options);
  },
  engine,
  /** Ends the game, leaving the page with none. */
  end(): void {
    session?.dispose();
    session = null;
  },
  get session() {
    return session;
  },
};

window.addEventListener("resize", () => {
  engine.resize();
});
