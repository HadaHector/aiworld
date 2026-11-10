// Screen overlays for cues (see FEEDBACK.md, *Screen overlays*): while the player is rooted, a vignette
// closes in from the screen's edges with a generated texture - webs, frost - drawn in its corners.
// One DOM layer over the canvas, under the HUD's windows; each overlay fades in, breathes a little,
// and fades out when its cue stops. The textures are the particle textures, drawn once into canvases.

import { drawParticleTexture } from "../particles/textures";
import type { CuePart, FeedbackRules } from "./rules";

export interface ScreenEffects {
  /** Starts an overlay for a `screen` part; its `stop` fades it out. */
  show: (part: CuePart) => { stop: () => void };
  dispose: () => void;
}

const FADE_IN = 0.25;
const FADE_OUT = 0.5;

export function createScreenEffects(rules: FeedbackRules, parent: HTMLElement = document.body): ScreenEffects {
  const root = document.createElement("div");
  root.style.cssText = "position: fixed; inset: 0; z-index: 900; pointer-events: none; overflow: hidden;";
  parent.appendChild(root);
  const urls = new Map<string, string>();
  /** A particle texture as an image URL: white threads with their alpha. */
  const textureUrl = (id: string): string => {
    const cached = urls.get(id);
    if (cached) return cached;
    const index = rules.textureIndex.get(id);
    const def = index === undefined ? null : rules.textures[index];
    if (!def) return "";
    const { size, luminance, alpha } = drawParticleTexture(def, 0);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    const image = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const l = Math.round(luminance[i] * 255);
      image.data.set([l, l, l, Math.round(alpha[i] * 255)], i * 4);
    }
    ctx.putImageData(image, 0, 0);
    const url = canvas.toDataURL();
    urls.set(id, url);
    return url;
  };
  const css = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);

  return {
    show(part) {
      const [r, g, b] = [css(part.colour[0]), css(part.colour[1]), css(part.colour[2])];
      const el = document.createElement("div");
      el.style.cssText = `position: absolute; inset: 0; opacity: 0; transition: opacity ${FADE_IN}s ease-out;
        background: radial-gradient(ellipse at center, rgba(${r},${g},${b},0) 52%, rgba(${r},${g},${b},${0.18 * part.strength}) 80%, rgba(${r},${g},${b},${0.55 * part.strength}) 100%);`;
      const url = part.ref ? textureUrl(part.ref) : "";
      if (url) {
        // The same texture in each corner, turned so the hub lies in the corner: big and tinted.
        const corners: [string, string][] = [["left", "top"], ["right", "top"], ["left", "bottom"], ["right", "bottom"]];
        corners.forEach(([x, y], k) => {
          const img = document.createElement("div");
          img.style.cssText = `position: absolute; ${x}: -11vmin; ${y}: -11vmin; width: 40vmin; height: 40vmin;
            background: url(${url}) center / contain no-repeat; opacity: ${0.7 * Math.min(1, part.strength * 1.4)};
            transform: rotate(${k * 53}deg); filter: drop-shadow(0 0 3px rgba(${r},${g},${b},0.8));`;
          el.appendChild(img);
        });
      }
      root.appendChild(el);
      requestAnimationFrame(() => {
        el.style.opacity = "1";
      });
      // A slow breath, so it is felt rather than just seen.
      const pulse = el.animate([{ filter: "brightness(1)" }, { filter: "brightness(1.35)" }, { filter: "brightness(1)" }], { duration: 1600, iterations: Infinity });
      return {
        stop() {
          el.style.transition = `opacity ${FADE_OUT}s ease-in`;
          el.style.opacity = "0";
          window.setTimeout(() => {
            pulse.cancel();
            el.remove();
          }, FADE_OUT * 1000 + 50);
        },
      };
    },
    dispose() {
      root.remove();
    },
  };
}
