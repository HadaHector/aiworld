// The sound options (in the options window, ui/hud.ts): the music's volume and what is playing, the
// sound effects' volume and how much the screen shakes (FEEDBACK.md). All three are kept between visits.

export interface MusicControl {
  /** The music volume set, 0..1 (already eased: the slider's middle is not half the loudness). */
  volume: number;
  /** The effects volume set, 0..1, eased the same way. */
  effects: number;
  /** How much the screen shakes in the player's own fights, 0 (never) to 1. */
  shake: number;
  setStatus: (text: string) => void;
  /** Its element, for a HUD region to take (ui/hud.ts). */
  readonly element: HTMLElement;
}

const MUSIC_KEY = "aiworld.music.volume";
const EFFECTS_KEY = "aiworld.effects.volume";
const SHAKE_KEY = "aiworld.effects.shake";

const toVolume = (p: number): number => (p / 100) ** 2;

/** A name that mutes on a click and a slider, its setting kept under `key`. */
function volumeSlider(symbol: string, title: string, key: string, fallback: number, onVolume: (volume: number) => void): { elements: HTMLElement[]; volume: number } {
  let percent = fallback;
  try {
    const kept = Number(localStorage.getItem(key));
    if (localStorage.getItem(key) !== null && Number.isFinite(kept)) percent = Math.min(100, Math.max(0, kept));
  } catch {
    // No storage: the default.
  }
  const label = document.createElement("span");
  label.textContent = symbol;
  label.style.cssText = "cursor: pointer; white-space: nowrap;";
  label.title = `${title} - click to mute`;
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.value = String(percent);
  slider.style.cssText = "width: 100%; margin: 0;";
  slider.title = `${title} volume`;
  const set = (p: number): void => {
    percent = p;
    slider.value = String(p);
    label.style.opacity = p === 0 ? "0.4" : "1";
    onVolume(toVolume(p));
    try {
      localStorage.setItem(key, String(p));
    } catch {
      // No storage: kept for this visit.
    }
  };
  let beforeMute = percent || fallback;
  slider.addEventListener("input", () => set(Number(slider.value)));
  label.addEventListener("click", () => {
    if (percent > 0) {
      beforeMute = percent;
      set(0);
    } else {
      set(beforeMute);
    }
  });
  // Keys pressed on the slider are the slider's, not the player's.
  slider.addEventListener("keydown", (e) => e.stopPropagation());
  label.style.opacity = percent === 0 ? "0.4" : "1";
  return { elements: [label, slider], volume: toVolume(percent) };
}

export function createMusicControl(onVolume: (volume: number) => void, onEffects: (volume: number) => void = () => {}, onShake: (shake: number) => void = () => {}): MusicControl {
  const container = document.createElement("div");
  container.style.cssText = `
    display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 4px 8px; width: 100%; box-sizing: border-box;
    background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;
    padding: 6px 10px; font-family: sans-serif; font-size: 11px; color: #eee; white-space: nowrap;
  `;
  const music = volumeSlider("Music", "Music", MUSIC_KEY, 60, (v) => {
    control.volume = v;
    onVolume(v);
  });
  const status = document.createElement("span");
  status.style.cssText = "color: #aab; min-width: 60px; font-size: 10px;";
  const effects = volumeSlider("Effects", "Effects", EFFECTS_KEY, 70, (v) => {
    control.effects = v;
    onEffects(v);
  });
  const shake = volumeSlider("Screen shake", "Screen shake", SHAKE_KEY, 100, (v) => {
    control.shake = v;
    onShake(v);
  });
  const blank = (): HTMLElement => document.createElement("span");
  container.append(...music.elements, status, ...effects.elements, blank(), ...shake.elements, blank());
  document.body.appendChild(container);

  const control: MusicControl = { volume: music.volume, effects: effects.volume, shake: shake.volume, setStatus, element: container };
  let lastStatus = "";
  function setStatus(text: string): void {
    if (text === lastStatus) return;
    lastStatus = text;
    status.textContent = text;
  }
  return control;
}
