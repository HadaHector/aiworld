/**
 * The chat window (CHAT.md): the combat log grown into somewhere to type. Lines on channels (combat,
 * system, say; party and whisper to come) in colours, tabs that filter them, a wheel to scroll, a
 * grip to resize, a fade when quiet - and an input line that Enter opens and Enter sends, Escape
 * closes, the arrow keys walk back through what was typed, and Tab completes.
 *
 * While the input has the keyboard, keys do not reach the window's game handlers: the input stops
 * their `keydown` here (they listen on `window`, after it), and `onTyping` lets the game release any
 * key that was held when it opened.
 */
import { BRONZE, DIM, GOLD, QUIET_PANEL, TITLE_FONT } from "./theme";

export type ChatChannel = "combat" | "system" | "say" | "party" | "whisper";

const COLOURS: Record<ChatChannel, string> = {
  combat: "#d8ceb6",
  system: "#f0c979",
  say: "#ffffff",
  party: "#7ab8ff",
  whisper: "#d79bff",
};
const TABS: { id: string; label: string; channels: readonly ChatChannel[] }[] = [
  { id: "all", label: "All", channels: ["combat", "system", "say", "party", "whisper"] },
  { id: "combat", label: "Combat", channels: ["combat", "system"] },
  { id: "chat", label: "Chat", channels: ["say", "system", "party", "whisper"] },
];

const KEPT = 500;
const HISTORY = 50;
const FADE_AFTER_MS = 8000;
const MIN_LINES_PX = 60;

export interface ChatWindowOptions {
  parent: HTMLElement;
  /** A line was sent: a command (starting "/") or plain talk. */
  onSubmit: (line: string) => void;
  /** Candidates for the word being typed (see sim/chat/chat.ts `complete`). */
  complete: (line: string) => string[];
  /** Whether Enter may open the input now (not in a menu, a loading screen...). */
  canOpen: () => boolean;
  /** The input opened (true) or closed (false): the game releases held keys on open. */
  onTyping?: (typing: boolean) => void;
}

export interface ChatWindow {
  readonly root: HTMLElement;
  add: (channel: ChatChannel, text: string, from?: string) => void;
  clear: () => void;
  open: (prefill?: string) => void;
  readonly typing: boolean;
  dispose: () => void;
}

interface Line {
  channel: ChatChannel;
  text: string;
  from: string;
}

function el(tag: string, css: string, parent?: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  parent?.appendChild(e);
  return e;
}

/** Where the word being typed starts, with "quoted words" counted as one. */
export function fragmentStart(value: string): number {
  let quote = "";
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " ") start = i + 1;
  }
  return start;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and blocked storage: the window works without remembering.
  }
}

export function createChatWindow(options: ChatWindowOptions): ChatWindow {
  const root = el("div", `width: 100%; box-sizing: border-box; display: flex; flex-direction: column; ${QUIET_PANEL} transition: opacity 0.4s; color: #d8ceb6;`, options.parent);
  const grip = el("div", "height: 5px; flex: none; cursor: ns-resize; margin: -4px 0 1px; border-radius: 3px;", root);
  grip.title = "Drag to resize";
  const tabs = el("div", "display: flex; gap: 2px; flex: none; padding: 0 6px;", root);
  const area = el("div", `flex: none; overflow-y: auto; padding: 3px 8px 4px; white-space: pre-wrap; overflow-wrap: anywhere; height: ${load("chat.height", 120)}px; font: 11px/1.35 "Segoe UI", system-ui, sans-serif;`, root);
  const hint = el("div", `display: none; flex: none; padding: 2px 8px; color: ${DIM}; font-size: 10px; border-top: 1px solid rgba(122, 98, 53, 0.3);`, root);
  const inputRow = el("div", `display: none; flex: none; align-items: center; gap: 6px; padding: 3px 8px 4px; border-top: 1px solid ${BRONZE};`, root);
  const prefix = el("span", `color: ${GOLD}; font: 600 11px/1 ${TITLE_FONT};`, inputRow);
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 300;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.style.cssText = "flex: 1 1 auto; min-width: 0; background: rgba(0, 0, 0, 0.45); color: #fff; border: 1px solid #5d4a2a; border-radius: 3px; padding: 2px 5px; font: 12px/1.3 'Segoe UI', system-ui, sans-serif; outline: none;";
  inputRow.appendChild(input);

  const lines: Line[] = [];
  let tab = load("chat.tab", "all");
  if (!TABS.some((t) => t.id === tab)) tab = "all";
  let typing = false;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;
  const history: string[] = load("chat.history", []);
  let historyAt = -1;
  let draft = "";
  let completing: { base: string; start: number; options: string[]; at: number } | null = null;

  // --- Drawing ---
  const shown = (line: Line): boolean => TABS.find((t) => t.id === tab)!.channels.includes(line.channel);
  function row(line: Line): HTMLElement {
    const e = el("div", `color: ${COLOURS[line.channel]};`);
    if (line.channel === "say" && line.from) {
      el("span", `color: ${GOLD};`, e).textContent = `${line.from}: `;
    }
    e.appendChild(document.createTextNode(line.text));
    return e;
  }
  const atBottom = (): boolean => area.scrollHeight - area.scrollTop - area.clientHeight < 6;
  function redraw(): void {
    area.textContent = "";
    for (const line of lines) if (shown(line)) area.appendChild(row(line));
    area.scrollTop = area.scrollHeight;
  }
  function drawTabs(): void {
    tabs.textContent = "";
    for (const t of TABS) {
      const b = el("button", `all: unset; cursor: pointer; padding: 1px 8px; font: 600 10px/1.4 ${TITLE_FONT}; letter-spacing: 0.03em; border-radius: 3px 3px 0 0; color: ${t.id === tab ? GOLD : DIM}; background: ${t.id === tab ? "rgba(122, 98, 53, 0.35)" : "transparent"};`, tabs);
      b.textContent = t.label;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        tab = t.id;
        save("chat.tab", tab);
        drawTabs();
        redraw();
      });
    }
  }
  drawTabs();

  // --- Fade ---
  function wake(): void {
    root.style.opacity = "1";
    if (fadeTimer) clearTimeout(fadeTimer);
    if (typing) return;
    fadeTimer = setTimeout(() => (root.style.opacity = "0.4"), FADE_AFTER_MS);
  }
  root.addEventListener("pointerenter", wake);
  root.addEventListener("wheel", wake);
  wake();

  // --- Resizing: the grip drags the lines' height ---
  grip.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    const startY = down.clientY;
    const startHeight = area.offsetHeight;
    const move = (e: PointerEvent): void => {
      const max = Math.max(MIN_LINES_PX, window.innerHeight * 0.6);
      area.style.height = `${Math.round(Math.min(max, Math.max(MIN_LINES_PX, startHeight + startY - e.clientY)))}px`;
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      save("chat.height", area.offsetHeight);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // --- The input ---
  function open(prefill = ""): void {
    if (typing) return;
    typing = true;
    inputRow.style.display = "flex";
    prefix.textContent = "Say:";
    input.value = prefill;
    historyAt = -1;
    completing = null;
    options.onTyping?.(true);
    wake();
    input.focus();
    updatePrefix();
  }
  function close(): void {
    if (!typing) return;
    typing = false;
    inputRow.style.display = "none";
    hint.style.display = "none";
    input.blur();
    options.onTyping?.(false);
    wake();
  }
  function updatePrefix(): void {
    prefix.textContent = input.value.startsWith("/") ? "Cmd:" : "Say:";
  }
  function showHint(text: string): void {
    hint.textContent = text;
    hint.style.display = text ? "block" : "none";
  }
  function send(): void {
    const value = input.value.trim();
    if (value) {
      if (history[history.length - 1] !== value) history.push(value);
      if (history.length > HISTORY) history.splice(0, history.length - HISTORY);
      save("chat.history", history);
      options.onSubmit(value);
    }
    close();
  }
  function complete(): void {
    const value = input.value;
    if (completing && completing.options.length > 0 && value === completing.base + completing.options[completing.at]) {
      completing.at = (completing.at + 1) % completing.options.length;
      input.value = completing.base + completing.options[completing.at];
      return;
    }
    const found = options.complete(value);
    if (found.length === 0) return showHint("");
    const start = fragmentStart(value);
    const base = value.slice(0, start) + (start === 0 && value.startsWith("/") ? "/" : "");
    const quoted = found.map((c) => (/\s/.test(c) ? `"${c}"` : c));
    showHint(found.length > 1 ? found.slice(0, 12).join("  ") + (found.length > 12 ? " ..." : "") : "");
    completing = { base, start, options: quoted, at: 0 };
    input.value = base + quoted[0] + (found.length === 1 ? " " : "");
    if (found.length === 1) completing = null;
    updatePrefix();
  }

  input.addEventListener("keydown", (e) => {
    // Nothing typed here is the game's: its handlers listen on the window, above this.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      e.preventDefault();
      complete();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (history.length === 0) return;
      if (historyAt === -1) draft = input.value;
      historyAt = e.key === "ArrowUp" ? Math.min(history.length - 1, historyAt + 1) : historyAt - 1;
      input.value = historyAt < 0 ? draft : history[history.length - 1 - historyAt];
      if (historyAt < 0) historyAt = -1;
      updatePrefix();
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      area.scrollTop += (e.key === "PageUp" ? -1 : 1) * area.clientHeight * 0.8;
    }
  });
  input.addEventListener("keyup", (e) => e.stopPropagation());
  input.addEventListener("input", () => {
    completing = null;
    showHint("");
    updatePrefix();
  });
  input.addEventListener("blur", () => {
    // Clicking away closes it, keeping what was typed out of the way.
    if (typing) close();
  });

  const onKey = (e: KeyboardEvent): void => {
    if (typing || e.repeat || e.key !== "Enter" || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement) return;
    if (!options.canOpen()) return;
    e.preventDefault();
    open();
  };
  window.addEventListener("keydown", onKey);

  return {
    root,
    add(channel, text, from = "") {
      const line: Line = { channel, text, from };
      lines.push(line);
      if (lines.length > KEPT) lines.splice(0, lines.length - KEPT);
      if (shown(line)) {
        const stick = atBottom();
        area.appendChild(row(line));
        while (area.childElementCount > KEPT) area.firstElementChild?.remove();
        if (stick) area.scrollTop = area.scrollHeight;
      }
      if (channel !== "combat") wake();
    },
    clear() {
      lines.length = 0;
      redraw();
    },
    open,
    get typing() {
      return typing;
    },
    dispose() {
      window.removeEventListener("keydown", onKey);
      if (fadeTimer) clearTimeout(fadeTimer);
      root.remove();
    },
  };
}
