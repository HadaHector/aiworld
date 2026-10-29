/**
 * The game's look for its screens (GAMEPLAY.md, *Interface*): dark panels framed in bronze, titles in
 * a book face, beveled buttons and slots, glossy bars. One place, so every game screen matches and a
 * game built on the framework restyles them here. Inline-style strings for the pieces, and a small
 * stylesheet for what inline styles cannot say (hover, pressed, scrollbars). Debug tools keep their
 * plain look on purpose.
 */

export const GOLD = "#f0c979";
export const TEXT = "#e9dfc7";
export const DIM = "#a89a7c";
export const BRONZE = "#7a6235";

/** The book face titles and names are set in; system fonts only, so it works offline. */
export const TITLE_FONT = `"Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif`;
const BODY_FONT = `"Segoe UI", system-ui, sans-serif`;

/** A framed panel: a window, a unit frame. */
export const PANEL = `background: linear-gradient(180deg, rgba(34, 30, 24, 0.96), rgba(16, 14, 11, 0.96)); color: ${TEXT};
  border: 1px solid ${BRONZE}; border-radius: 4px; font: 12px/1.35 ${BODY_FONT};
  box-shadow: 0 0 0 1px #000, inset 0 1px 0 rgba(255, 228, 170, 0.08), 0 4px 14px rgba(0, 0, 0, 0.6);`;

/** A lighter panel for what sits over the world all the time: the combat log. */
export const QUIET_PANEL = `background: rgba(12, 10, 8, 0.62); color: ${TEXT}; border: 1px solid rgba(122, 98, 53, 0.45);
  border-radius: 4px; font: 11px/1.35 ${BODY_FONT}; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);`;

/** A window's title strip: gold book-face lettering over a darker band. */
export const WINDOW_HEAD = `display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin: -8px -10px 8px; padding: 6px 10px; border-bottom: 1px solid ${BRONZE};
  background: linear-gradient(180deg, #3a2f1d, #211a10); border-radius: 4px 4px 0 0;
  font: 600 14px/1.2 ${TITLE_FONT}; color: ${GOLD}; letter-spacing: 0.04em; text-shadow: 0 1px 2px #000;`;

/** A section heading inside a window. */
export const HEADING = `font: 600 13px/1.3 ${TITLE_FONT}; color: ${GOLD}; letter-spacing: 0.03em; margin: 8px 0 3px;`;

/** A slot - a spell, an item, a menu button: a dark inset square in a bronze frame. */
export const SLOT = `background: radial-gradient(circle at 50% 35%, #2c2a26, #121110 75%); border: 1px solid #8a6d3b;
  border-radius: 4px; box-shadow: 0 0 0 1px #000, inset 0 0 0 1px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 230, 170, 0.12);
  color: ${TEXT};`;

/** A bar's empty track. */
export const BAR_TRACK = `position: relative; background: linear-gradient(180deg, #080706, #18150f); border: 1px solid #000;
  border-radius: 3px; overflow: hidden; box-shadow: 0 0 0 1px rgba(122, 98, 53, 0.6), inset 0 1px 3px rgba(0, 0, 0, 0.8);`;

/** Text over a bar. */
export const BAR_TEXT = `position: absolute; inset: 0; text-align: center; color: #fff; text-shadow: 0 1px 1px #000, 0 0 3px #000; font-weight: 600;`;

/** A bar's fill in a colour: a gloss on top, darker below. */
export function barFill(colour: string): string {
  return `position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(180deg, rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0) 45%, rgba(0, 0, 0, 0.25)), ${colour};`;
}

/** The colours of resources by id, and of the other bars. */
export const BAR_COLOURS: Record<string, string> = {
  health: "#2f9e3a",
  mana: "#2f5fd0",
  rage: "#b8291f",
  energy: "#d8b020",
  cast: "#d79a28",
  xp: "#7a48d0",
};

/** The class of a game button (see the stylesheet). */
export const BUTTON_CLASS = "game-button";
/** The class of a window's close cross. */
export const CLOSE_CLASS = "game-close";
/** The class of a slot that lights up under the pointer. */
export const SLOT_CLASS = "game-slot";

let installed = false;

/** Adds the stylesheet once: buttons, close crosses, slots' hover, and bronze scrollbars in panels. */
export function installTheme(): void {
  if (installed) return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = `
    .${BUTTON_CLASS} {
      font: 600 11px/1 ${BODY_FONT}; color: ${TEXT}; cursor: pointer; padding: 4px 9px;
      background: linear-gradient(180deg, #4a3d26, #241d12); border: 1px solid #8a6d3b; border-radius: 3px;
      box-shadow: 0 0 0 1px #000, inset 0 1px 0 rgba(255, 230, 170, 0.18); text-shadow: 0 1px 1px #000;
    }
    .${BUTTON_CLASS}:hover { background: linear-gradient(180deg, #5d4c2e, #2e2416); color: #fff; border-color: ${GOLD}; }
    .${BUTTON_CLASS}:active { background: linear-gradient(180deg, #1e180f, #3a2f1d); box-shadow: 0 0 0 1px #000, inset 0 1px 3px rgba(0, 0, 0, 0.7); }
    .${CLOSE_CLASS} {
      display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; cursor: pointer;
      border-radius: 50%; border: 1px solid #8a6d3b; background: radial-gradient(circle at 40% 35%, #5a3a24, #2a1810);
      color: ${GOLD}; font: 700 12px/1 ${BODY_FONT}; box-shadow: 0 0 0 1px #000; text-shadow: none;
    }
    .${CLOSE_CLASS}:hover { color: #fff; border-color: ${GOLD}; background: radial-gradient(circle at 40% 35%, #7a4a2a, #3a2010); }
    .${SLOT_CLASS}:hover { border-color: ${GOLD} !important; box-shadow: 0 0 0 1px #000, 0 0 6px rgba(240, 201, 121, 0.45), inset 0 0 0 1px rgba(0, 0, 0, 0.8) !important; }
    .game-scroll::-webkit-scrollbar, .hud-region ::-webkit-scrollbar { width: 9px; height: 9px; }
    .game-scroll::-webkit-scrollbar-track, .hud-region ::-webkit-scrollbar-track { background: #0d0b08; }
    .game-scroll::-webkit-scrollbar-thumb, .hud-region ::-webkit-scrollbar-thumb { background: linear-gradient(90deg, #5d4a2a, #3a2e1a); border: 1px solid #000; border-radius: 4px; }
    .hud-region * { scrollbar-color: #5d4a2a #0d0b08; }
    .hud-region input[type=range], .hud-region input[type=checkbox] { accent-color: #c9a040; }
    .game-options-section > * { background: none !important; border: none !important; box-shadow: none !important; padding: 2px 0 !important; color: ${TEXT} !important; font-size: 12px !important; }
    .game-link { color: #8fc0ff; cursor: pointer; }
    .game-link:hover { color: #c8e0ff; text-decoration: underline; }
  `;
  document.head.appendChild(style);
}

/** A window's title strip with its close cross. */
export function windowHead(parent: HTMLElement, title: string, onClose: (() => void) | null): { head: HTMLElement; title: HTMLElement } {
  const head = document.createElement("div");
  head.style.cssText = WINDOW_HEAD;
  const name = document.createElement("span");
  name.textContent = title;
  head.appendChild(name);
  if (onClose) {
    const close = document.createElement("span");
    close.className = CLOSE_CLASS;
    close.textContent = "×";
    close.addEventListener("click", onClose);
    head.appendChild(close);
  }
  parent.appendChild(head);
  return { head, title: name };
}
