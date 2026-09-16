import { Color3 } from "@babylonjs/core";
import type { TerrainSampler } from "../world/terrain/terrainSampler";
import type { BiomeColorBands } from "../world/biomes/biomeTypes";

const SAMPLE_RESOLUTION = 400; // internal sample grid, kept modest since this is a debug tool
const DISPLAY_SIZE_CSS = "min(85vw, 85vh)"; // large, centered, capped to fit the viewport
const OCEAN_COLOR = new Color3(0.09, 0.32, 0.45);
const MARKER_COLOR = "rgb(255, 60, 60)";
const MARKER_RADIUS_PX = 4;

export interface DebugMap {
  toggle: () => void;
  updateMarker: (worldX: number, worldZ: number) => void;
}

function pickBandColor(height: number, bands: BiomeColorBands): Color3 {
  if (height < bands.height0) return bands.color0;
  if (height < bands.height1) return bands.color1;
  if (height < bands.height2) return bands.color2;
  return bands.color3;
}

/**
 * A large, full-screen-ish top-down debug map showing every generated continent at once.
 * Rendered once (lazily, on first open) since a full-world sample pass is relatively expensive;
 * a small live marker is cheaply redrawn on top of the cached base image every frame while visible.
 */
export function createDebugMap(sampleTerrain: TerrainSampler, worldExtent: number): DebugMap {
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 1000; display: none;
    background: rgba(0,0,0,0.85);
    align-items: center; justify-content: center; flex-direction: column; gap: 8px;
    font-family: sans-serif; color: #eee;
  `;

  const label = document.createElement("div");
  label.textContent = "Map (M or Esc to close)";
  label.style.cssText = "font-size: 14px;";
  overlay.appendChild(label);

  const displayCanvas = document.createElement("canvas");
  displayCanvas.width = SAMPLE_RESOLUTION;
  displayCanvas.height = SAMPLE_RESOLUTION;
  displayCanvas.style.cssText = `
    width: ${DISPLAY_SIZE_CSS}; height: ${DISPLAY_SIZE_CSS};
    border: 2px solid rgba(255,255,255,0.6); border-radius: 4px;
  `;
  overlay.appendChild(displayCanvas);
  document.body.appendChild(overlay);

  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = SAMPLE_RESOLUTION;
  baseCanvas.height = SAMPLE_RESOLUTION;

  const baseCtx = baseCanvas.getContext("2d");
  const displayCtx = displayCanvas.getContext("2d");
  if (!baseCtx || !displayCtx) {
    throw new Error("2D canvas context unavailable");
  }

  let rendered = false;
  let visible = false;
  let markerX = 0;
  let markerZ = 0;

  const renderBaseMap = (): void => {
    const imageData = baseCtx.createImageData(SAMPLE_RESOLUTION, SAMPLE_RESOLUTION);
    const half = worldExtent / 2;

    for (let py = 0; py < SAMPLE_RESOLUTION; py++) {
      for (let px = 0; px < SAMPLE_RESOLUTION; px++) {
        const worldX = (px / SAMPLE_RESOLUTION) * worldExtent - half;
        const worldZ = (py / SAMPLE_RESOLUTION) * worldExtent - half;
        const sample = sampleTerrain(worldX, worldZ);
        const color = sample.isLand ? pickBandColor(sample.height, sample.primaryBiome.colors) : OCEAN_COLOR;

        const i = (py * SAMPLE_RESOLUTION + px) * 4;
        imageData.data[i] = Math.round(color.r * 255);
        imageData.data[i + 1] = Math.round(color.g * 255);
        imageData.data[i + 2] = Math.round(color.b * 255);
        imageData.data[i + 3] = 255;
      }
    }

    baseCtx.putImageData(imageData, 0, 0);
    rendered = true;
  };

  const redraw = (): void => {
    displayCtx.drawImage(baseCanvas, 0, 0);

    const half = worldExtent / 2;
    const markerPxX = ((markerX + half) / worldExtent) * SAMPLE_RESOLUTION;
    const markerPxZ = ((markerZ + half) / worldExtent) * SAMPLE_RESOLUTION;

    displayCtx.fillStyle = MARKER_COLOR;
    displayCtx.beginPath();
    displayCtx.arc(markerPxX, markerPxZ, MARKER_RADIUS_PX, 0, Math.PI * 2);
    displayCtx.fill();
  };

  const setVisible = (next: boolean): void => {
    visible = next;
    overlay.style.display = visible ? "flex" : "none";
    if (visible) {
      if (!rendered) renderBaseMap();
      redraw();
    }
  };

  const toggle = (): void => setVisible(!visible);

  const updateMarker = (worldX: number, worldZ: number): void => {
    markerX = worldX;
    markerZ = worldZ;
    if (visible) redraw();
  };

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && visible) setVisible(false);
  });

  return { toggle, updateMarker };
}
