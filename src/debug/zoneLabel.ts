export interface ZoneLabel {
  update: (zoneName: string, biomeName: string, weather?: string | null) => void;
}

/** A small, always-visible dev-tool label showing which zone the player currently stands in, by its
 *  generated name and the biome behind it - the name alone is not enough to tell what the ground is
 *  doing, and the biome alone does not distinguish one of the 66 zones from another of the same kind. */
export function createZoneLabel(): ZoneLabel {
  const container = document.createElement("div");
  container.style.cssText = `
    position: fixed; top: 52px; left: 16px; z-index: 900;
    background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;
    padding: 6px 10px; font-family: sans-serif; font-size: 11px; color: #eee;
    white-space: nowrap;
  `;
  container.textContent = "Zone: -";
  document.body.appendChild(container);

  let lastText: string | null = null;

  const update = (zoneName: string, biomeName: string, weather?: string | null): void => {
    const text = `Zone: ${zoneName} (${biomeName})${weather ? ` · ${weather}` : ""}`;
    if (text === lastText) return;
    lastText = text;
    container.textContent = text;
  };

  return { update };
}
