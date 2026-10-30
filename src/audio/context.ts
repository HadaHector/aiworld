// The page's one AudioContext (see FEEDBACK.md), shared by the music and the sound effects. It is
// made as soon as anything asks for it and runs at once where the browser lets a page play sound
// unasked (an app's own window, a site Chrome has seen media played on). Elsewhere it waits,
// suspended, for the first click or key press - and is resumed on every later one, as a tab put to
// sleep suspends it.

export interface GameAudio {
  ctx: AudioContext;
  /** Where the music plays into. */
  music: AudioNode;
  /** Where the sound effects play into. */
  effects: AudioNode;
}

/** Made at once; given out only once it runs. */
let made: GameAudio | null = null;
let audio: GameAudio | null = null;
const waiting: ((audio: GameAudio) => void)[] = [];
let listening = false;

function make(): GameAudio {
  if (made) return made;
  const ctx = new AudioContext();
  // Music and effects meet in a gentle limiter, so a loud fight over a loud piece does not clip.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.connect(ctx.destination);
  const music = ctx.createGain();
  const effects = ctx.createGain();
  music.connect(limiter);
  effects.connect(limiter);
  made = { ctx, music, effects };
  // Running already, or as soon as the browser allows: then everyone waiting gets it.
  ctx.addEventListener("statechange", started);
  started();
  return made;
}

function started(): void {
  if (audio || !made || made.ctx.state !== "running") return;
  audio = made;
  for (const callback of waiting.splice(0)) callback(audio);
}

function unlock(): void {
  void make().ctx.resume();
}

/** Calls back with the page's audio once it runs - at once if it does, else on the first click or
 *  key press where the browser asks for one. Returns what cancels a call still waiting, so a game that ends before audio starts
 *  is not kept alive by its callback. */
export function whenAudio(callback: (audio: GameAudio) => void): () => void {
  if (audio) {
    callback(audio);
    return () => {};
  }
  waiting.push(callback);
  if (!listening) {
    listening = true;
    addEventListener("pointerdown", unlock);
    addEventListener("keydown", unlock);
    unlock();
  }
  return () => {
    const i = waiting.indexOf(callback);
    if (i >= 0) waiting.splice(i, 1);
  };
}

/** The page's audio, or null until it runs. */
export function gameAudio(): GameAudio | null {
  return audio;
}
