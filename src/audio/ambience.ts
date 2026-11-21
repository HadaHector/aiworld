// The ambience (SLICE.md, P7): the sound the place itself makes, under the music and the effects -
// wind and dry leaves, rain, a river or pond nearby, birds by day and an owl by night, a cave's
// room tone and drips, a crypt's low drone. Everything is made in code, none of it from files:
// loops of filtered noise, and one-shots (a chirp, a drip) scheduled at random. Each frame the game
// says what surrounds the player (`AmbienceState`); `ambienceMix` turns that into layer levels and
// this fades the layers to them.

import { ambienceMix, type AmbienceMix, type AmbienceState } from "./ambienceMix";

export interface Ambience {
  /** Each frame: the surroundings. */
  update: (state: AmbienceState) => void;
  /** 0..1, the player's Effects volume. */
  setVolume: (volume: number) => void;
  /** The levels the layers are fading to now - for the dev page and the console. */
  mix: () => AmbienceMix;
  dispose: () => void;
}

/** Seconds a layer takes to fade to a new level (the time constant is a third of it). */
const FADE = 1.8;

/** A loop of coloured noise that joins itself end to start without a click. */
function noiseLoop(ctx: BaseAudioContext, seconds: number, colour: "white" | "pink" | "brown", seed: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(seconds * rate);
  const fade = Math.floor(rate * 0.4);
  const buffer = ctx.createBuffer(1, length + fade, rate);
  const data = buffer.getChannelData(0);
  let s = seed >>> 0 || 1;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < data.length; i++) {
    const w = rnd() * 2;
    if (colour === "white") data[i] = w * 0.5;
    else if (colour === "pink") {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
    } else {
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.2;
    }
  }
  // The tail's extra stretch is faded in over the start, so the loop point is not a seam.
  const out = ctx.createBuffer(1, length, rate);
  const o = out.getChannelData(0);
  for (let i = 0; i < length; i++) o[i] = data[i];
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    o[i] = o[i] * t + data[length + i] * (1 - t);
  }
  return out;
}

/** A loop of tiny bright ticks at random - raindrops on leaves. */
function patterLoop(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(seconds * rate);
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let s = seed >>> 0 || 1;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const drops = Math.floor(seconds * 95);
  for (let d = 0; d < drops; d++) {
    const at = Math.floor(rnd() * (length - 600));
    const amp = 0.15 + rnd() * rnd() * 0.85;
    const hz = 1800 + rnd() * 4200;
    const decay = 120 + rnd() * 260;
    for (let i = 0; i < 600; i++) data[at + i] += Math.sin((i * hz * Math.PI * 2) / rate) * Math.exp(-i / decay) * amp * 0.35;
  }
  return buffer;
}

/** A room's tail: noise that dies away, a little different in each ear. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(seconds * rate);
  const buffer = ctx.createBuffer(2, length, rate);
  let s = 12345;
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let low = 0;
    for (let i = 0; i < length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const w = s / 2147483648 - 1;
      // Darker as it goes: stone swallows the high end first.
      const k = 0.15 + 0.8 * Math.exp((-i / rate) * 1.6);
      low += (w - low) * k;
      data[i] = low * Math.pow(1 - i / length, 2.2);
    }
  }
  return buffer;
}

export function createAmbience(ctx: AudioContext, output: AudioNode): Ambience {
  const volume = ctx.createGain();
  volume.connect(output);
  const gainAt = (node: AudioParam, value: number): void => {
    node.setTargetAtTime(value, ctx.currentTime, FADE / 3);
  };

  // --- the outdoors: one bus, so that underground and indoors act on all of it at once ---
  const outdoors = ctx.createGain();
  const outdoorCut = ctx.createBiquadFilter();
  outdoorCut.type = "lowpass";
  outdoorCut.frequency.value = 18000;
  outdoors.connect(outdoorCut);
  outdoorCut.connect(volume);

  const sources: (AudioScheduledSourceNode)[] = [];
  const loop = (buffer: AudioBuffer): AudioBufferSourceNode => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    // Each loop starts somewhere else, so two layers of one noise do not breathe together.
    source.start(0, Math.random() * buffer.duration);
    sources.push(source);
    return source;
  };
  const lfo = (hz: number, depth: number, target: AudioParam): void => {
    const osc = ctx.createOscillator();
    osc.frequency.value = hz;
    const amount = ctx.createGain();
    amount.gain.value = depth;
    osc.connect(amount);
    amount.connect(target);
    osc.start();
    sources.push(osc);
  };

  const brown = noiseLoop(ctx, 7, "brown", 11);
  const pink = noiseLoop(ctx, 6, "pink", 23);
  const white = noiseLoop(ctx, 5, "white", 37);

  // Wind: brown noise through a band that opens and closes in slow gusts.
  const windBand = ctx.createBiquadFilter();
  windBand.type = "bandpass";
  windBand.frequency.value = 420;
  windBand.Q.value = 0.7;
  lfo(0.08, 160, windBand.frequency);
  lfo(0.23, 110, windBand.frequency);
  const windLevel = ctx.createGain();
  windLevel.gain.value = 0;
  const gust = ctx.createGain();
  gust.gain.value = 0.7;
  lfo(0.1, 0.25, gust.gain);
  lfo(0.31, 0.12, gust.gain);
  loop(brown).connect(windBand);
  windBand.connect(windLevel);
  windLevel.connect(gust);
  gust.connect(outdoors);

  // Dry leaves: bright noise in short fluttering bursts, on the wind's own gusts.
  const rustleBand = ctx.createBiquadFilter();
  rustleBand.type = "bandpass";
  rustleBand.frequency.value = 4200;
  rustleBand.Q.value = 0.9;
  const rustleLevel = ctx.createGain();
  rustleLevel.gain.value = 0;
  const flutter = ctx.createGain();
  flutter.gain.value = 0.55;
  lfo(0.1, 0.3, flutter.gain);
  lfo(2.7, 0.18, flutter.gain);
  lfo(5.9, 0.1, flutter.gain);
  loop(white).connect(rustleBand);
  rustleBand.connect(rustleLevel);
  rustleLevel.connect(flutter);
  flutter.connect(outdoors);

  // Rain: a soft hiss, and the drops over it.
  const rainHigh = ctx.createBiquadFilter();
  rainHigh.type = "highpass";
  rainHigh.frequency.value = 900;
  const rainLow = ctx.createBiquadFilter();
  rainLow.type = "lowpass";
  rainLow.frequency.value = 9000;
  const rainLevel = ctx.createGain();
  rainLevel.gain.value = 0;
  loop(pink).connect(rainHigh);
  rainHigh.connect(rainLow);
  rainLow.connect(rainLevel);
  rainLevel.connect(outdoors);
  const patterLevel = ctx.createGain();
  patterLevel.gain.value = 0;
  loop(patterLoop(ctx, 5, 71)).connect(patterLevel);
  patterLevel.connect(outdoors);

  // Water: two bands wandering over pink noise make a burble; a thin hiss on top is the riffles.
  const waterLevel = ctx.createGain();
  waterLevel.gain.value = 0;
  const burble = (hz: number, depth: number, rate: number, q: number, level: number): void => {
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = hz;
    band.Q.value = q;
    lfo(rate, depth, band.frequency);
    const g = ctx.createGain();
    g.gain.value = level;
    loop(pink).connect(band);
    band.connect(g);
    g.connect(waterLevel);
  };
  burble(520, 220, 0.7, 4, 1.1);
  burble(1250, 420, 1.1, 5, 0.8);
  burble(2300, 700, 1.7, 3, 0.45);
  const riffle = ctx.createBiquadFilter();
  riffle.type = "highpass";
  riffle.frequency.value = 3500;
  const riffleLevel = ctx.createGain();
  riffleLevel.gain.value = 0.16;
  lfo(0.4, 0.06, riffleLevel.gain);
  loop(white).connect(riffle);
  riffle.connect(riffleLevel);
  riffleLevel.connect(waterLevel);
  waterLevel.connect(outdoors);

  // --- below ground: room tone, a crypt's drone, and the drips through a stone room's tail ---
  const hollowBus = ctx.createGain();
  hollowBus.gain.value = 0;
  hollowBus.connect(volume);
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 200;
  const toneLevel = ctx.createGain();
  toneLevel.gain.value = 0.3;
  lfo(0.07, 0.2, toneLevel.gain);
  loop(brown).connect(tone);
  tone.connect(toneLevel);
  toneLevel.connect(hollowBus);
  // A thin draught through the rock.
  const draught = ctx.createBiquadFilter();
  draught.type = "bandpass";
  draught.frequency.value = 700;
  draught.Q.value = 6;
  lfo(0.05, 260, draught.frequency);
  const draughtLevel = ctx.createGain();
  draughtLevel.gain.value = 0.05;
  lfo(0.13, 0.03, draughtLevel.gain);
  loop(pink).connect(draught);
  draught.connect(draughtLevel);
  draughtLevel.connect(hollowBus);
  const cryptLevel = ctx.createGain();
  cryptLevel.gain.value = 0;
  for (const [hz, level] of [[55, 0.5], [82.6, 0.28], [110.5, 0.14]] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = hz;
    lfo(0.05 + hz / 4000, hz * 0.004, osc.frequency);
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g);
    g.connect(cryptLevel);
    osc.start();
    sources.push(osc);
  }
  const cryptSwell = ctx.createGain();
  cryptSwell.gain.value = 0.7;
  lfo(0.09, 0.3, cryptSwell.gain);
  cryptLevel.connect(cryptSwell);
  cryptSwell.connect(hollowBus);
  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx, 3);
  const reverbLevel = ctx.createGain();
  reverbLevel.gain.value = 0.9;
  reverb.connect(reverbLevel);
  reverbLevel.connect(hollowBus);

  // --- one-shots ---
  /** One note of a bird: a sine with a faint octave, gliding, in a small envelope. */
  const note = (to: AudioNode, t: number, from: number, end: number, seconds: number, level: number): void => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.linearRampToValueAtTime(end, t + seconds);
    const over = ctx.createOscillator();
    over.type = "sine";
    over.frequency.setValueAtTime(from * 2, t);
    over.frequency.linearRampToValueAtTime(end * 2, t + seconds);
    const overLevel = ctx.createGain();
    overLevel.gain.value = 0.18;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + Math.min(0.012, seconds / 3));
    env.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 0.02);
    osc.connect(env);
    over.connect(overLevel);
    overLevel.connect(env);
    env.connect(to);
    osc.start(t);
    over.start(t);
    osc.stop(t + seconds + 0.05);
    over.stop(t + seconds + 0.05);
  };
  const birdOut = (pan: number, distance: number): GainNode => {
    // Far birds are quieter and duller; each song has its own place in the stereo field.
    const g = ctx.createGain();
    g.gain.value = 0.05 * (1 - distance * 0.7);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 9000 - distance * 5500;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(lp);
    lp.connect(p);
    p.connect(outdoors);
    return g;
  };
  const rand = (a: number, b: number): number => a + Math.random() * (b - a);
  const birdSongs: ((to: AudioNode, t: number) => number)[] = [
    // A two-note whistle, "fee-bee": falling and lower.
    (to, t) => {
      const f = rand(2800, 3500);
      note(to, t, f * 1.02, f, 0.34, 1);
      note(to, t + 0.46, f * 0.86, f * 0.84, 0.4, 0.9);
      return 0.9;
    },
    // A trill: many quick notes wandering.
    (to, t) => {
      const count = 7 + Math.floor(Math.random() * 9);
      let f = rand(3600, 4600);
      for (let i = 0; i < count; i++) {
        f = Math.min(5600, Math.max(3000, f + rand(-260, 280)));
        note(to, t + i * 0.055, f, f * rand(0.9, 1.12), 0.045, 0.6);
      }
      return count * 0.055;
    },
    // A warble: slurred notes of a robin, with breaths between.
    (to, t) => {
      const count = 4 + Math.floor(Math.random() * 5);
      let at = 0;
      for (let i = 0; i < count; i++) {
        const f = rand(2300, 4000);
        const d = rand(0.07, 0.16);
        note(to, t + at, f, f * rand(0.7, 1.4), d, 0.8);
        at += d + rand(0.03, 0.12);
      }
      return at;
    },
    // A chirp, chirp: two short rising notes, now and again repeated.
    (to, t) => {
      const f = rand(3200, 4200);
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) note(to, t + i * 0.19, f, f * 1.35, 0.1, 0.8);
      return n * 0.19;
    },
  ];
  /** A woodpecker, far off: dry knocks that run together. */
  const knock = (t: number): void => {
    const pan = rand(-0.8, 0.8);
    const out = birdOut(pan, 0.85);
    out.gain.value *= 3.5;
    let at = 0;
    let gap = 0.075;
    for (let i = 0; i < 11; i++) {
      const src = ctx.createBufferSource();
      src.buffer = white;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 1400;
      band.Q.value = 2.5;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.9, t + at);
      env.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.03);
      src.connect(band);
      band.connect(env);
      env.connect(out);
      src.start(t + at, Math.random() * 4, 0.04);
      at += gap;
      gap *= 0.96;
    }
  };
  /** A crow, over the trees: two or three rough caws. */
  const caw = (t: number): void => {
    const out = birdOut(rand(-0.9, 0.9), 0.8);
    out.gain.value *= 4;
    const caws = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < caws; i++) {
      const at = t + i * 0.42;
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(rand(520, 620), at);
      osc.frequency.exponentialRampToValueAtTime(rand(330, 400), at + 0.27);
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 1100;
      band.Q.value = 1.2;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(0.7, at + 0.03);
      env.gain.linearRampToValueAtTime(0.0001, at + 0.3);
      osc.connect(band);
      band.connect(env);
      env.connect(out);
      osc.start(at);
      osc.stop(at + 0.34);
    }
  };
  /** A tawny owl: a long hoot, then a short run of them. */
  const owl = (t: number): void => {
    const out = birdOut(rand(-0.8, 0.8), 0.7);
    out.gain.value *= 3;
    const hoots: [number, number][] = [[0, 0.5], [0.85, 0.16], [1.1, 0.16], [1.35, 0.7]];
    const base = rand(330, 400);
    for (const [at, d] of hoots) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(base * 1.05, t + at);
      osc.frequency.linearRampToValueAtTime(base, t + at + d);
      const wobble = ctx.createOscillator();
      wobble.frequency.value = 7;
      const wobbleDepth = ctx.createGain();
      wobbleDepth.gain.value = 6;
      wobble.connect(wobbleDepth);
      wobbleDepth.connect(osc.frequency);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t + at);
      env.gain.linearRampToValueAtTime(0.8, t + at + 0.06);
      env.gain.setValueAtTime(0.8, t + at + d * 0.7);
      env.gain.linearRampToValueAtTime(0.0001, t + at + d + 0.1);
      osc.connect(env);
      env.connect(out);
      osc.start(t + at);
      wobble.start(t + at);
      osc.stop(t + at + d + 0.15);
      wobble.stop(t + at + d + 0.15);
    }
  };
  /** One drop falling into still water, somewhere in the stone dark; sometimes twice. */
  const drip = (t: number): void => {
    const pan = rand(-0.85, 0.85);
    const hz = rand(620, 1500);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const dry = ctx.createGain();
    dry.gain.value = rand(0.12, 0.3);
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    panner.connect(dry);
    panner.connect(wet);
    dry.connect(hollowBus);
    wet.connect(reverb);
    const plink = (at: number, level: number): void => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(hz, at);
      osc.frequency.exponentialRampToValueAtTime(hz * 1.7, at + 0.05);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(level, at + 0.003);
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(env);
      env.connect(panner);
      osc.start(at);
      osc.stop(at + 0.2);
    };
    plink(t, 1);
    if (Math.random() < 0.3) plink(t + rand(0.35, 0.8), 0.45);
  };

  // --- the loop of it ---
  let target = ambienceMix({ wind: 1, rain: 0, snow: 0, hour: 12, underground: 0, hollow: null, indoors: false, waterDistance: Infinity, life: 1 });
  let nextBird = 0;
  let nextOwl = 0;
  let nextDrip = 0;
  let nextCaw = 0;
  let nextKnock = 0;
  let started = false;
  const exponential = (rate: number): number => -Math.log(1 - Math.random()) / Math.max(rate, 1e-6);

  const update = (state: AmbienceState): void => {
    target = ambienceMix(state);
    gainAt(windLevel.gain, target.wind * 0.9);
    gainAt(rustleLevel.gain, target.rustle * 0.35);
    gainAt(rainLevel.gain, target.rain * 0.6);
    gainAt(patterLevel.gain, target.patter * 0.7);
    gainAt(waterLevel.gain, target.water * 0.5);
    gainAt(outdoors.gain, target.outdoors);
    outdoorCut.frequency.setTargetAtTime(target.outdoorCutHz, ctx.currentTime, 0.15);
    gainAt(hollowBus.gain, target.hollow * 0.8);
    gainAt(cryptLevel.gain, target.crypt * 0.16);
    // The sound waits for the first moment, so nothing starts in a burst.
    const now = ctx.currentTime;
    if (!started) {
      started = true;
      nextBird = now + 1;
      nextOwl = now + 8;
      nextDrip = now + 1;
      nextCaw = now + 30;
      nextKnock = now + 25;
    }
    // One-shots are scheduled a moment ahead, so a slow frame does not bunch them up.
    const ahead = now + 0.05;
    if (target.birdsPerSecond > 0.01 && now >= nextBird) {
      const song = birdSongs[Math.floor(Math.random() * birdSongs.length)];
      const distance = Math.random();
      song(birdOut(rand(-0.9, 0.9), distance), ahead);
      nextBird = now + exponential(target.birdsPerSecond);
    } else if (target.birdsPerSecond <= 0.01 && nextBird < now) nextBird = now + 2;
    if (target.birdsPerSecond > 0.05 && now >= nextCaw) {
      caw(ahead);
      nextCaw = now + rand(40, 110);
    }
    if (target.birdsPerSecond > 0.05 && now >= nextKnock) {
      knock(ahead);
      nextKnock = now + rand(50, 140);
    }
    if (target.owlsPerSecond > 0.002 && now >= nextOwl) {
      owl(ahead);
      nextOwl = now + exponential(target.owlsPerSecond) + 6;
    } else if (target.owlsPerSecond <= 0.002 && nextOwl < now) nextOwl = now + 5;
    if (target.dripsPerSecond > 0.02 && now >= nextDrip) {
      drip(ahead);
      nextDrip = now + 0.25 + exponential(target.dripsPerSecond);
    } else if (target.dripsPerSecond <= 0.02 && nextDrip < now) nextDrip = now + 1;
  };

  return {
    update,
    setVolume(v) {
      volume.gain.value = v;
    },
    mix: () => target,
    dispose() {
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
      volume.disconnect();
    },
  };
}
