import type { Page, Session } from "../game/session";
import { startSession } from "../game/session";
import { connectLocal, type Connection } from "../game/connection";
import { createShowcase, type Framing, type Showcase } from "./showcase";
import type { FrontendRules } from "./frontendRules";
import type { SaveStore } from "../save/store";
import { createWorldRecord, makeSaveId, type CharacterSummary, type WorldRecord } from "../save/records";
import { packSetFrom } from "../world/content/loadContent";
import type { PackSource } from "../world/content/resolveContent";
import { fetchWorldConfig } from "../world/content/loadContent";
import { hashString } from "../world/content/dimensions";
import { PROTOCOL_VERSION, type ServerMessage } from "../sim/protocol";
import { BUTTON_CLASS, DIM, GOLD, HEADING, PANEL, TEXT, TITLE_FONT, installTheme } from "../ui/theme";
import { createBodyKit, type BodyLook } from "../game/characterBody";
import { gearOfItems } from "../game/itemGear";
import { chooseAppearance } from "../character/paint";
import type { RaceDef, Sex } from "../character/raceDef";
import type { EntityAppearance, LookChoices } from "../sim/protocol";

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
  /** Character creation's looks, on the right; hidden on every other screen. */
  const side = el("div", `${PANEL} position: absolute; right: clamp(16px, 4vw, 60px); top: 50%; transform: translateY(-50%); width: min(300px, calc(100vw - 32px)); max-height: 80vh; overflow-y: auto; padding: 12px 14px; display: none; flex-direction: column; gap: 6px; pointer-events: auto; color: ${TEXT};`, root);
  side.className = "game-scroll";
  /** Over the stage while its character is being made. */
  const preparing = el("div", `position: absolute; left: 62%; top: 46%; transform: translate(-50%, -50%); padding: 6px 12px; ${PANEL} font: 600 13px ${TITLE_FONT}; color: ${GOLD}; display: none; pointer-events: none;`, root, "Preparing the character…");
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
    side.replaceChildren();
    side.style.display = "none";
    back = onBack;
    stage(null);
  };
  const row = (): HTMLElement => el("div", "display: flex; gap: 6px; flex-wrap: wrap;", panel);

  // --- The showcase world and the theme ---
  let showcase: Showcase | null = null;
  /** What the stage shows, kept for a showcase still being built. */
  let staging: BodyLook | null = null;
  let framing: Framing = "centre";
  function stage(look: BodyLook | null, frame: Framing = "centre"): void {
    staging = look;
    framing = frame;
    showcase?.stage(look, frame);
  }
  /** Races, gear and outfits: the creation screen's palettes come from them. */
  const kit = createBodyKit(options.sources as PackSource[]);
  let building: Promise<void> | null = null;
  function buildShowcase(): void {
    if (showcase || building) return;
    backdrop.style.opacity = "1";
    // Generating the menu's world holds the main thread: the theme is scheduled far ahead meanwhile.
    music.hold(true);
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
          built.stage(staging, framing);
          backdrop.style.opacity = "0";
        }
        status.textContent = "";
      } catch (error) {
        console.warn("The showcase world could not be built:", error);
        status.textContent = "";
      } finally {
        building = null;
        music.hold(false);
      }
    })();
  }
  const musicTimer = window.setInterval(() => {
    if (root.style.display === "none") return;
    music.update({ style: rules.music.menu, place: 0, inside: true });
    // On the list the character stands right of the middle; on creation, in it.
    preparing.style.display = showcase?.preparing || (staging && !showcase) ? "" : "none";
    preparing.style.left = framing === "right" ? "62%" : "50%";
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

  /** What a character's body wears on the stage: its worn items, or - new - its class's start items. */
  function stageGear(origins: Record<string, string>, worn: readonly string[]): BodyLook["gear"] {
    const r = connection!.rules;
    if (worn.length > 0) return gearOfItems(r.items, worn);
    const template = ["player", ...r.progression.config.slots.map((slot) => origins[slot.id])].join(".");
    const start = r.items.entities.get(template)?.start ?? [];
    return gearOfItems(r.items, start.filter((s) => r.items.types[s.type].slots.length > 0).map((s) => r.items.types[s.type].id));
  }
  const bodyLook = (look: EntityAppearance, gear: BodyLook["gear"]): BodyLook => ({
    race: look.race || "human",
    outfit: look.outfit || "scout",
    sex: look.sex === "male" || look.sex === "female" ? look.sex : undefined,
    seed: look.seed,
    choices: look.choices,
    gear,
  });

  async function charactersScreen(id: string, selected?: string): Promise<void> {
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
    const sorted = [...characters].sort((a, b) => b.played - a.played);
    let chosen = sorted.find((c) => c.id === selected) ?? sorted[0];
    const entries: [CharacterSummary, HTMLElement][] = [];
    const choose = (c: CharacterSummary): void => {
      chosen = c;
      for (const [summary, entry] of entries) entry.style.borderColor = summary === c ? GOLD : "rgba(138,109,59,0.4)";
      // A character saved before lists had looks shows as its seed would.
      stage(bodyLook(c.look ?? { seed: 0, race: "", outfit: "", sex: "" }, stageGear(c.origins, c.gear ?? [])), "right");
    };
    for (const c of sorted) {
      const entry = el("div", "display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid rgba(138,109,59,0.4); border-radius: 3px; background: rgba(0,0,0,0.25); cursor: pointer;", panel);
      entries.push([c, entry]);
      entry.addEventListener("click", () => choose(c));
      entry.addEventListener("dblclick", () => void enter(c.id));
      const text = el("div", "flex: 1; display: flex; flex-direction: column; gap: 2px;", entry);
      el("div", `font: 600 15px ${TITLE_FONT}; color: ${GOLD};`, text, c.name);
      el("div", `font: 12px sans-serif; color: ${DIM};`, text, `Level ${c.level} ${Object.values(c.origins).map(originName).join(" ")} · ${c.place} · ${ago(c.played)}`);
      button(entry, "Delete", () => {
        if (!confirm(`Delete ${c.name}? This cannot be undone.`)) return;
        void ask({ type: "characterDelete", id: c.id }).then(() => charactersScreen(id));
      }, "font-size: 12px; padding: 6px 10px;");
    }
    const actions = row();
    button(actions, "Enter world", () => void enter(chosen.id));
    button(actions, "Create character", newCharacterScreen);
    button(actions, "Back", () => void worldsScreen());
    choose(chosen);
  }

  /**
   * Making a character (FRONTEND.md, *Character creation*): its origins on the left, with what each
   * gives; its looks on the right, each chooser over what the seed picks; a name; and the character
   * itself on the stage, built again as the choices change.
   */
  function newCharacterScreen(): void {
    if (!connection || !world) return void worldsScreen();
    const id = world.id;
    clear(() => (characters.length ? void charactersScreen(id) : void worldsScreen()));
    const r = connection.rules;
    const progression = r.progression;
    const game = r.game;
    heading(`New character in ${world.name}`);

    // --- What it is ---
    const origins: Record<string, string> = Object.fromEntries(progression.config.slots.map((slot) => [slot.id, slot.default]));
    const originOf = (id: string) => progression.origins[progression.originIndex.get(id) ?? -1];
    /** Why an origin cannot go with the others chosen, or "". */
    const conflict = (slot: string, id: string): string => {
      const origin = originOf(id);
      for (const [other, otherId] of Object.entries(origins)) {
        if (other === slot) continue;
        const o = originOf(otherId);
        if (!origin || !o) continue;
        if (origin.never.includes(otherId) || o.never.includes(id)) return `Not with ${o.name}.`;
        if (origin.only.length > 0 && !origin.only.some((only) => originOf(only)?.slot === other && only === otherId) && origin.only.some((only) => originOf(only)?.slot === other)) return `Only with ${origin.only.map((only) => originOf(only)?.name ?? only).join(", ")}.`;
      }
      return "";
    };
    const raceOf = (): string => {
      for (const originId of Object.values(origins)) {
        const look = originOf(originId)?.raw.look as { race?: unknown } | undefined;
        if (typeof look?.race === "string" && kit.races.has(look.race)) return look.race;
      }
      return kit.races.has("human") ? "human" : [...kit.races.keys()][0];
    };
    const statName = (id: string): string => game.stats[game.statIndex.get(id) ?? -1]?.name ?? id;
    const skillName = (id: string): string => game.skills[game.skillIndex.get(id) ?? -1]?.name ?? id;
    const describe = (id: string): string[] => {
      const origin = originOf(id);
      if (!origin) return [];
      const lines: string[] = [];
      const stats = origin.raw.stats as Record<string, number> | undefined;
      if (stats) lines.push(Object.entries(stats).map(([stat, v]) => `${statName(stat)} ${v > 0 ? "+" : ""}${v}`).join(", "));
      const spells = ((origin.raw.spells as { skill: string }[] | undefined) ?? []).map((s) => s.skill).filter((skill) => skill !== "autoAttack");
      if (spells.length > 0) lines.push(`Starts with ${spells.map(skillName).join(", ")}`);
      const disciplines = origin.disciplines.filter((d) => progression.disciplines[d.discipline] && progression.disciplines[d.discipline].id !== "class");
      if (disciplines.length > 0) lines.push(disciplines.map((d) => `${progression.disciplines[d.discipline].name} ${d.level}`).join(", "));
      return lines;
    };
    const slotRows = new Map<string, HTMLElement>();
    const about = el("div", "display: flex; flex-direction: column; gap: 6px;");
    for (const slot of progression.config.slots) {
      el("div", `font: 600 12px sans-serif; color: ${DIM}; margin-top: 2px;`, panel, slot.id.charAt(0).toUpperCase() + slot.id.slice(1));
      slotRows.set(slot.id, el("div", "display: flex; gap: 5px; flex-wrap: wrap;", panel));
    }
    panel.appendChild(about);
    const showOrigins = (): void => {
      for (const slot of progression.config.slots) {
        const list = slotRows.get(slot.id)!;
        list.replaceChildren();
        for (const origin of progression.origins) {
          if (origin.slot !== slot.id) continue;
          const why = conflict(slot.id, origin.id);
          const b = button(list, origin.name, () => {
            origins[slot.id] = origin.id;
            if (slot.id === "people") look.race = raceOf();
            showOrigins();
            showLooks();
            update();
            // The class shown off once its body is in.
            if (slot.id === "class") setTimeout(() => showcase?.flourish(), 900);
          }, `font-size: 12px; padding: 5px 9px; ${origins[slot.id] === origin.id ? `border-color: ${GOLD}; color: #fff;` : ""}`);
          b.disabled = why !== "" && origins[slot.id] !== origin.id;
          if (why) b.title = why;
          if (b.disabled) b.style.opacity = "0.45";
        }
      }
      about.replaceChildren();
      for (const slot of progression.config.slots) {
        const origin = originOf(origins[slot.id]);
        if (!origin) continue;
        const box = el("div", "padding: 6px 8px; border-left: 2px solid rgba(240,201,121,0.5); background: rgba(0,0,0,0.2);", about);
        el("div", `font: 600 13px ${TITLE_FONT}; color: ${GOLD};`, box, origin.name);
        if (origin.description) el("div", "font: 12px/1.45 sans-serif;", box, origin.description);
        for (const line of describe(origin.id)) el("div", `font: 11px/1.4 sans-serif; color: ${DIM};`, box, line);
      }
    };

    // --- How it looks ---
    const look: { seed: number; race: string; sex: Sex | undefined; choices: LookChoices } = { seed: Math.floor(Math.random() * 4294967296) >>> 0, race: raceOf(), sex: undefined, choices: {} };
    const race = (): RaceDef => kit.races.get(look.race)!;
    const appearance = () => chooseAppearance(race(), look.seed, look.sex, {}, look.choices);
    const sameColour = (a: readonly number[], b: readonly number[]): boolean => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
    const css = (c: readonly number[]): string => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
    const lookHeading = (text: string): void => void el("div", `font: 600 12px sans-serif; color: ${DIM}; margin-top: 4px;`, side, text);
    const choose = (key: keyof LookChoices, value: number): void => {
      look.choices = { ...look.choices, [key]: value };
      showLooks();
      update();
    };
    const slider = (label: string, key: keyof LookChoices, value: number, low: number, high: number): void => {
      const row_ = el("label", "display: grid; grid-template-columns: 82px 1fr; align-items: center; gap: 6px; font: 12px sans-serif;", side, label);
      const input = el("input", "accent-color: #c9a040;", row_);
      input.type = "range";
      input.min = String(low);
      input.max = String(high);
      input.step = "0.01";
      input.value = String(value);
      input.addEventListener("change", () => choose(key, Number(input.value)));
    };
    const showLooks = (): void => {
      side.replaceChildren();
      const r_ = race();
      const a = appearance();
      el("div", `${HEADING} font-size: 15px; margin: 0;`, side, `${r_.name}`);
      lookHeading("Body");
      const sexes = el("div", "display: flex; gap: 5px;", side);
      for (const sex of ["male", "female"] as const) {
        button(sexes, sex === "male" ? "Male" : "Female", () => {
          look.sex = sex;
          showLooks();
          update();
        }, `font-size: 12px; padding: 5px 10px; ${a.sex === sex ? `border-color: ${GOLD}; color: #fff;` : ""}`);
      }
      const [hl, hh] = r_.sliders.height;
      const [bl, bh] = r_.sliders.build;
      slider("Height", "height", (a.height - hl) / (hh - hl || 1), 0, 1);
      slider("Build", "build", (a.build - bl) / (bh - bl || 1), 0, 1);
      const swatches = (label: string, key: "skin" | "hair" | "eyes", list: readonly (readonly number[])[], current: readonly number[]): void => {
        lookHeading(label);
        const row_ = el("div", "display: flex; gap: 4px; flex-wrap: wrap;", side);
        list.forEach((colour, i) => {
          const swatch = el("div", `width: 22px; height: 22px; border-radius: 3px; cursor: pointer; background: ${css(colour)}; border: 2px solid ${sameColour(colour, current) ? GOLD : "#000"}; box-shadow: 0 0 0 1px #6b5530;`, row_);
          swatch.addEventListener("click", () => choose(key, i));
        });
      };
      swatches("Skin", "skin", r_.look.skin, a.skin);
      swatches("Hair", "hair", r_.look.hair, a.hair);
      swatches("Eyes", "eyes", r_.look.eyes, a.eyes);
      if (r_.look.hairStyles.length > 0) {
        lookHeading("Hair style");
        const row_ = el("div", "display: flex; gap: 4px; flex-wrap: wrap;", side);
        r_.look.hairStyles.forEach((style, i) => {
          button(row_, style.name, () => choose("hairStyle", i), `font-size: 11px; padding: 4px 7px; ${a.hairStyle.id === style.id ? `border-color: ${GOLD}; color: #fff;` : ""}`);
        });
      }
      if (r_.sexes[a.sex].beard > 0) {
        const row_ = el("label", "display: flex; align-items: center; gap: 6px; font: 12px sans-serif; margin-top: 4px;", side);
        const box = el("input", "accent-color: #c9a040;", row_);
        box.type = "checkbox";
        box.checked = a.beard;
        row_.append("Beard");
        box.addEventListener("change", () => choose("beard", box.checked ? 1 : 0));
      }
      lookHeading("Face");
      slider("Eyes apart", "eyeSpacing", a.eyeSpacing, -1, 1);
      slider("Brows", "browTilt", a.browTilt, -1, 1);
      slider("Mouth", "mouthWidth", a.mouthWidth, -1, 1);
      const actions = el("div", "display: flex; gap: 5px; margin-top: 8px;", side);
      button(actions, "Randomise", () => {
        look.seed = Math.floor(Math.random() * 4294967296) >>> 0;
        look.sex = undefined;
        look.choices = {};
        showLooks();
        update();
      }, "font-size: 12px; padding: 6px 10px;");
      el("div", `font: 11px/1.4 sans-serif; color: ${DIM}; margin-top: 4px;`, side, "Drag the character to turn it; the wheel brings the camera to its face.");
    };
    const update = (): void => {
      const a = appearance();
      stage(bodyLook({ seed: look.seed, race: look.race, outfit: "", sex: a.sex, choices: look.choices }, stageGear(origins, [])));
    };

    // --- Its name ---
    const name = document.createElement("input");
    name.maxLength = rules.names.max;
    field("Name", name);
    const problem = note("", "#e88");
    const actions = row();
    const create = (): void => {
      const a = appearance();
      const sent: EntityAppearance = { seed: look.seed, race: look.race, outfit: "", sex: a.sex, ...(Object.keys(look.choices).length > 0 ? { choices: look.choices } : {}) };
      void ask({ type: "characterCreate", name: name.value, origins, look: sent }).then((why) => {
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

    side.style.display = "flex";
    showOrigins();
    showLooks();
    update();
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
