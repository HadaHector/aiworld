import { BRONZE, GOLD, PANEL, SLOT, SLOT_CLASS, TEXT } from "./theme";

/**
 * A row of icon buttons for the screens that otherwise open only from a key: each shows its key, a
 * tooltip, and lights up while its screen is open. Game screens first, then a smaller debug group.
 * Plain DOM, as the other panels; the HUD proper is step 10.
 */
export interface MenuEntry {
  /** An icon from `ICONS`. */
  icon: keyof typeof ICONS;
  label: string;
  /** The key that opens it too, shown on the button. */
  key: string;
  toggle: () => void;
  /** Whether its screen is open, for the lit state; left out when the screen cannot say. */
  open?: () => boolean;
  debug?: boolean;
}

export interface MenuBar {
  /** Its element, for a HUD region to take (ui/hud.ts). */
  readonly element: HTMLElement;
  /** Stands it on end - a column - when the window is too narrow for a row. */
  setVertical: (on: boolean) => void;
  dispose: () => void;
}

/** 20 × 20 line drawings, stroked in the current colour. */
const ICONS = {
  bag: '<path d="M5 8h10l-1 9H6z"/><path d="M7.5 8V6.5a2.5 2.5 0 0 1 5 0V8"/>',
  progress: '<path d="M3 16h14"/><path d="M5 13l4-4 3 3 4-6"/><path d="M13 6h3v3"/>',
  book: '<path d="M4 4.5h5a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 0-1.5-1.5H4z"/><path d="M16 4.5h-5A1.5 1.5 0 0 0 9.5 6v10a1.5 1.5 0 0 1 1.5-1.5h5z"/>',
  inspect: '<circle cx="8.5" cy="8.5" r="4.5"/><path d="M12 12l4.5 4.5"/>',
  map: '<path d="M3 5l4.5-1.5 5 1.5L17 3.5v11.5L12.5 16.5l-5-1.5L3 16.5z"/><path d="M7.5 3.5v11.5M12.5 5v11.5"/>',
  options: '<circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/>',
  debug: '<rect x="6" y="6.5" width="8" height="10" rx="4"/><path d="M8 6.5a2 2 0 0 1 4 0M3.5 9.5H6M14 9.5h2.5M3.5 13.5H6M14 13.5h2.5M10 9v7"/>',
  textures: '<rect x="3.5" y="3.5" width="5" height="5"/><rect x="11.5" y="3.5" width="5" height="5"/><rect x="3.5" y="11.5" width="5" height="5"/><rect x="11.5" y="11.5" width="5" height="5"/>',
} as const;


export function createMenuBar(entries: MenuEntry[]): MenuBar {
  const root = document.createElement("div");
  root.style.cssText = `position: fixed; right: 16px; bottom: 56px; z-index: 900; ${PANEL} display: flex; gap: 4px; padding: 5px; align-items: flex-end;`;
  document.body.appendChild(root);
  const buttons: { button: HTMLButtonElement; entry: MenuEntry }[] = [];
  let lastDebug = false;
  for (const entry of entries) {
    if (entry.debug && !lastDebug && buttons.length) {
      const gap = document.createElement("div");
      gap.style.cssText = `width: 1px; align-self: stretch; margin: 2px 3px; background: ${BRONZE};`;
      gap.dataset.gap = "1";
      root.appendChild(gap);
    }
    lastDebug = !!entry.debug;
    const size = entry.debug ? 28 : 36;
    const button = document.createElement("button");
    button.title = `${entry.label} (${entry.key})`;
    button.style.cssText = `position: relative; width: ${size}px; height: ${size}px; padding: 0; ${SLOT}
      cursor: pointer; display: flex; align-items: center; justify-content: center;`;
    button.className = SLOT_CLASS;
    const icon = Math.round(size * 0.6);
    button.innerHTML = `<svg width="${icon}" height="${icon}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[entry.icon]}</svg>
      <span style="position: absolute; right: 2px; bottom: 1px; font: 700 9px/1 system-ui, sans-serif; color: ${GOLD}; text-shadow: 0 1px 1px #000;">${entry.key}</span>`;
    // Clicking must not leave focus on the button, or the next key press would go to it.
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => {
      entry.toggle();
      refresh();
    });
    root.appendChild(button);
    buttons.push({ button, entry });
  }

  /** Lights the buttons whose screens are open - screens also open from their keys, so it polls. */
  function refresh(): void {
    for (const { button, entry } of buttons) {
      const open = entry.open?.() ?? false;
      // Lit: gold, glowing. Not lit: the slot's own look (its hover comes from the stylesheet).
      button.style.borderColor = open ? GOLD : "";
      button.style.color = open ? GOLD : TEXT;
      button.style.boxShadow = open ? "0 0 0 1px #000, 0 0 8px rgba(240, 201, 121, 0.55), inset 0 0 10px rgba(240, 201, 121, 0.18)" : "";
    }
  }
  const timer = setInterval(refresh, 250);
  refresh();

  return {
    element: root,
    setVertical(on) {
      root.style.flexDirection = on ? "column-reverse" : "row";
      root.style.alignItems = on ? "center" : "flex-end";
      for (const gap of root.querySelectorAll<HTMLElement>("[data-gap]")) {
        gap.style.width = on ? "auto" : "1px";
        gap.style.height = on ? "1px" : "auto";
        gap.style.alignSelf = "stretch";
      }
    },
    dispose() {
      clearInterval(timer);
      root.remove();
    },
  };
}
