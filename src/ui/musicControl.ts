// A small music control in the corner: the volume, and what is playing. The volume is kept between
// visits.

export interface MusicControl {
  /** The volume set, 0..1 (already eased: the slider's middle is not half the loudness). */
  volume: number;
  setStatus: (text: string) => void;
}

const KEY = "aiworld.music.volume";

export function createMusicControl(onVolume: (volume: number) => void): MusicControl {
  let percent = 60;
  try {
    const kept = Number(localStorage.getItem(KEY));
    if (localStorage.getItem(KEY) !== null && Number.isFinite(kept)) percent = Math.min(100, Math.max(0, kept));
  } catch {
    // No storage: the default.
  }
  const toVolume = (p: number): number => (p / 100) ** 2;

  const container = document.createElement("div");
  container.style.cssText = `
    position: fixed; bottom: 16px; right: 16px; z-index: 900;
    display: flex; align-items: center; gap: 8px;
    background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;
    padding: 6px 10px; font-family: sans-serif; font-size: 11px; color: #eee; white-space: nowrap;
  `;
  const label = document.createElement("span");
  label.textContent = "♪";
  label.style.cssText = "font-size: 13px; cursor: pointer;";
  label.title = "Music - click to mute";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.value = String(percent);
  slider.style.cssText = "width: 90px; margin: 0;";
  slider.title = "Music volume";
  const status = document.createElement("span");
  status.style.cssText = "color: #aab; min-width: 70px;";
  container.append(label, slider, status);
  document.body.appendChild(container);

  const control: MusicControl = { volume: toVolume(percent), setStatus };
  let lastStatus = "";
  function setStatus(text: string): void {
    if (text === lastStatus) return;
    lastStatus = text;
    status.textContent = text;
  }
  const set = (p: number): void => {
    percent = p;
    slider.value = String(p);
    control.volume = toVolume(p);
    label.style.opacity = p === 0 ? "0.4" : "1";
    onVolume(control.volume);
    try {
      localStorage.setItem(KEY, String(p));
    } catch {
      // No storage: kept for this visit.
    }
  };
  let beforeMute = percent || 60;
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
  return control;
}
