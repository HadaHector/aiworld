import type { Page, Session } from "../game/session";
import { startSession } from "../game/session";
import { connectLocal, type Connection } from "../game/connection";
import { createShowcase, type Showcase } from "./showcase";
import type { FrontendRules } from "./frontendRules";
import type { SaveStore } from "../save/store";
import { createWorldRecord, makeSaveId, type CharacterSummary, type WorldRecord } from "../save/records";
import { packSetFrom } from "../world/content/loadContent";
import type { PackSource } from "../world/content/resolveContent";
import { fetchWorldConfig } from "../world/content/loadContent";
import { hashString } from "../world/content/dimensions";
import { PROTOCOL_VERSION, type ServerMessage } from "../sim/protocol";
import { BUTTON_CLASS, DIM, GOLD, HEADING, PANEL, TEXT, TITLE_FONT, installTheme } from "../ui/theme";

/** The sizes a new world can have: one per config in public/configs, and the full game (CONFIG.md). */
const SIZES = [
  { config: "tiny", name: "Tiny", note: "1 zone - ready in seconds" },
  { config: "small", name: "Small", note: "4 zones - ready in about 20 s" },
  { config: "default", name: "Full", note: "29 zones - about a minute to load, and much memory" },
];

/** What Continue enters: the character played last, in its world. */
const LAST_KEY = "aiworld.frontend.last";
interface Last {
  world: string;
  character: string;
}
function readLast(): Last | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as Last | null;
    return raw && typeof raw.world === "string" && typeof raw.character === "string" ? raw : null;
  } catch {
    return null;
  }
}
function writeLast(last: Last): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(last));
  } catch {
    // Not remembered: Continue stays hidden.
  }
}

export interface FrontendOptions {
  page: Page;
  store: SaveStore;
  /** Every pack's files, fetched once for the page. */
  sources: readonly PackSource[];
  rules: FrontendRules;
  /** Called when a session starts or ends, for the page's volume and shake settings. */
  onSession: (session: Session | null) => void;
  /** Starts with the menu hidden, its world not built: `?play=<world>` goes straight in. */
  hidden?: boolean;
}

export interface Frontend {
  /** Enters a saved world's character - `?play=<world>/<character>`; the world's last one if none is named. */
  play: (world: string, character?: string) => Promise<void>;
  /** Leaves the game for the world's character list (or the main menu), the character saved. */
  leaveGame: (toMenu: boolean) => Promise<void>;
  readonly session: Session | null;
  /** The world behind the menu, while it is up - for the console. */
  readonly showcase: Showcase | null;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
};
const ago = (ms: number): string => {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
};

/**
 * The front end (FRONTEND.md, *The screens*): the main menu over the showcase world with the main
 * theme, the world list, a world's characters, and starting a game from them - and coming back to
 * them from it. The page's HUD regions hide while it shows, all but the windows (Options).
 */
export function createFrontend(options: FrontendOptions): Frontend {
  installTheme();
  const { page, store, rules } = options;
  const { engine, canvas, hud, loadingScreen, music } = page;

  // --- The layers: a dark backdrop until the showcase is drawn, and the menu's column over it. ---
  const root = el("div", "position: fixed; inset: 0; z-index: 940; pointer-events: none;", document.body);
  const backdrop = el("div", "position: absolute; inset: 0; background: radial-gradient(circle at 50% 42%, #2b2418 0%, #0d0b08 75%); transition: opacity 1.6s ease;", root);
  el("div", "position: absolute; inset: 0; background: linear-gradient(90deg, rgba(8,7,5,0.72) 0%, rgba(8,7,5,0.35) 34%, rgba(8,7,5,0) 60%);", root);
  const column = el("div", `position: absolute; left: clamp(16px, 7vw, 120px); top: 0; bottom: 0; width: min(420px, calc(100vw - 32px)); display: flex; flex-direction: column; justify-content: center; gap: 14px; pointer-events: auto; color: ${TEXT};`, root);
  el("div", `font: 600 clamp(34px, 6vw, 58px)/1.05 ${TITLE_FONT}; color: ${GOLD}; letter-spacing: 0.06em; text-shadow: 0 2px 8px #000, 0 0 30px rgba(240, 201, 121, 0.25);`, column, rules.title);
  const panel = el("div", `${PANEL} padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; max-height: 62vh; overflow-y: auto;`, column);
  panel.className = "game-scroll";
  const status = el("div", `position: absolute; right: 16px; bottom: 12px; font: 11px/1.4 sans-serif; color: ${DIM}; text-shadow: 0 1px 2px #000; text-align: right;`, root);
  const small = el("div", `font: 11px/1.4 sans-serif; color: ${DIM};`, column);

  /** What Escape does on the screen showing - back, mostly. */
  let back: (() => void) | null = null;
  window.addEventListener("keydown", (e) => {
    if (root.style.display === "none" || !back) return;
    if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) {
      if (hud.optionsVisible) hud.optionsVisible = false;
      else back();
    }
  });

  const button = (parent: HTMLElement, label: string, onClick: () => void, css = ""): HTMLButtonElement => {
    const b = el("button", `font-size: 14px; padding: 9px 14px; text-align: left; ${css}`, parent, label);
    b.className = BUTTON_CLASS;
    b.addEventListener("click", onClick);
    return b;
  };
  const heading = (text: string): HTMLElement => el("div", `${HEADING} font-size: 17px; margin: 0 0 4px;`, panel, text);
  const note = (text: string, colour = DIM): HTMLElement => el("div", `font: 12px/1.45 sans-serif; color: ${colour};`, panel, text);
  const field = (label: string, input: HTMLInputElement | HTMLSelectElement): void => {
    const row = el("label", "display: flex; flex-direction: column; gap: 3px; font: 12px sans-serif;", panel, label);
    input.style.cssText = `font: 13px sans-serif; padding: 6px 8px; background: #0f0d0a; color: ${TEXT}; border: 1px solid #6b5530; border-radius: 3px;`;
    row.appendChild(input);
  };
  const clear = (onBack: (() => void) | null): void => {
    panel.replaceChildren();
    back = onBack;
  };
  const row = (): HTMLElement => el("div", "display: flex; gap: 6px; flex-wrap: wrap;", panel);

  // --- The showcase world and the theme ---
  let showcase: Showcase | null = null;
  let building: Promise<void> | null = null;
  function buildShowcase(): void {
    if (showcase || building) return;
    backdrop.style.opacity = "1";
    building = (async () => {
      try {
        const config = await fetchWorldConfig(rules.showcase.config);
        const built = await createShowcase({
          engine,
          canvas,
          packSet: packSetFrom(options.sources, config),
          rules: rules.showcase,
          hud,
          onProgress: (phase) => (status.textContent = phase),
        });
        // Shown after all? A game was started while it built.
        if (root.style.display === "none") built.dispose();
        else {
          showcase = built;
          backdrop.style.opacity = "0";
        }
        status.textContent = "";
      } catch (error) {
        console.warn("The showcase world could not be built:", error);
        status.textContent = "";
      } finally {
        building = null;
      }
    })();
  }
  const musicTimer = window.setInterval(() => {
    if (root.style.display === "none") return;
    music.update({ style: rules.music.menu, place: 0, inside: true });
    page.musicControl.setStatus(music.status());
  }, 250);
  void musicTimer;

  function showMenu(on: boolean): void {
    root.style.display = on ? "" : "none";
    hud.playing = !on;
    if (on) buildShowcase();
    else {
      showcase?.dispose();
      showcase = null;
      hud.optionsVisible = false;
    }
  }

  // --- The connection to the world chosen ---
  let connection: Connection | null = null;
  let world: WorldRecord | null = null;
  let characters: CharacterSummary[] = [];
  let session: Session | null = null;
  /** From starting a game until it has ended: the session reads the connection then, not the menu. */
  let inGame = false;
  /** Whoever waits for the server's next answers on the character list. */
  let listen: ((message: ServerMessage) => void) | null = null;
  const pump = window.setInterval(() => {
    if (!connection || inGame) return;
    connection.server.step(0);
    for (const message of connection.client.receive()) {
      if (message.type === "characters") characters = message.list;
      listen?.(message);
    }
  }, 50);
  void pump;

  async function openWorld(id: string): Promise<boolean> {
    if (connection && world?.id === id) return true;
    closeWorld();
    const record = await store.readWorld(id);
    if (!record) return false;
    const config = await fetchWorldConfig(record.config);
    connection = connectLocal({ sources: options.sources, config, seed: record.seed, saves: { store, world: record, interval: rules.save.interval } });
    world = record;
    characters = record.characters;
    connection.client.send({ type: "hello", protocol: PROTOCOL_VERSION, select: true, name: "", dimension: "" });
    return true;
  }
  function closeWorld(): void {
    connection?.close();
    connection = null;
    world = null;
    characters = [];
  }
  /** Sends a request about characters and waits for the list or a refusal. */
  function ask(message: Parameters<Connection["client"]["send"]>[0]): Promise<string> {
    return new Promise((resolve) => {
      listen = (m) => {
        if (m.type === "characters" || m.type === "refused") {
          listen = null;
          resolve(m.type === "refused" ? m.reason : "");
        }
      };
      connection!.client.send(message);
    });
  }

  // --- Screens ---
  function mainScreen(): void {
    clear(null);
    const last = readLast();
    if (last) button(panel, "Continue", () => void play(last.world, last.character));
    button(panel, "New character", () => {
      const lastWorld = readLast()?.world;
      void (async () => (lastWorld && (await openWorld(lastWorld)) ? newCharacterScreen() : worldsScreen()))();
    });
    button(panel, "Worlds", () => void worldsScreen());
    button(panel, "Options", () => (hud.optionsVisible = !hud.optionsVisible));
    small.textContent = `Packs: ${options.sources.map((p) => p.id).join(", ")} · saves in this browser`;
  }

  async function worldsScreen(): Promise<void> {
    closeWorld();
    clear(mainScreen);
    heading("Worlds");
    const list = await store.listWorlds();
    if (list.length === 0) note("No worlds yet.");
    for (const w of list) {
      const entry = el("div", "display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid rgba(138,109,59,0.4); border-radius: 3px; background: rgba(0,0,0,0.25);", panel);
      el("div", `font: 600 15px ${TITLE_FONT}; color: ${GOLD};`, entry, w.name);
      const size = SIZES.find((s) => s.config === w.config)?.name ?? w.config;
      el("div", `font: 12px sans-serif; color: ${DIM};`, entry, `${size} · seed ${w.seed} · ${w.characters.length} character${w.characters.length === 1 ? "" : "s"} · played ${ago(w.played)}`);
      const buttons = el("div", "display: flex; gap: 6px;", entry);
      button(buttons, "Play", () => void charactersScreen(w.id), "font-size: 12px; padding: 5px 10px;");
      button(buttons, "Rename", () => {
        const name = prompt("The world's new name:", w.name)?.trim();
        if (!name) return;
        w.name = name.slice(0, 32);
        void store.writeWorld(w).then(() => worldsScreen());
      }, "font-size: 12px; padding: 5px 10px;");
      button(buttons, "Delete", () => {
        if (!confirm(`Delete ${w.name} and its ${w.characters.length} character${w.characters.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
        void store.deleteWorld(w.id).then(() => {
          if (readLast()?.world === w.id) localStorage.removeItem(LAST_KEY);
          void worldsScreen();
        });
      }, "font-size: 12px; padding: 5px 10px;");
    }
    const actions = row();
    button(actions, "Create a world", createWorldScreen);
    button(actions, "Back", mainScreen);
  }

  function createWorldScreen(): void {
    clear(() => void worldsScreen());
    heading("Create a world");
    const name = document.createElement("input");
    name.maxLength = 32;
    name.placeholder = "New world";
    field("Name", name);
    const seed = document.createElement("input");
    seed.value = String(Math.floor(Math.random() * 4294967296) >>> 0);
    field("Seed - a number, or any words", seed);
    const size = document.createElement("select");
    for (const s of SIZES) size.add(new Option(`${s.name} - ${s.note}`, s.config));
    field("Size", size);
    const problem = note("", "#e88");
    const actions = row();
    button(actions, "Create", () => {
      const text = seed.value.trim();
      const number = /^\d+$/.test(text) ? Number(text) >>> 0 : hashString(text || "seed");
      void (async () => {
        try {
          const n = (await store.listWorlds()).length;
          const named = name.value.trim() || `New world ${n + 1}`;
          const config = await fetchWorldConfig(size.value);
          const record = createWorldRecord({ id: makeSaveId(named), name: named, seed: number, config: size.value, packs: [], hashes: { rules: 0, items: 0, creatures: 0, progression: 0 } });
          // Its rules' hashes, for warning if the packs change under it later.
          const made = connectLocal({ sources: options.sources, config, seed: number });
          record.packs = made.rules.packSet.packs;
          record.hashes = { rules: made.rules.game.hash, items: made.rules.items.hash, creatures: made.rules.creatures.hash, progression: made.rules.progression.hash };
          made.close();
          await store.writeWorld(record);
          await charactersScreen(record.id);
        } catch (error) {
          problem.textContent = String(error instanceof Error ? error.message : error);
        }
      })();
    });
    button(actions, "Back", () => void worldsScreen());
    name.focus();
  }

  async function charactersScreen(id: string): Promise<void> {
    clear(() => void worldsScreen());
    if (!(await openWorld(id)) || !connection || !world) return void worldsScreen();
    heading(world.name);
    const h = world.hashes;
    const r = connection.rules;
    if (h.rules !== r.game.hash || h.items !== r.items.hash || h.creatures !== r.creatures.hash || h.progression !== r.progression.hash) {
      note("The packs have changed since this world was made: some of what is saved may be gone or different.", "#e8c070");
    }
    const originName = (id: string): string => r.progression.origins[r.progression.originIndex.get(id) ?? -1]?.name ?? id;
    if (characters.length === 0) {
      newCharacterScreen();
      return;
    }
    for (const c of [...characters].sort((a, b) => b.played - a.played)) {
      const entry = el("div", "display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid rgba(138,109,59,0.4); border-radius: 3px; background: rgba(0,0,0,0.25);", panel);
      const text = el("div", "flex: 1; display: flex; flex-direction: column; gap: 2px;", entry);
      el("div", `font: 600 15px ${TITLE_FONT}; color: ${GOLD};`, text, c.name);
      el("div", `font: 12px sans-serif; color: ${DIM};`, text, `Level ${c.level} ${Object.values(c.origins).map(originName).join(" ")} · ${c.place} · ${ago(c.played)}`);
      button(entry, "Enter world", () => void enter(c.id), "font-size: 12px; padding: 6px 10px;");
      button(entry, "Delete", () => {
        if (!confirm(`Delete ${c.name}? This cannot be undone.`)) return;
        void ask({ type: "characterDelete", id: c.id }).then(() => charactersScreen(id));
      }, "font-size: 12px; padding: 6px 10px;");
    }
    const actions = row();
    button(actions, "Create character", newCharacterScreen);
    button(actions, "Back", () => void worldsScreen());
  }

  /** Making a character: a name and the origins, for now (step 4 brings looks and the preview). */
  function newCharacterScreen(): void {
    if (!connection || !world) return void worldsScreen();
    const id = world.id;
    clear(() => (characters.length ? void charactersScreen(id) : void worldsScreen()));
    heading(`New character in ${world.name}`);
    const progression = connection.rules.progression;
    const selects = new Map<string, HTMLSelectElement>();
    for (const slot of progression.config.slots) {
      const select = document.createElement("select");
      for (const origin of progression.origins) if (origin.slot === slot.id) select.add(new Option(origin.name, origin.id, false, origin.id === slot.default));
      field(slot.id.charAt(0).toUpperCase() + slot.id.slice(1), select);
      selects.set(slot.id, select);
    }
    const name = document.createElement("input");
    name.maxLength = rules.names.max;
    field("Name", name);
    const problem = note("", "#e88");
    const actions = row();
    const create = (): void => {
      const origins = Object.fromEntries([...selects].map(([slot, s]) => [slot, s.value]));
      // A people's body race; the rest of the look from a seed, until step 4's choosers.
      let race = "human";
      for (const originId of Object.values(origins)) {
        const look = progression.origins[progression.originIndex.get(originId) ?? -1]?.raw.look as { race?: unknown } | undefined;
        if (typeof look?.race === "string") race = look.race;
      }
      const look = { seed: Math.floor(Math.random() * 4294967296) >>> 0, race, outfit: "", sex: "" };
      void ask({ type: "characterCreate", name: name.value, origins, look }).then((why) => {
        if (why) problem.textContent = why;
        else {
          const made = characters.find((c) => c.name.toLowerCase() === name.value.trim().toLowerCase());
          if (made) void enter(made.id);
          else void charactersScreen(id);
        }
      });
    };
    name.addEventListener("keydown", (e) => e.key === "Enter" && create());
    button(actions, "Create and enter", create);
    if (characters.length) button(actions, "Back", () => void charactersScreen(id));
    else button(actions, "Back", () => void worldsScreen());
    name.focus();
  }

  // --- Playing ---
  async function enter(character: string): Promise<void> {
    if (!connection || !world || inGame) return;
    inGame = true;
    writeLast({ world: world.id, character });
    showMenu(false);
    // Wait for a showcase still building to be done and gone: two worlds at once is too much memory.
    await building;
    loadingScreen.show();
    loadingScreen.update(`Entering ${world.name}`, 0, 0);
    session = await startSession(page, { connection, enter: { character } });
    options.onSession(session);
  }

  async function play(worldId: string, character?: string): Promise<void> {
    if (!(await openWorld(worldId)) || !world) {
      loadingScreen.hide();
      showMenu(true);
      mainScreen();
      return;
    }
    const chosen = character ?? [...characters].sort((a, b) => b.played - a.played)[0]?.id;
    if (!chosen || !characters.some((c) => c.id === chosen)) {
      loadingScreen.hide();
      showMenu(true);
      void charactersScreen(worldId);
      return;
    }
    await enter(chosen);
  }

  async function leaveGame(toMenu: boolean): Promise<void> {
    if (!session || !connection) return;
    const id = world!.id;
    const done = new Promise<void>((resolve) => {
      listen = (m) => {
        if (m.type === "loggedOut") {
          listen = null;
          resolve();
        }
      };
    });
    session.dispose();
    session = null;
    inGame = false;
    options.onSession(null);
    // The pump takes the server's answers again: LoggedOut once the character is written.
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 3000))]);
    showMenu(true);
    if (toMenu) {
      closeWorld();
      mainScreen();
    } else void charactersScreen(id);
  }

  if (options.hidden) {
    root.style.display = "none";
    hud.playing = true;
  } else {
    showMenu(true);
    mainScreen();
  }

  return {
    play,
    leaveGame,
    get session() {
      return session;
    },
    get showcase() {
      return showcase;
    },
  };
}
