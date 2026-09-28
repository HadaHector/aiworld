import { clearTextureCache, onTextureCacheChange, textureCacheUsage } from "../world/materials/textureCache";

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

/**
 * "Texture cache: 152 MB (19)" and a Clear button - how much of the disk the baked textures kept
 * between visits take (textureCache.ts). Unstyled beyond its layout, so each page places it in its
 * own panel. The title says how much the browser lets this site keep at all.
 */
export function createTextureCacheLabel(): HTMLElement {
  const root = document.createElement("span");
  root.style.cssText = "display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;";

  const text = document.createElement("span");
  text.textContent = "Texture cache: …";

  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear";
  clear.title = "Forget every kept texture; the next start bakes them all again";
  clear.style.cssText = "font: inherit; padding: 0 6px; cursor: pointer;";
  clear.addEventListener("click", () => {
    void clearTextureCache();
  });

  root.append(text, clear);

  let refreshing = false;
  let again = false;
  const refresh = async (): Promise<void> => {
    // Saves come in bursts, one per texture; one read at a time, plus one after the burst.
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    try {
      const { bytes, count } = await textureCacheUsage();
      text.textContent = `Texture cache: ${formatBytes(bytes)} (${count})`;
      clear.disabled = count === 0;
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.quota) root.title = `This site may keep up to ${formatBytes(estimate.quota)} in total`;
    } catch {
      text.textContent = "Texture cache: unavailable";
      clear.disabled = true;
    } finally {
      refreshing = false;
      if (again) {
        again = false;
        void refresh();
      }
    }
  };

  onTextureCacheChange(() => void refresh());
  void refresh();
  return root;
}
