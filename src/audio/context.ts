// The page's one AudioContext (see FEEDBACK.md), shared by the music and the sound effects. Browsers
// let audio start only after the player has done something, so it is made on the first click or
// key press, and resumed on every later one (a tab put to sleep suspends it).

export interface GameAudio {
  ctx: AudioContext;
  /** Where the music plays into. */
  music: AudioNode;
  /** Where the sound effects play into. */
  effects: AudioNode;
}

let audio: GameAudio | null = null;
const waiting: ((audio: GameAudio) => void)[] = [];
let listening = false;

function unlock(): void {
  if (!audio) {
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
    audio = { ctx, music, effects };
    for (const callback of waiting.splice(0)) callback(audio);
  }
  void audio.ctx.resume();
}

/** Calls back with the page's audio once the player has clicked or pressed a key - at once if they
 *  already have. Returns what cancels a call still waiting, so a game that ends before audio starts
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
  }
  return () => {
    const i = waiting.indexOf(callback);
    if (i >= 0) waiting.splice(i, 1);
  };
}

/** The page's audio, or null before the first click or key press. */
export function gameAudio(): GameAudio | null {
  return audio;
}
