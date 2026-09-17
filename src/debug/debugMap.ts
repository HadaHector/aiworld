import { Color3 } from "@babylonjs/core";
import type { TerrainSample, TerrainSampler } from "../world/terrain/terrainSampler";
import type { ContinentPlan } from "../world/cells/continentLayout";
import { SEA_LEVEL } from "../world/cells/areaField";
import { GROWTH_RADIUS_SAFETY_FACTOR } from "../world/cells/config";
import type { MaterialLibrary } from "../world/materials/materialLibrary";

const SAMPLE_RESOLUTION = 400; // internal sample grid, kept modest since this is a debug tool
const DISPLAY_SIZE_CSS = "min(85vw, 80vh)"; // large, centered, capped to fit the viewport
const OCEAN_COLOR = new Color3(0.09, 0.32, 0.45);
const LAKE_COLOR = new Color3(0.45, 0.68, 0.88); // lighter blue: inland water below sea level, distinct from open ocean
const MARKER_COLOR = "rgb(255, 60, 60)";
const MARKER_RADIUS_PX = 4;
const HEADING_LENGTH_PX = 14;
const CONTINENT_VIEW_MARGIN = 1.5; // margin beyond a continent's true (non-safety-inflated) radius

// Emboss/relief shading: each land pixel is compared against its upper-left neighbor (one pixel
// away, so the offset self-scales with zoom - a big offset in World view, a fine one in Continent
// view), and darkened/lightened by the height difference, like a classic emboss filter or a
// cartographic shaded-relief layer laid over land-cover color. Only meaningful at Continent-view
// resolution (World view's per-pixel step is thousands of world units, so neighboring pixels are
// essentially uncorrelated - shading there would just be noise/static, not relief), so it's only
// enabled for that view. Water stays flat so land relief reads clearly against it.
const EMBOSS_STRENGTH = 0.05; // world-height-units -> shade magnitude
const EMBOSS_INTENSITY = 0.6; // shade -> brightness multiplier range (0.4x .. 1.6x at full shade)

// Material detail (rock/snow/valley variety, same as materialLibrary.resolveMaterialIndex uses in
// 3D) is only computed at Continent-view resolution, for the same reason emboss is: World view's
// per-pixel step is thousands of world units, far too coarse for a slope/curvature estimate to
// mean anything. World view instead shows each biome's own flat base color (getBiomeBaseColor).
const SLOPE_SAMPLE_STEP_PX = 1; // matches emboss's own "one pixel, self-scales with zoom" approach
const CURVATURE_RADIUS_WORLD = 10; // matches materialContext.ts's RELIEF_CURVATURE_RADIUS_STEPS*step

interface Viewport {
  centerX: number;
  centerZ: number;
  halfSize: number;
}

export interface DebugMap {
  toggle: () => void;
  updateMarker: (worldX: number, worldZ: number, headingRadians: number) => void;
}

function distanceSq(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/**
 * A large, full-screen-ish top-down debug map. Two views: "World" (every continent at once) and
 * "Continent" (zoomed to whichever continent is nearest the player, revealing individual area
 * shapes). Each view's base image is rendered once (lazily, on first need) and cached, since a
 * full sample pass is relatively expensive; a small live marker with a heading indicator is
 * cheaply redrawn on top every frame while visible. Click anywhere on the map to teleport there.
 */
export function createDebugMap(
  sampleTerrain: TerrainSampler,
  worldExtent: number,
  continents: ContinentPlan[],
  materialLibrary: MaterialLibrary,
  onTeleport: (worldX: number, worldZ: number) => void,
): DebugMap {
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 1000; display: none;
    background: rgba(0,0,0,0.85);
    align-items: center; justify-content: center; flex-direction: column; gap: 8px;
    font-family: sans-serif; color: #eee;
  `;

  const label = document.createElement("div");
  label.textContent = "Map (M or Esc to close, click to teleport)";
  label.style.cssText = "font-size: 14px;";
  overlay.appendChild(label);

  const tabs = document.createElement("div");
  tabs.style.cssText = "display: flex; gap: 6px;";
  overlay.appendChild(tabs);

  function createTabButton(text: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.textContent = text;
    button.style.cssText = `
      font-family: sans-serif; font-size: 12px; padding: 4px 12px; border-radius: 3px;
      border: 1px solid rgba(255,255,255,0.4); background: rgba(255,255,255,0.1); color: #eee;
      cursor: pointer;
    `;
    tabs.appendChild(button);
    return button;
  }

  const worldTabButton = createTabButton("World");
  const continentTabButton = createTabButton("Continent");

  const displayCanvas = document.createElement("canvas");
  displayCanvas.width = SAMPLE_RESOLUTION;
  displayCanvas.height = SAMPLE_RESOLUTION;
  displayCanvas.style.cssText = `
    width: ${DISPLAY_SIZE_CSS}; height: ${DISPLAY_SIZE_CSS};
    border: 2px solid rgba(255,255,255,0.6); border-radius: 4px; cursor: crosshair;
  `;
  overlay.appendChild(displayCanvas);
  document.body.appendChild(overlay);

  const displayCtx = displayCanvas.getContext("2d");
  if (!displayCtx) {
    throw new Error("2D canvas context unavailable");
  }

  const baseCanvasCache = new Map<string, HTMLCanvasElement>();
  const viewportCache = new Map<string, Viewport>();

  let visible = false;
  let viewMode: "world" | "continent" = "continent";
  let markerX = 0;
  let markerZ = 0;
  let heading = 0;

  const worldViewport: Viewport = { centerX: 0, centerZ: 0, halfSize: worldExtent / 2 };

  function nearestContinent(): ContinentPlan | null {
    if (continents.length === 0) return null;
    let best = continents[0];
    let bestDistSq = distanceSq(markerX, markerZ, best.centerX, best.centerZ);
    for (const c of continents) {
      const d = distanceSq(markerX, markerZ, c.centerX, c.centerZ);
      if (d < bestDistSq) {
        bestDistSq = d;
        best = c;
      }
    }
    return best;
  }

  function continentViewKey(c: ContinentPlan): string {
    return `continent:${c.centerX},${c.centerZ}`;
  }

  function activeViewport(): Viewport {
    if (viewMode === "world") return worldViewport;
    const c = nearestContinent();
    if (!c) return worldViewport;
    const key = continentViewKey(c);
    const cached = viewportCache.get(key);
    if (cached) return cached;
    const trueRadius = c.radius / GROWTH_RADIUS_SAFETY_FACTOR;
    const viewport: Viewport = { centerX: c.centerX, centerZ: c.centerZ, halfSize: trueRadius * CONTINENT_VIEW_MARGIN };
    viewportCache.set(key, viewport);
    return viewport;
  }

  function activeViewKey(): string {
    if (viewMode === "world") return "world";
    const c = nearestContinent();
    return c ? continentViewKey(c) : "world";
  }

  /** Clamped grid lookup - reuses the one sampleTerrain pass below for every neighbor query
   *  (emboss, slope, curvature) instead of paying for fresh sampleTerrain calls per neighbor. */
  function gridHeightAt(samples: TerrainSample[], px: number, py: number): number {
    const cx = Math.min(SAMPLE_RESOLUTION - 1, Math.max(0, px));
    const cy = Math.min(SAMPLE_RESOLUTION - 1, Math.max(0, py));
    return samples[cy * SAMPLE_RESOLUTION + cx].height;
  }

  function renderBaseMap(viewport: Viewport, detailEnabled: boolean): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_RESOLUTION;
    canvas.height = SAMPLE_RESOLUTION;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");

    const imageData = ctx.createImageData(SAMPLE_RESOLUTION, SAMPLE_RESOLUTION);
    const worldStepPerPixel = (viewport.halfSize * 2) / SAMPLE_RESOLUTION;
    const curvatureRadiusPx = Math.max(1, Math.round(CURVATURE_RADIUS_WORLD / worldStepPerPixel));

    // Pass 1: sample every pixel's terrain once into a flat grid - everything below (emboss,
    // slope, slope-facing, curvature) derives from THIS grid via neighbor lookups, not fresh
    // sampleTerrain calls, so the total sample count stays exactly what it was before any of this
    // detail existed (SAMPLE_RESOLUTION^2), regardless of how many neighbors a signal needs.
    const samples: TerrainSample[] = new Array(SAMPLE_RESOLUTION * SAMPLE_RESOLUTION);
    for (let py = 0; py < SAMPLE_RESOLUTION; py++) {
      for (let px = 0; px < SAMPLE_RESOLUTION; px++) {
        const worldX = viewport.centerX + (px / SAMPLE_RESOLUTION) * viewport.halfSize * 2 - viewport.halfSize;
        const worldZ = viewport.centerZ + (py / SAMPLE_RESOLUTION) * viewport.halfSize * 2 - viewport.halfSize;
        samples[py * SAMPLE_RESOLUTION + px] = sampleTerrain(worldX, worldZ);
      }
    }

    // Pass 2: color each pixel from the grid.
    for (let py = 0; py < SAMPLE_RESOLUTION; py++) {
      for (let px = 0; px < SAMPLE_RESOLUTION; px++) {
        const sample = samples[py * SAMPLE_RESOLUTION + px];
        let color: Color3;

        if (!sample.isLand) {
          color = OCEAN_COLOR;
        } else if (sample.height < SEA_LEVEL) {
          color = LAKE_COLOR;
        } else if (detailEnabled) {
          const worldX = viewport.centerX + (px / SAMPLE_RESOLUTION) * viewport.halfSize * 2 - viewport.halfSize;
          const worldZ = viewport.centerZ + (py / SAMPLE_RESOLUTION) * viewport.halfSize * 2 - viewport.halfSize;

          // Analytic heightmap normal from a one-pixel-step gradient (mirrors the mesh's own
          // per-vertex ComputeNormals closely enough for a preview at this resolution).
          const west = gridHeightAt(samples, px - SLOPE_SAMPLE_STEP_PX, py);
          const east = gridHeightAt(samples, px + SLOPE_SAMPLE_STEP_PX, py);
          const north = gridHeightAt(samples, px, py - SLOPE_SAMPLE_STEP_PX);
          const south = gridHeightAt(samples, px, py + SLOPE_SAMPLE_STEP_PX);
          const dHdx = (east - west) / (2 * worldStepPerPixel * SLOPE_SAMPLE_STEP_PX);
          const dHdz = (south - north) / (2 * worldStepPerPixel * SLOPE_SAMPLE_STEP_PX);
          const invLen = 1 / Math.sqrt(dHdx * dHdx + dHdz * dHdz + 1);

          const farNorth = gridHeightAt(samples, px, py - curvatureRadiusPx);
          const farSouth = gridHeightAt(samples, px, py + curvatureRadiusPx);
          const farEast = gridHeightAt(samples, px + curvatureRadiusPx, py);
          const farWest = gridHeightAt(samples, px - curvatureRadiusPx, py);
          const reliefCurvature = (farNorth + farSouth + farEast + farWest) / 4 - sample.height;

          const context: Record<string, number> = {
            height: sample.height,
            slope: invLen,
            slopeFacing: dHdz * invLen,
            landmass: sample.landmass,
            lakeFactor: sample.lakeFactor,
            riverGap: sample.riverGap,
            reliefCurvature,
          };
          const materialIndex = materialLibrary.resolveMaterialIndex(worldX, worldZ, context, sample.primaryBiome.id);
          color = materialLibrary.getMaterialColor(materialIndex);
        } else {
          color = materialLibrary.getBiomeBaseColor(sample.primaryBiome.id);
        }

        let factor = 1;
        if (detailEnabled) {
          const neighborHeight = gridHeightAt(samples, px - 1, py - 1);
          const diff = sample.height - neighborHeight;
          const shade = Math.max(-1, Math.min(1, diff * EMBOSS_STRENGTH));
          factor = 1 + shade * EMBOSS_INTENSITY;
        }

        const i = (py * SAMPLE_RESOLUTION + px) * 4;
        imageData.data[i] = Math.max(0, Math.min(255, Math.round(color.r * 255 * factor)));
        imageData.data[i + 1] = Math.max(0, Math.min(255, Math.round(color.g * 255 * factor)));
        imageData.data[i + 2] = Math.max(0, Math.min(255, Math.round(color.b * 255 * factor)));
        imageData.data[i + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function getBaseCanvas(): HTMLCanvasElement {
    const key = activeViewKey();
    const cached = baseCanvasCache.get(key);
    if (cached) return cached;
    const canvas = renderBaseMap(activeViewport(), viewMode === "continent");
    baseCanvasCache.set(key, canvas);
    return canvas;
  }

  function worldToPixel(worldX: number, worldZ: number): { x: number; y: number } {
    const viewport = activeViewport();
    return {
      x: ((worldX - viewport.centerX + viewport.halfSize) / (viewport.halfSize * 2)) * SAMPLE_RESOLUTION,
      y: ((worldZ - viewport.centerZ + viewport.halfSize) / (viewport.halfSize * 2)) * SAMPLE_RESOLUTION,
    };
  }

  function pixelToWorld(fracX: number, fracZ: number): { x: number; z: number } {
    const viewport = activeViewport();
    return {
      x: viewport.centerX + fracX * viewport.halfSize * 2 - viewport.halfSize,
      z: viewport.centerZ + fracZ * viewport.halfSize * 2 - viewport.halfSize,
    };
  }

  function updateTabStyles(): void {
    worldTabButton.style.background = viewMode === "world" ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.1)";
    continentTabButton.style.background = viewMode === "continent" ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.1)";
  }

  const redraw = (): void => {
    displayCtx.drawImage(getBaseCanvas(), 0, 0);

    const { x: markerPxX, y: markerPxZ } = worldToPixel(markerX, markerZ);

    const dirX = -Math.cos(heading);
    const dirZ = -Math.sin(heading);
    displayCtx.strokeStyle = MARKER_COLOR;
    displayCtx.lineWidth = 2;
    displayCtx.beginPath();
    displayCtx.moveTo(markerPxX, markerPxZ);
    displayCtx.lineTo(markerPxX + dirX * HEADING_LENGTH_PX, markerPxZ + dirZ * HEADING_LENGTH_PX);
    displayCtx.stroke();

    displayCtx.fillStyle = MARKER_COLOR;
    displayCtx.beginPath();
    displayCtx.arc(markerPxX, markerPxZ, MARKER_RADIUS_PX, 0, Math.PI * 2);
    displayCtx.fill();
  };

  function setVisible(next: boolean): void {
    visible = next;
    overlay.style.display = visible ? "flex" : "none";
    if (visible) {
      updateTabStyles();
      redraw();
    }
  }

  function setViewMode(mode: "world" | "continent"): void {
    viewMode = mode;
    updateTabStyles();
    if (visible) redraw();
  }

  worldTabButton.addEventListener("click", () => setViewMode("world"));
  continentTabButton.addEventListener("click", () => setViewMode("continent"));

  const toggle = (): void => setVisible(!visible);

  const updateMarker = (worldX: number, worldZ: number, headingRadians: number): void => {
    markerX = worldX;
    markerZ = worldZ;
    heading = headingRadians;
    if (visible) redraw();
  };

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && visible) setVisible(false);
  });

  displayCanvas.addEventListener("click", (e) => {
    const rect = displayCanvas.getBoundingClientRect();
    const fracX = (e.clientX - rect.left) / rect.width;
    const fracZ = (e.clientY - rect.top) / rect.height;
    const { x, z } = pixelToWorld(fracX, fracZ);
    onTeleport(x, z);
    setVisible(false);
  });

  return { toggle, updateMarker };
}
