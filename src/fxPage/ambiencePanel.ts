// The ambience tab of the fx page (see MUSIC.md, *Ambience*): the surroundings the game would feed
// the ambience, as presets and sliders, so each place can be listened to. The sliders are the
// `AmbienceState` itself; the readout is the layer levels it makes. Each loop with a recording can
// be switched between it and its synthesized voice.

import { createAmbience, type Ambience } from "../audio/ambience";
import { ambienceMix, SEA_REACH, WATER_REACH, type AmbienceState } from "../audio/ambienceMix";
import type { AmbienceRecordings } from "../audio/ambienceRecordings";

const BASE: AmbienceState = { wind: 1, rain: 0, snow: 0, hour: 12, underground: 0, hollow: null, indoors: false, waterDistance: Infinity, seaDistance: Infinity, life: 1 };

/** The places to listen to, as the game would see them. */
export const AMBIENCE_PRESETS: Record<string, AmbienceState> = {
  "wood, day": BASE,
  "wood, dusk": { ...BASE, hour: 19.5 },
  "wood, night": { ...BASE, hour: 1 },
  "wood, breezy": { ...BASE, wind: 1.8 },
  "wood, gale": { ...BASE, wind: 3 },
  "wood, drizzle": { ...BASE, wind: 0.8, rain: 0.25 },
  "wood, rain": { ...BASE, wind: 1.4, rain: 0.8 },
  "wood, storm": { ...BASE, wind: 3, rain: 1 },
  "by the river": { ...BASE, waterDistance: 4 },
  "on the shore": { ...BASE, seaDistance: 8, life: 0.4 },
  "sea in the distance": { ...BASE, seaDistance: 60, life: 0.6 },
  "river in the distance": { ...BASE, waterDistance: 28 },
  "river in rain": { ...BASE, wind: 1.4, rain: 0.8, waterDistance: 4 },
  "indoors, calm": { ...BASE, indoors: true },
  "indoors, rain": { ...BASE, wind: 1.4, rain: 0.8, indoors: true },
  "cave": { ...BASE, underground: 1, hollow: "cave" },
  "crypt": { ...BASE, underground: 1, hollow: "crypt" },
  "bare ground, day": { ...BASE, life: 0.1 },
};

export interface AmbienceTab {
  /** Fills the detail pane. */
  show: (detail: HTMLElement) => void;
  /** Picks a preset by name (the list's click). */
  pick: (name: string) => void;
  /** Each frame: feeds the ambience the state, while it plays. */
  frame: (ambience: Ambience | null) => void;
  /** Silences it (the page's Stop all). */
  stop: () => void;
  /** Whether it plays. */
  readonly playing: boolean;
}

/**
 * Renders a place's ambience offline and measures it: RMS and peak over `seconds` after a fade-in
 * (`settle`), the state fed four times a second as the game does. For the levels in MUSIC.md, and
 * `__fxAmbience.measureAmbience` (scripts/tools/ambienceLevels.mjs). `recorded: false` hears the
 * synthesized voices alone.
 */
export async function measureAmbience(recordings: AmbienceRecordings, url: (path: string) => string, state: AmbienceState, options: { seconds?: number; settle?: number; recorded?: boolean } = {}): Promise<{ rms: number; peak: number; layers: string }> {
  const rate = 44100;
  const settle = options.settle ?? 6;
  const seconds = options.seconds ?? 20;
  const ctx = new OfflineAudioContext(2, Math.ceil((settle + seconds) * rate), rate);
  const ambience = createAmbience(ctx, ctx.destination, options.recorded === false ? { loops: {}, oneShots: {} } : recordings, url);
  await ambience.ready();
  for (let t = 0; t < settle + seconds; t += 0.25) {
    void ctx.suspend(t).then(() => {
      ambience.update(state);
      void ctx.resume();
    });
  }
  const out = await ctx.startRendering();
  let sum = 0, peak = 0, n = 0;
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = Math.floor(settle * rate); i < d.length; i++) {
      sum += d[i] * d[i];
      peak = Math.max(peak, Math.abs(d[i]));
      n++;
    }
  }
  const layers = ambience.layers().map((l) => `${l.id}:${l.playing}`).join(" ");
  ambience.dispose();
  return { rms: Math.sqrt(sum / Math.max(1, n)), peak, layers };
}

export function createAmbienceTab(): AmbienceTab {
  const state: AmbienceState = { ...BASE };
  let playing = false;
  let redraw: (() => void) | null = null;
  /** The page's ambience, as the last frame had it, for the layers' switches. */
  let current: Ambience | null = null;
  let drawLayers: (() => void) | null = null;
  let layersAt = 0;
  let layersSeen = "";

  const sliders: { key: keyof AmbienceState; label: string; min: number; max: number; step: number }[] = [
    { key: "wind", label: "Wind", min: 0.3, max: 3.5, step: 0.05 },
    { key: "rain", label: "Rain", min: 0, max: 1, step: 0.05 },
    { key: "snow", label: "Snow", min: 0, max: 1, step: 0.05 },
    { key: "hour", label: "Hour", min: 0, max: 24, step: 0.25 },
    { key: "underground", label: "Underground", min: 0, max: 1, step: 0.05 },
    { key: "waterDistance", label: "Water at (m)", min: 0, max: WATER_REACH + 6, step: 1 },
    { key: "seaDistance", label: "Sea at (m)", min: 0, max: SEA_REACH + 6, step: 1 },
    { key: "life", label: "Life", min: 0, max: 1, step: 0.05 },
  ];

  function show(detail: HTMLElement): void {
    detail.innerHTML = "";
    const bar = document.createElement("div");
    bar.className = "row";
    const play = document.createElement("button");
    play.textContent = playing ? "■ Silence" : "▶ Play";
    play.className = playing ? "on" : "";
    play.onclick = () => {
      playing = !playing;
      show(detail);
    };
    bar.append(play);
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "Pick a place on the left, or move the sliders; the layers fade over about two seconds. Volume is the page's.";
    bar.append(hint);
    detail.append(bar);

    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:130px 1fr 60px;gap:4px 10px;align-items:center;max-width:560px;margin:8px 0";
    const outputs: (() => void)[] = [];
    for (const s of sliders) {
      const label = document.createElement("span");
      label.textContent = s.label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step);
      const out = document.createElement("output");
      const read = (): void => {
        const v = state[s.key] as number;
        const reach = s.key === "seaDistance" ? SEA_REACH : WATER_REACH;
        const far = s.key === "waterDistance" || s.key === "seaDistance";
        const shown = far ? (v >= reach ? s.max : v) : v;
        input.value = String(shown);
        out.textContent = far && v >= reach ? "none" : String(Math.round(shown * 100) / 100);
      };
      input.oninput = () => {
        const v = Number(input.value);
        (state[s.key] as number) = (s.key === "waterDistance" && v >= WATER_REACH) || (s.key === "seaDistance" && v >= SEA_REACH) ? Infinity : v;
        redraw?.();
      };
      outputs.push(read);
      grid.append(label, input, out);
    }
    const toggle = (text: string, get: () => boolean, set: (v: boolean) => void): HTMLLabelElement => {
      const l = document.createElement("label");
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = get();
      c.onchange = () => {
        set(c.checked);
        redraw?.();
      };
      l.append(c, ` ${text}`);
      return l;
    };
    const kind = document.createElement("select");
    for (const k of ["cave", "crypt"]) kind.append(Object.assign(document.createElement("option"), { value: k, textContent: k }));
    kind.value = state.hollow ?? "cave";
    kind.onchange = () => {
      state.hollow = kind.value as "cave" | "crypt";
      redraw?.();
    };
    const extras = document.createElement("div");
    extras.className = "row";
    extras.append(toggle("Indoors", () => state.indoors, (v) => (state.indoors = v)), "Underground is a", kind);
    const readout = document.createElement("div");
    readout.className = "layer";
    redraw = () => {
      for (const read of outputs) read();
      const mix = ambienceMix({ ...state, hollow: state.underground > 0 ? (state.hollow ?? "cave") : null });
      readout.textContent = Object.entries(mix)
        .map(([k, v]) => `${k.padEnd(16)}${(v as number).toFixed(2)}`)
        .join("\n");
    };
    // Each loop: what it plays now, and a switch between its recording and its synthesized voice.
    const layerBox = document.createElement("div");
    layerBox.style.cssText = "display:grid;grid-template-columns:110px 70px 1fr;gap:2px 10px;align-items:center;max-width:560px;margin:10px 0";
    drawLayers = () => {
      layerBox.innerHTML = "";
      const list = current?.layers();
      if (!list) {
        layerBox.textContent = "Press Play to load the recordings.";
        return;
      }
      for (const l of list) {
        const name = document.createElement("span");
        name.textContent = l.id;
        const box = document.createElement("label");
        const c = document.createElement("input");
        c.type = "checkbox";
        c.checked = l.recorded;
        c.disabled = !l.file || l.load !== "loaded";
        c.onchange = () => {
          current?.setRecorded(l.id, c.checked);
          drawLayers?.();
        };
        box.append(c, " rec");
        const what = document.createElement("span");
        what.className = "hint";
        what.textContent = `${l.playing}${l.file ? ` - ${l.file.split("/").pop()} (${l.load})` : ""}`;
        layerBox.append(name, box, what);
      }
    };
    detail.append(grid, extras, readout, layerBox);
    redraw();
    drawLayers();
  }

  return {
    show,
    pick(name) {
      const preset = AMBIENCE_PRESETS[name];
      if (!preset) return;
      Object.assign(state, preset);
      playing = true;
    },
    frame(ambience) {
      if (!ambience) return;
      // (Its loads settle a moment after it is made: the switches drawn again as they do.)
      if (current !== ambience || performance.now() - layersAt > 500) {
        current = ambience;
        layersAt = performance.now();
        const seen = JSON.stringify(ambience.layers());
        if (seen !== layersSeen) {
          layersSeen = seen;
          drawLayers?.();
        }
      }
      ambience.update({ ...state, hollow: state.underground > 0 ? (state.hollow ?? "cave") : null });
      ambience.setMuted(!playing);
    },
    stop() {
      playing = false;
    },
    get playing() {
      return playing;
    },
  };
}
