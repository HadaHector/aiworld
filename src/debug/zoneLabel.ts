export interface ZoneLabel {
  update: (biomeName: string) => void;
}

/** A small, always-visible dev-tool label showing which biome/zone the player currently stands in. */
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

  let lastName: string | null = null;

  const update = (biomeName: string): void => {
    if (biomeName === lastName) return;
    lastName = biomeName;
    container.textContent = `Zone: ${biomeName}`;
  };

  return { update };
}
