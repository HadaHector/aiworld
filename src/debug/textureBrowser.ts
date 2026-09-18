import type { MaterialLibrary } from "../world/materials/materialLibrary";
import { TEXTURE_RESOLUTION } from "../world/materials/textureGen";

export interface TextureBrowser {
  toggle: () => void;
}

const PREVIEW_SIZE_PX = 96; // downscaled from the full TEXTURE_RESOLUTION bake, plenty for browsing

/** A small dev-tool overlay listing every deduplicated generated material, showing its baked color
 *  (Milestone 10) and normal-map (Milestone 12) textures side by side. Built once, lazily, on
 *  first open - reads directly from MaterialLibrary's already-baked pixel buffers, no re-render. */
export function createTextureBrowser(materialLibrary: MaterialLibrary): TextureBrowser {
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 1000; display: none;
    background: rgba(0,0,0,0.9); overflow-y: auto;
    font-family: sans-serif; color: #eee;
  `;

  const label = document.createElement("div");
  label.textContent = "Generated Textures (T or Esc to close)";
  label.style.cssText = "font-size: 14px; padding: 16px 16px 0;";
  overlay.appendChild(label);

  const grid = document.createElement("div");
  grid.style.cssText = "display: flex; flex-wrap: wrap; gap: 16px; padding: 16px;";
  overlay.appendChild(grid);

  function renderSwatch(pixels: Uint8Array, swatchLabel: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display: flex; flex-direction: column; align-items: center; gap: 2px;";

    const canvas = document.createElement("canvas");
    canvas.width = TEXTURE_RESOLUTION;
    canvas.height = TEXTURE_RESOLUTION;
    canvas.style.cssText = `width: ${PREVIEW_SIZE_PX}px; height: ${PREVIEW_SIZE_PX}px; image-rendering: pixelated; border: 1px solid rgba(255,255,255,0.25);`;

    const ctx = canvas.getContext("2d");
    if (ctx) {
      // Both buffers carry an unrelated payload in alpha (roughness in the color texture, height in
      // the normal one), which putImageData would treat as transparency and blend into the page -
      // making e.g. a low-height material's normal map look dark rather than showing its normals.
      // Copy with alpha forced opaque so each swatch shows what the shader actually samples: RGB.
      const rgbOnly = new Uint8ClampedArray(pixels);
      for (let i = 3; i < rgbOnly.length; i += 4) rgbOnly[i] = 255;
      ctx.putImageData(new ImageData(rgbOnly, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION), 0, 0);
    }

    const sub = document.createElement("div");
    sub.textContent = swatchLabel;
    sub.style.cssText = "font-size: 9px; opacity: 0.7;";

    wrap.appendChild(canvas);
    wrap.appendChild(sub);
    return wrap;
  }

  let built = false;
  function buildGrid(): void {
    if (built) return;
    built = true;

    for (const tex of materialLibrary.listMaterialTextures()) {
      const card = document.createElement("div");
      card.style.cssText = "display: flex; flex-direction: column; align-items: center; gap: 6px;";

      const name = document.createElement("div");
      name.textContent = tex.name;
      name.style.cssText = "font-size: 11px;";

      const swatches = document.createElement("div");
      swatches.style.cssText = "display: flex; gap: 6px;";
      swatches.appendChild(renderSwatch(tex.colorPixels, "color"));
      swatches.appendChild(renderSwatch(tex.normalPixels, "normal"));

      card.appendChild(name);
      card.appendChild(swatches);
      grid.appendChild(card);
    }
  }

  let visible = false;
  function setVisible(next: boolean): void {
    visible = next;
    overlay.style.display = visible ? "block" : "none";
    if (visible) buildGrid();
  }

  function toggle(): void {
    setVisible(!visible);
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && visible) setVisible(false);
  });

  document.body.appendChild(overlay);

  return { toggle };
}
