// The player: plays a song's patterns exactly as written, in WebAudio. It schedules a little ahead
// of the audio clock, one row at a time; every tick of a row becomes automation on the playing
// voice's gain and detune. It knows nothing about music theory. See MUSIC.md.

import { zoneFor, type Instrument, type SampleZone } from "./instruments";
import { tickSeconds, type Cell, type Effect, type Song } from "./song";

/** How far ahead of the audio clock rows are scheduled. Long, so a throttled background tab keeps up. */
const LOOKAHEAD = 1.5;
/** After the last row: time for releases and reverb to die away before the song counts as ended. */
const TAIL = 4;

interface Voice {
  source: AudioBufferSourceNode;
  envelope: GainNode;
  /** The release: 1 until the note is let go, then down to 0. */
  fade: GainNode;
  volume: GainNode;
  vibrato?: OscillatorNode;
  instrument: Instrument;
  root: number;
  start: number;
  stopped: boolean;
}

interface ChannelState {
  voice?: Voice;
  instrument?: Instrument;
  volume: number;
  /** Semitones, slides included. */
  pitch: number;
  /** Tone portamento target. */
  target?: number;
  /** Pitch offset the last tick left (vibrato, arpeggio), to clear when the effect stops. */
  offset: number;
  vibratoPhase: number;
}

interface ChannelOut {
  input: GainNode;
  pan: StereoPannerNode;
  send: GainNode;
}

export interface PlayPosition {
  pattern: number;
  row: number;
}

export class Player {
  readonly ctx: AudioContext;
  private readonly instruments: Record<string, Instrument>;
  private readonly master: GainNode;
  private readonly reverb: ConvolverNode;
  private readonly buffers = new WeakMap<Float32Array, AudioBuffer>();
  private readonly voices = new Set<Voice>();
  private outs: ChannelOut[] = [];
  private preview?: ChannelOut;
  private song?: Song;
  private states: ChannelState[] = [];
  private patternIndex = 0;
  private row = 0;
  private nextRowTime = 0;
  private endTime = Infinity;
  private timer?: number;
  private timeline: { time: number; position: PlayPosition }[] = [];
  private gains: number[] = [];
  /** Called once a song has played out, tail included - not when stopped. */
  onEnd?: () => void;

  constructor(ctx: AudioContext, instruments: Record<string, Instrument>) {
    this.ctx = ctx;
    this.instruments = instruments;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.ratio.value = 8;
    limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 2;
    this.master.connect(limiter);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulseResponse(ctx, 3.2);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.7;
    this.reverb.connect(reverbReturn).connect(limiter);
  }

  get playing(): boolean {
    return this.song !== undefined;
  }

  play(song: Song): void {
    this.stop();
    this.song = song;
    this.outs = song.channels.map((c, i) => this.createOut(c.pan, c.reverb, this.gains[i] ?? 1));
    this.states = song.channels.map(() => ({ volume: 1, pitch: 0, offset: 0, vibratoPhase: 0 }));
    this.patternIndex = 0;
    this.row = 0;
    this.nextRowTime = this.ctx.currentTime + 0.1;
    this.endTime = Infinity;
    this.timeline = [];
    this.timer = window.setInterval(() => this.schedule(), 50);
    this.schedule();
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
    const now = this.ctx.currentTime;
    for (const voice of this.voices) this.release(voice, now, 0.05);
    for (const out of this.outs) {
      out.input.gain.setTargetAtTime(0, now, 0.02);
      window.setTimeout(() => out.pan.disconnect(), 500);
    }
    this.outs = [];
    this.song = undefined;
    this.timeline = [];
  }

  /** Mute (0) or play (1) a channel; kept across songs. */
  setChannelGain(channel: number, gain: number): void {
    this.gains[channel] = gain;
    this.outs[channel]?.input.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  /** Where the song is at the audio clock now. */
  position(): PlayPosition | undefined {
    const now = this.ctx.currentTime;
    let found: PlayPosition | undefined;
    for (const entry of this.timeline) {
      if (entry.time > now) break;
      found = entry.position;
    }
    return found;
  }

  /** Plays one note of an instrument outside any song, released after `hold` seconds. */
  audition(instrumentId: string, note: number, hold = 0.8, volume = 0.8): void {
    const instrument = this.instruments[instrumentId];
    if (!instrument) return;
    this.preview ??= this.createOut(0, 0.3, 1);
    const t = this.ctx.currentTime + 0.02;
    const voice = this.startVoice(this.preview, instrument, note, volume, t);
    this.release(voice, t + hold);
  }

  // -------------------------------------------------------------------------------------------

  private createOut(pan: number, reverb: number, gain: number): ChannelOut {
    const input = this.ctx.createGain();
    input.gain.value = gain;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    const send = this.ctx.createGain();
    send.gain.value = reverb;
    input.connect(panner);
    panner.connect(this.master);
    panner.connect(send).connect(this.reverb);
    return { input, pan: panner, send };
  }

  private schedule(): void {
    const song = this.song;
    if (!song) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    const tick = tickSeconds(song);
    while (this.endTime === Infinity && this.nextRowTime < horizon) {
      const pattern = song.patterns[this.patternIndex];
      const t0 = this.nextRowTime;
      pattern.cells[this.row].forEach((cell, channel) => this.playCell(channel, cell, t0, tick, song.ticksPerRow));
      this.timeline.push({ time: t0, position: { pattern: this.patternIndex, row: this.row } });
      this.nextRowTime += tick * song.ticksPerRow;
      if (++this.row >= pattern.rows) {
        this.row = 0;
        if (++this.patternIndex >= song.patterns.length) {
          this.endTime = this.nextRowTime;
          // Anything still sounding at the end is let go.
          this.states.forEach((s) => s.voice && this.release(s.voice, this.endTime));
        }
      }
    }
    const now = this.ctx.currentTime;
    while (this.timeline.length > 1 && this.timeline[1].time < now - 1) this.timeline.shift();
    if (now > this.endTime + TAIL) {
      this.stop();
      this.onEnd?.();
    }
  }

  private playCell(channel: number, cell: Cell | undefined, t0: number, tick: number, ticksPerRow: number): void {
    const state = this.states[channel];
    const out = this.outs[channel];
    const effects = cell?.effects ?? [];
    const effect = <T extends Effect["type"]>(type: T): Extract<Effect, { type: T }> | undefined =>
      effects.find((e) => e.type === type) as Extract<Effect, { type: T }> | undefined;
    const delay = Math.min(ticksPerRow - 1, effect("noteDelay")?.ticks ?? 0);
    const tNote = t0 + delay * tick;

    if (cell?.instrument) state.instrument = this.instruments[cell.instrument];
    let started = false;
    if (cell?.note === "off") {
      if (state.voice) this.release(state.voice, tNote);
      state.voice = undefined;
    } else if (typeof cell?.note === "number") {
      const porta = effect("tonePortamento");
      if (porta && state.voice) {
        state.target = cell.note;
      } else if (state.instrument) {
        if (state.voice) this.release(state.voice, tNote);
        if (cell.volume !== undefined) state.volume = cell.volume;
        state.pitch = cell.note;
        state.target = undefined;
        state.offset = 0;
        state.vibratoPhase = 0;
        state.voice = this.startVoice(out, state.instrument, cell.note, state.volume, tNote, effect("slideIn"), tick);
        started = true;
      }
    }
    const voice = state.voice;
    if (cell?.volume !== undefined && !started) {
      state.volume = cell.volume;
      if (voice) voice.volume.gain.linearRampToValueAtTime(state.volume * voice.instrument.gain, tNote + 0.01);
    }
    if (!voice) return;

    const slide = effect("volumeSlide");
    const portamento = effect("portamento");
    const tonePorta = effect("tonePortamento");
    const vibrato = effect("vibrato");
    const arpeggio = effect("arpeggio");
    const cut = effect("noteCut");
    const retrigger = effect("retrigger");
    const movesPitch = portamento || (tonePorta && state.target !== undefined) || vibrato || arpeggio;
    if (!movesPitch && state.offset !== 0) {
      state.offset = 0;
      voice.source.detune.setValueAtTime(cents(state.pitch, voice), t0);
    }
    if (!slide && !movesPitch && !cut && !retrigger) return;

    let current = voice;
    for (let k = delay; k < ticksPerRow; k++) {
      const t = t0 + k * tick;
      if (slide && k > 0) {
        state.volume = Math.min(1, Math.max(0, state.volume + slide.perTick));
        current.volume.gain.linearRampToValueAtTime(state.volume * current.instrument.gain, t);
      }
      if (cut && k === cut.ticks) {
        state.volume = 0;
        current.volume.gain.linearRampToValueAtTime(0, t + 0.005);
      }
      if (retrigger && k > delay && (k - delay) % retrigger.every === 0) {
        state.volume *= retrigger.volumeFactor;
        this.release(current, t, 0.03);
        current = this.startVoice(out, current.instrument, state.pitch, state.volume, t);
        state.voice = current;
      }
      if (!movesPitch) continue;
      if (portamento && k > 0) state.pitch += portamento.perTick;
      if (tonePorta && state.target !== undefined && k > 0) {
        const diff = state.target - state.pitch;
        state.pitch = Math.abs(diff) <= tonePorta.perTick ? state.target : state.pitch + Math.sign(diff) * tonePorta.perTick;
      }
      let offset = 0;
      if (vibrato) {
        offset = vibrato.depth * Math.sin(2 * Math.PI * state.vibratoPhase);
        state.vibratoPhase += vibrato.rate * tick;
      }
      if (arpeggio) offset = [0, arpeggio.x, arpeggio.y][k % 3];
      state.offset = offset;
      const value = cents(state.pitch + offset, current);
      if (arpeggio) current.source.detune.setValueAtTime(value, t);
      else current.source.detune.linearRampToValueAtTime(value, t);
    }
  }

  private startVoice(
    out: ChannelOut,
    instrument: Instrument,
    note: number,
    volume: number,
    t: number,
    slideIn?: Extract<Effect, { type: "slideIn" }>,
    tick = 0,
  ): Voice {
    const ctx = this.ctx;
    const zone = zoneFor(instrument, note);
    const source = ctx.createBufferSource();
    source.buffer = this.bufferFor(zone);
    if (zone.loop) {
      source.loop = true;
      source.loopStart = zone.loop.start;
      source.loopEnd = zone.loop.end;
    }
    const envelope = ctx.createGain();
    const fade = ctx.createGain();
    const gain = ctx.createGain();
    source.connect(envelope).connect(fade).connect(gain).connect(out.input);

    const points = instrument.volumeEnvelope?.points;
    if (points) {
      // XM envelope: ramp point to point, up to the sustain point (or the end) and hold there.
      const last = instrument.volumeEnvelope?.sustain ?? points.length - 1;
      envelope.gain.setValueAtTime(points[0][1], t);
      for (let i = 1; i <= last && i < points.length; i++) envelope.gain.linearRampToValueAtTime(points[i][1], t + points[i][0]);
    } else {
      const env = instrument.envelope;
      envelope.gain.setValueAtTime(0, t);
      envelope.gain.setTargetAtTime(1, t, Math.max(0.0005, env.attack / 3));
      if (env.sustain < 1) envelope.gain.setTargetAtTime(env.sustain, t + env.attack, Math.max(0.001, env.decay / 3));
    }
    gain.gain.setValueAtTime(volume * instrument.gain * (zone.gain ?? 1), t);

    const voice: Voice = { source, envelope, fade, volume: gain, instrument, root: zone.root, start: t, stopped: false };
    if (slideIn) {
      source.detune.setValueAtTime(cents(note + slideIn.semis, voice), t);
      source.detune.linearRampToValueAtTime(cents(note, voice), t + slideIn.ticks * tick);
    } else {
      source.detune.setValueAtTime(cents(note, voice), t);
    }
    const vib = instrument.autoVibrato;
    if (vib) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = vib.rate;
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.setValueAtTime(0, t + vib.delay);
      depth.gain.linearRampToValueAtTime(vib.depth, t + vib.delay + (vib.sweep ?? 0.5));
      lfo.connect(depth).connect(source.detune);
      lfo.start(t);
      voice.vibrato = lfo;
    }
    source.start(t);
    source.onended = () => {
      envelope.disconnect();
      fade.disconnect();
      gain.disconnect();
      voice.vibrato?.disconnect();
      this.voices.delete(voice);
    };
    this.voices.add(voice);
    return voice;
  }

  /** Starts the release at `t`; `release` overrides the instrument's. */
  private release(voice: Voice, t: number, release = voice.instrument.envelope.release): void {
    if (voice.stopped) return;
    voice.stopped = true;
    const at = Math.max(t, voice.start);
    // An XM envelope plays on past its sustain point after key-off.
    const env = voice.instrument.volumeEnvelope;
    if (env?.sustain !== undefined && env.sustain < env.points.length - 1 && release > 0.05) {
      const param = voice.envelope.gain;
      const held = env.points[env.sustain];
      if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(at);
      else param.cancelScheduledValues(at), param.setValueAtTime(held[1], at);
      for (let i = env.sustain + 1; i < env.points.length; i++) param.linearRampToValueAtTime(env.points[i][1], at + env.points[i][0] - held[0]);
    }
    voice.fade.gain.setValueAtTime(1, at);
    voice.fade.gain.setTargetAtTime(0, at, Math.max(0.005, release / 4));
    const end = at + release * 1.6 + 0.05;
    voice.source.stop(end);
    voice.vibrato?.stop(end);
  }

  private bufferFor(zone: SampleZone): AudioBuffer {
    let buffer = this.buffers.get(zone.data);
    if (!buffer) {
      buffer = this.ctx.createBuffer(1, zone.data.length, zone.sampleRate);
      buffer.copyToChannel(zone.data as Float32Array<ArrayBuffer>, 0);
      this.buffers.set(zone.data, buffer);
    }
    return buffer;
  }
}

function cents(pitch: number, voice: Voice): number {
  return (pitch - voice.root) * 100;
}

/** A plain hall: stereo noise decaying over `seconds`, darker as it fades, after a short gap. */
function impulseResponse(ctx: AudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(seconds * rate);
  const buffer = ctx.createBuffer(2, length, rate);
  const predelay = Math.floor(0.025 * rate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let seed = 12345 + c * 777;
    let low = 0;
    for (let i = predelay; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      const white = (seed >>> 0) / 4294967296 - 0.5;
      const t = (i - predelay) / rate;
      const a = 0.9 * Math.exp(-t / 0.5) + 0.05;
      low += a * (white - low);
      data[i] = low * Math.exp(-t / (seconds / 5)) * 2;
    }
  }
  return buffer;
}
