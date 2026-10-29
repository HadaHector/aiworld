/**
 * Where everything on screen goes: fixed regions that panels are put into, so they stack inside
 * their region instead of each picking its own corner and landing on another (GAMEPLAY.md: a normal
 * HUD). A layout pass keeps the bottom row - combat log, action bar, menu - apart however narrow the
 * window is: the menu stands up on end, the log moves up, the spell slots shrink.
 *
 *   frames (top left)                                     info (top right)
 *   debug (left, toggled)                       windows (right: inventory, options...)
 *   log (bottom left)      actions (bottom centre)        menu (bottom right)
 */
export interface Hud {
  /** Own and target unit frames. */
  readonly frames: HTMLElement;
  /** Small readouts at the top right: the zone. */
  readonly info: HTMLElement;
  /** The cast bar, the spell bar and the XP bar, bottom up. */
  readonly actions: HTMLElement;
  readonly log: HTMLElement;
  readonly menu: HTMLElement;
  /** Windows the player opens: they line up from the right edge. */
  readonly windows: HTMLElement;
  /** The debug panel, by section: shown or hidden as one. */
  readonly debug: { readonly root: HTMLElement; readonly settings: HTMLElement; readonly position: HTMLElement; readonly stats: HTMLElement; readonly tools: HTMLElement };
  /** The options window's sections. */
  readonly options: { readonly root: HTMLElement; readonly sound: HTMLElement; readonly graphics: HTMLElement };
  debugVisible: boolean;
  optionsVisible: boolean;
  /** Called on every layout pass with the width the spell bar may take: its slots fit themselves to it. */
  onActionsWidth: (listener: (width: number) => void) => void;
  /** Called with whether the menu should stand on end. */
  onMenuVertical: (listener: (vertical: boolean) => void) => void;
  /** Lays the bottom row out again - after something in it changed size. */
  layout: () => void;
}

/** Takes an element out of its own fixed place and puts it in a region. */
export function dock(element: HTMLElement, parent: HTMLElement): void {
  const s = element.style;
  s.position = "relative";
  s.top = s.left = s.right = s.bottom = "";
  s.transform = "";
  s.zIndex = "";
  s.margin = "0";
  parent.appendChild(element);
}

const EDGE = 12;
const GAP = 8;
const PANEL = "background: rgba(18, 20, 24, 0.9); color: #eee; border-radius: 6px; font: 12px/1.35 system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,0.45);";
const DEBUG_KEY = "aiworld.debugPanel";

export function createHud(): Hud {
  // Regions take no clicks themselves - only what is in them does.
  const style = document.createElement("style");
  style.textContent = ".hud-region { position: fixed; pointer-events: none; display: flex; gap: 8px; } .hud-region > * { pointer-events: auto; }";
  document.head.appendChild(style);
  const region = (css: string, z = 900): HTMLElement => {
    const e = document.createElement("div");
    e.className = "hud-region";
    e.style.cssText = `${css} z-index: ${z};`;
    document.body.appendChild(e);
    return e;
  };
  const frames = region(`top: ${EDGE}px; left: ${EDGE}px; flex-wrap: wrap; align-items: flex-start; max-width: calc(100vw - ${2 * EDGE}px);`);
  const info = region(`top: ${EDGE}px; right: ${EDGE}px; flex-direction: column; align-items: flex-end;`);
  const actions = region(`bottom: ${EDGE}px; left: 50%; transform: translateX(-50%); flex-direction: column; align-items: center; gap: 4px;`);
  const log = region(`bottom: ${EDGE}px; left: ${EDGE}px;`);
  const menu = region(`bottom: ${EDGE}px; right: ${EDGE}px; align-items: flex-end;`);
  const windows = region(`right: ${EDGE}px; flex-direction: row-reverse; align-items: flex-start;`, 950);
  const debugRoot = region(`left: ${EDGE}px; flex-direction: column; align-items: flex-start; overflow-y: auto; display: none; max-width: min(380px, 45vw);`, 920);
  const section = (parent: HTMLElement): HTMLElement => {
    const e = document.createElement("div");
    e.style.cssText = "display: flex; flex-direction: column; align-items: flex-start; gap: 6px;";
    parent.appendChild(e);
    return e;
  };
  const debug = { root: debugRoot, settings: section(debugRoot), position: section(debugRoot), stats: section(debugRoot), tools: section(debugRoot) };

  // The options window, in the windows region.
  const optionsRoot = document.createElement("div");
  optionsRoot.style.cssText = `${PANEL} padding: 8px 10px; width: 300px; display: none; flex-direction: column; gap: 6px;`;
  const optionsHead = document.createElement("div");
  optionsHead.style.cssText = "display: flex; justify-content: space-between; font-weight: 600; font-size: 13px;";
  optionsHead.textContent = "Options";
  const close = document.createElement("span");
  close.textContent = "×";
  close.style.cssText = "cursor: pointer; color: #aaa;";
  optionsHead.appendChild(close);
  const heading = (text: string): void => {
    const h = document.createElement("div");
    h.style.cssText = "color: #ffd27a; font-weight: 600; margin-top: 4px;";
    h.textContent = text;
    optionsRoot.appendChild(h);
  };
  optionsRoot.appendChild(optionsHead);
  heading("Sound");
  const sound = section(optionsRoot);
  heading("Graphics");
  const graphics = section(optionsRoot);
  windows.appendChild(optionsRoot);

  /** Open windows, in the order they were opened: when they do not fit side by side, the one open
   *  longest closes. */
  let openOrder: HTMLElement[] = [];
  const widthListeners: ((width: number) => void)[] = [];
  const verticalListeners: ((vertical: boolean) => void)[] = [];
  let lastWidth = -1;
  let lastVertical: boolean | null = null;
  let flatMenu = 0;

  function layout(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // The menu lies flat if the side of the action bar has room for it, else stands on end: its
    // flat width is measured while it lies flat.
    if (!lastVertical) flatMenu = menu.offsetWidth;
    // The action bar may take what is left between the two sides' least: the menu on end and a
    // log moved out of the way.
    const sideLeast = 56;
    const actionRoom = Math.max(160, vw - 2 * (EDGE + GAP + sideLeast));
    if (actionRoom !== lastWidth) {
      lastWidth = actionRoom;
      for (const l of widthListeners) l(actionRoom);
    }
    const actionsWidth = actions.offsetWidth;
    const side = (vw - actionsWidth) / 2 - EDGE - GAP;
    const vertical = side < flatMenu;
    if (vertical !== lastVertical) {
      lastVertical = vertical;
      for (const l of verticalListeners) l(vertical);
    }
    // The frames keep clear of the info at the top right: the target's wraps under the own frame.
    frames.style.maxWidth = `${Math.max(260, vw - 2 * EDGE - info.offsetWidth - GAP)}px`;
    // The log sits beside the action bar when it fits there, else above it - and never takes more
    // than a share of the screen's height.
    const logBeside = side >= 240;
    const logWidth = logBeside ? Math.min(400, side) : Math.min(400, vw - 2 * EDGE - menu.offsetWidth - GAP);
    log.style.width = `${Math.max(160, logWidth)}px`;
    log.style.bottom = `${logBeside ? EDGE : EDGE + actions.offsetHeight + GAP}px`;
    const logBox = log.firstElementChild as HTMLElement | null;
    if (logBox) logBox.style.maxHeight = `${Math.round(vh * (logBeside ? 0.3 : 0.18))}px`;
    // Windows and the debug panel keep clear of the bottom row, the frames and each other.
    const bottomRow = Math.max(actions.offsetHeight, menu.offsetHeight, logBeside ? log.offsetHeight : 0) + EDGE + GAP;
    const top = Math.max(info.offsetHeight, frames.offsetHeight) + EDGE + GAP;
    windows.style.top = `${top}px`;
    windows.style.height = `${Math.max(120, vh - top - bottomRow)}px`;
    const room = vw - 2 * EDGE - (debugVisible ? debugRoot.offsetWidth + GAP : 0);
    windows.style.maxWidth = `${Math.max(0, room)}px`;
    const open = [...windows.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.style.display !== "none");
    openOrder = [...openOrder.filter((w) => open.includes(w)), ...open.filter((w) => !openOrder.includes(w))];
    let width = openOrder.reduce((sum, w) => sum + w.offsetWidth + GAP, -GAP);
    while (openOrder.length > 1 && width > room) {
      const oldest = openOrder.shift()!;
      width -= oldest.offsetWidth + GAP;
      oldest.style.display = "none";
    }
    const debugTop = frames.offsetHeight + EDGE + GAP;
    debugRoot.style.top = `${debugTop}px`;
    debugRoot.style.maxHeight = `${Math.max(120, vh - debugTop - bottomRow - (logBeside ? 0 : log.offsetHeight + GAP))}px`;
  }
  window.addEventListener("resize", layout);
  // What is in the regions changes size as the game goes (spells learned, a target taken).
  setInterval(layout, 250);

  let debugVisible = false;
  try {
    debugVisible = localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    // No storage: the panel starts hidden.
  }
  debugRoot.style.display = debugVisible ? "flex" : "none";
  close.addEventListener("click", () => (hud.optionsVisible = false));

  const hud: Hud = {
    frames,
    info,
    actions,
    log,
    menu,
    windows,
    debug,
    options: { root: optionsRoot, sound, graphics },
    get debugVisible() {
      return debugVisible;
    },
    set debugVisible(on: boolean) {
      debugVisible = on;
      debugRoot.style.display = on ? "flex" : "none";
      try {
        localStorage.setItem(DEBUG_KEY, on ? "1" : "0");
      } catch {
        // Not remembered; fine.
      }
      layout();
    },
    get optionsVisible() {
      return optionsRoot.style.display !== "none";
    },
    set optionsVisible(on: boolean) {
      optionsRoot.style.display = on ? "flex" : "none";
    },
    onActionsWidth: (listener) => void widthListeners.push(listener),
    onMenuVertical: (listener) => void verticalListeners.push(listener),
    layout,
  };
  requestAnimationFrame(layout);
  return hud;
}
