/**
 * Where long work waits between its slices (CHARACTERS.md, *Caches*): `sliceBreak()` is awaited
 * after each few milliseconds of work - painting a body, building one - and gives the page's frames
 * their time. All the work in progress shares one allowance a frame, so a crowd coming into view
 * takes a few slices of each frame between them, however many bodies are being made, instead of a
 * slice each. A timer's slices (`setTimeout(0)`) are held back 4 ms or more apiece, and all at once
 * when the tab is in the background; a message is not.
 */

/** Slices the work in progress may run in one frame (a slice is a few milliseconds). */
const SLICES_PER_FRAME = 2;
/** How long to wait for a frame before carrying on anyway - a hidden page draws none. */
const FRAME_TIMEOUT = 100;

let used = 0;
let armed = false;
const queue: (() => void)[] = [];
const ready: (() => void)[] = [];
const channel = typeof MessageChannel === "undefined" ? null : new MessageChannel();
if (channel) channel.port1.onmessage = () => ready.shift()?.();

/** Resumes `resolve` as soon as the browser has other things done - not after a timer's delay. */
function post(resolve: () => void): void {
  if (channel) {
    ready.push(resolve);
    channel.port2.postMessage(0);
  } else setTimeout(resolve, 0);
}

/** Resolved when it is this work's turn again: at once if the frame has a slice left, else when a
 *  later frame has. */
export function sliceBreak(): Promise<void> {
  return new Promise((resolve) => {
    // A page nobody is looking at draws no frames to wait for.
    if (typeof document !== "undefined" && document.hidden) return post(resolve);
    if (used < SLICES_PER_FRAME && queue.length === 0) {
      used++;
      post(resolve);
    } else queue.push(resolve);
    arm();
  });
}

/** At the next frame, a new allowance, given first to whoever has waited longest. */
function arm(): void {
  if (armed) return;
  armed = true;
  let done = false;
  const frame = (): void => {
    if (done) return;
    done = true;
    armed = false;
    used = 0;
    while (queue.length > 0 && used < SLICES_PER_FRAME) {
      used++;
      post(queue.shift()!);
    }
    if (queue.length > 0) arm();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(frame);
  setTimeout(frame, FRAME_TIMEOUT);
}
