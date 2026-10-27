// Playing sound effects (see FEEDBACK.md, *Sounds*): a take picked per play, pitch and volume
// varied, placed in the world through a panner with the camera as listener, under a bus and a
// voice limit. A sound's synth layers are rendered the first time it is needed (and ahead of time,
// a little at a time); sample layers are fetched and, once one has loaded, its stand-ins drop out.

import type { Bus, FeedbackRules, SoundDef } from "../feedback/rules";
import { renderSynth, type RenderedSound } from "./synth";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayOptions {
  /** Where in the world; left out, or for a `flat` sound, it is not placed. */
  at?: Vec3 | null;
  /** A factor on the sound's volume: the event's, others' fights quieter. */
  gain?: number;
  /** Outranks other sounds for the voice limit: the player's own fight. */
  own?: boolean;
  /** Semitones over the sound's own variation. */
  pitch?: number;
}

/** A sound playing: a looping one plays until stopped. */
export interface SoundHandle {
  readonly sound: string;
  readonly playing: boolean;
  /** Moves it (a projectile's roar, a cast at hands that move). */
  move: (at: Vec3) => void;
  /** Stops it, fading over `fade` seconds. */
  stop: (fade?: number) => void;
}

export interface Sfx {
  readonly ctx: AudioContext;
  play: (sound: string, options?: PlayOptions) => SoundHandle | null;
  /** Where the listener is and which way it faces (forward and up need not be unit length). */
  setListener: (at: Vec3, forward: Vec3, up: Vec3) => void;
  /** 0..1, the player's Effects volume. */
  setVolume: (volume: number) => void;
  /** Renders every sound's takes ahead of need, one take per task. */
  prewarm: () => void;
  /** Voices playing now, for the meters. */
  voices: () => number;
  /** A sound's rendered takes - for the dev page's waveform; renders them if they are not yet. */
  takes: (sound: string) => RenderedSound[];
  stopAll: () => void;
  dispose: () => void;
}

interface Voice {
  sound: SoundDef;
  sources: AudioBufferSourceNode[];
  gain: GainNode;
  panner: PannerNode | null;
  filter: BiquadFilterNode | null;
  at: Vec3 | null;
  level: number;
  own: boolean;
  started: number;
  stopped: boolean;
}

/** A sound's synth layers, rendered: every take with every layer, and with the stand-ins left out. */
interface Rendered {
  all: AudioBuffer[];
  kept: AudioBuffer[];
  /** What the dev page shows. */
  raw: RenderedSound[];
}

/** Seconds a stopped or stolen voice fades over, so nothing clicks. */
const QUICK_FADE = 0.03;

/**
 * Builds the sound effects player on the page's audio. `output` is the effects bus
 * (src/audio/context.ts). `sampleUrl` says where a sample layer's file is, from the sound's pack.
 */
export function createSfx(ctx: AudioContext, output: AudioNode, rules: FeedbackRules, sampleUrl: (sound: SoundDef, file: string) => string): Sfx {
  const volume = ctx.createGain();
  volume.connect(output);
  const master = ctx.createGain();
  master.gain.value = rules.config.mix.master;
  master.connect(volume);
  const buses = new Map<Bus, GainNode>();
  for (const bus of ["combat", "footsteps", "ui", "ambient"] as const) {
    const gain = ctx.createGain();
    gain.gain.value = rules.config.mix[bus];
    gain.connect(master);
    buses.set(bus, gain);
  }

  const rendered = new Map<string, Rendered>();
  const samples = new Map<string, AudioBuffer[]>();
  const loading = new Set<string>();
  const voices: Voice[] = [];
  const listener: Vec3 = { x: 0, y: 0, z: 0 };

  const toBuffer = (take: RenderedSound): AudioBuffer => {
    const buffer = ctx.createBuffer(1, take.data.length, take.sampleRate);
    buffer.getChannelData(0).set(take.data);
    return buffer;
  };
  /** The sound's synth takes, rendered now if they were not. */
  const renderedOf = (sound: SoundDef): Rendered | null => {
    let r = rendered.get(sound.id);
    if (r) return r;
    const all = sound.layers.flatMap((l) => (l.synth ? [{ ...l.synth, gain: l.synth.gain * l.gain }] : []));
    const kept = sound.layers.flatMap((l) => (l.synth && !l.standIn ? [{ ...l.synth, gain: l.synth.gain * l.gain }] : []));
    if (all.length === 0) return null;
    const raw: RenderedSound[] = [];
    const allBuffers: AudioBuffer[] = [];
    const keptBuffers: AudioBuffer[] = [];
    for (let take = 0; take < sound.takes; take++) {
      const seed = seedOf(sound.id, take);
      const one = renderSynth(all, seed, sound.loop);
      raw.push(one);
      allBuffers.push(toBuffer(one));
      if (kept.length > 0) keptBuffers.push(kept.length === all.length ? allBuffers[take] : toBuffer(renderSynth(kept, seed, sound.loop)));
    }
    r = { all: allBuffers, kept: keptBuffers, raw };
    rendered.set(sound.id, r);
    return r;
  };
  /** Starts fetching a sound's sample files; plays go on with its synth layers until they are in. */
  const loadSamples = (sound: SoundDef): void => {
    if (loading.has(sound.id)) return;
    loading.add(sound.id);
    sound.layers.forEach((layer, i) => {
      if (!layer.samples) return;
      void Promise.all(
        layer.samples.map((file) =>
          fetch(sampleUrl(sound, file))
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
            .then((data) => ctx.decodeAudioData(data))
            .catch((error) => {
              console.warn(`Sound "${sound.id}": could not load ${file} (${String(error)})`);
              return null;
            }),
        ),
      ).then((buffers) => {
        const loaded = buffers.filter((b): b is AudioBuffer => b !== null);
        if (loaded.length > 0) samples.set(`${sound.id}#${i}`, loaded);
      });
    });
  };

  const removeVoice = (voice: Voice): void => {
    const i = voices.indexOf(voice);
    if (i >= 0) voices.splice(i, 1);
  };
  const stopVoice = (voice: Voice, fade: number): void => {
    if (voice.stopped) return;
    voice.stopped = true;
    const now = ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + Math.max(QUICK_FADE, fade));
    for (const source of voice.sources) source.stop(now + Math.max(QUICK_FADE, fade) + 0.01);
    removeVoice(voice);
  };
  /** How loud a voice is at the listener, roughly: for choosing which to drop. */
  const loudness = (sound: SoundDef, at: Vec3 | null, level: number, own: boolean): number => {
    if (!at || sound.flat) return level * (own ? 2 : 1);
    const d = Math.hypot(at.x - listener.x, at.y - listener.y, at.z - listener.z);
    const fall = d <= sound.near ? 1 : Math.max(0, 1 - (d - sound.near) / (sound.far - sound.near));
    return level * fall * (own ? 2 : 1);
  };
  /** Babylon's world is left-handed and WebAudio's right-handed: z flips between them. */
  const place = (panner: PannerNode, at: Vec3): void => {
    const t = ctx.currentTime;
    panner.positionX.setTargetAtTime(at.x, t, 0.02);
    panner.positionY.setTargetAtTime(at.y, t, 0.02);
    panner.positionZ.setTargetAtTime(-at.z, t, 0.02);
  };
  /** Distance takes the top off, a little: far sounds are duller as well as quieter. */
  const dullness = (sound: SoundDef, at: Vec3): number => {
    const d = Math.hypot(at.x - listener.x, at.y - listener.y, at.z - listener.z);
    const t = Math.min(1, Math.max(0, (d - sound.near) / (sound.far - sound.near)));
    return 18000 * Math.pow(1 - t * 0.85, 2.5) + 600;
  };

  const sfx: Sfx = {
    ctx,
    play(id, options = {}) {
      const sound = rules.sounds.get(id);
      if (!sound || ctx.state !== "running") return null;
      const at = sound.flat ? null : (options.at ?? null);
      const level = (options.gain ?? 1) * (sound.volume[0] + Math.random() * (sound.volume[1] - sound.volume[0]));
      const own = options.own ?? false;
      const heard = loudness(sound, at, level, own);
      if (heard <= 0.001) return null;

      // This sound's own limit: its oldest gives way.
      const same = voices.filter((v) => v.sound === sound);
      if (same.length >= sound.maxVoices) stopVoice(same[0], QUICK_FADE);
      // The overall limit: the quietest gives way, unless the new one is quieter still.
      if (voices.length >= rules.config.voices) {
        let quietest = voices[0];
        let least = Infinity;
        for (const v of voices) {
          const l = loudness(v.sound, v.at, v.level, v.own);
          if (l < least) {
            least = l;
            quietest = v;
          }
        }
        if (heard < least) return null;
        stopVoice(quietest, QUICK_FADE);
      }

      if (sound.layers.some((l) => l.samples)) loadSamples(sound);
      const sampled = sound.layers.map((l, i) => (l.samples ? samples.get(`${sound.id}#${i}`) : undefined));
      const anySample = sampled.some((s) => s && s.length > 0);
      const synth = renderedOf(sound);
      const takes = synth ? (anySample ? synth.kept : synth.all) : [];

      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.value = level;
      let into: AudioNode = buses.get(sound.bus)!;
      let panner: PannerNode | null = null;
      let filter: BiquadFilterNode | null = null;
      if (at) {
        panner = ctx.createPanner();
        panner.panningModel = "equalpower";
        panner.distanceModel = "linear";
        panner.refDistance = sound.near;
        panner.maxDistance = sound.far;
        panner.rolloffFactor = 1;
        panner.positionX.value = at.x;
        panner.positionY.value = at.y;
        panner.positionZ.value = -at.z;
        panner.connect(into);
        filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = dullness(sound, at);
        filter.connect(panner);
        into = filter;
      }
      gain.connect(into);
      const rate = Math.pow(2, (sound.pitch[0] + Math.random() * (sound.pitch[1] - sound.pitch[0]) + (options.pitch ?? 0)) / 12);
      const sources: AudioBufferSourceNode[] = [];
      const start = (buffer: AudioBuffer, layerGain: number, loop?: { start: number; end: number }): void => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        if (loop) {
          source.loop = true;
          source.loopStart = loop.start;
          source.loopEnd = loop.end;
        } else if (sound.loop > 0) source.loop = true;
        let node: AudioNode = source;
        if (layerGain !== 1) {
          const g = ctx.createGain();
          g.gain.value = layerGain;
          source.connect(g);
          node = g;
        }
        node.connect(gain);
        source.start(now);
        sources.push(source);
      };
      if (takes.length > 0 && synth) {
        const take = Math.floor(Math.random() * takes.length);
        start(takes[take], 1, synth.raw[take].loop);
      }
      sound.layers.forEach((layer, i) => {
        const files = sampled[i];
        if (layer.samples && files && files.length > 0) start(files[Math.floor(Math.random() * files.length)], layer.gain);
      });
      if (sources.length === 0) {
        gain.disconnect();
        return null;
      }

      const voice: Voice = { sound, sources, gain, panner, filter, at: at ? { ...at } : null, level, own, started: now, stopped: false };
      voices.push(voice);
      // A one-shot leaves the list when its longest source ends.
      if (sound.loop === 0) {
        let left = sources.length;
        for (const source of sources) {
          source.onended = () => {
            if (--left === 0) {
              voice.stopped = true;
              removeVoice(voice);
              gain.disconnect();
              panner?.disconnect();
              filter?.disconnect();
            }
          };
        }
      }
      return {
        sound: sound.id,
        get playing() {
          return !voice.stopped;
        },
        move(to) {
          if (voice.stopped || !voice.panner || !voice.at) return;
          voice.at = { ...to };
          place(voice.panner, to);
          voice.filter?.frequency.setTargetAtTime(dullness(sound, to), ctx.currentTime, 0.05);
        },
        stop(fade = QUICK_FADE) {
          stopVoice(voice, fade);
        },
      };
    },
    setListener(at, forward, up) {
      listener.x = at.x;
      listener.y = at.y;
      listener.z = at.z;
      const l = ctx.listener;
      const t = ctx.currentTime;
      l.positionX.setTargetAtTime(at.x, t, 0.02);
      l.positionY.setTargetAtTime(at.y, t, 0.02);
      l.positionZ.setTargetAtTime(-at.z, t, 0.02);
      l.forwardX.setTargetAtTime(forward.x, t, 0.02);
      l.forwardY.setTargetAtTime(forward.y, t, 0.02);
      l.forwardZ.setTargetAtTime(-forward.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(-up.z, t, 0.02);
    },
    setVolume(v) {
      volume.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
    },
    prewarm() {
      const queue = [...rules.sounds.values()].filter((s) => !rendered.has(s.id));
      const next = (): void => {
        const sound = queue.shift();
        if (!sound) return;
        if (!rendered.has(sound.id)) renderedOf(sound);
        setTimeout(next, 0);
      };
      setTimeout(next, 0);
    },
    voices: () => voices.length,
    takes(id) {
      const sound = rules.sounds.get(id);
      return sound ? (renderedOf(sound)?.raw ?? []) : [];
    },
    stopAll() {
      for (const voice of [...voices]) stopVoice(voice, 0.1);
    },
    dispose() {
      sfx.stopAll();
      volume.disconnect();
    },
  };
  return sfx;
}

/** A take's seed from the sound's id: the same takes on every load. */
function seedOf(id: string, take: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (Math.imul(h ^ (take + 1), 2654435761) >>> 0) || 1;
}
