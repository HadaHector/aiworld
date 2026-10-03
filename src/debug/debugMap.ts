import { Color3 } from "@babylonjs/core";
import type { TerrainSample, TerrainSampler } from "../world/terrain/terrainSampler";
import type { ContinentPlan } from "../world/cells/continentLayout";
import { SEA_LEVEL, type AreaBounds } from "../world/cells/areaField";
import { GROWTH_RADIUS_SAFETY_FACTOR } from "../world/cells/config";
import type { MaterialLibrary } from "../world/materials/materialLibrary";
import type { SettlementSite } from "../world/settlements/settlementSites";
import type { FeatureSite } from "../world/features/featureSites";
import type { RoadNetwork } from "../world/roads/roadNetwork";

const SAMPLE_RESOLUTION = 400; // internal sample grid, kept modest since this is a debug tool
const DISPLAY_SIZE_CSS = "min(85vw, 80vh)"; // large, centered, capped to fit the viewport
const OCEAN_COLOR = new Color3(0.09, 0.32, 0.45);
const LAKE_COLOR = new Color3(0.45, 0.68, 0.88); // lighter blue: inland water below sea level, distinct from open ocean
const MARKER_COLOR = "rgb(255, 60, 60)";
const MARKER_RADIUS_PX = 4;
const HEADING_LENGTH_PX = 14;
const CONTINENT_VIEW_MARGIN = 1.5; // margin beyond a continent's true (non-safety-inflated) radius
const ZONE_VIEW_MARGIN = 1.25; // margin beyond the zone's own footprint, so its borders stay visible
const ZONE_MIN_HALF_SIZE = 600; // a one-cell zone would otherwise zoom in past anything useful

// Zone view dims everything outside the zone the player is standing in. Without it the view is
// just "Continent, but closer" - the whole point is to see where THIS zone begins and ends, and a
// zone boundary is a blend rather than a line, so there is no outline to draw. Dimming the
// surroundings instead shows the real, jittered shape the blend produces.
const ZONE_OUTSIDE_DIM = 0.4;

// Settlement markers. Positioned as DOM elements over the canvas rather than drawn into it: the
// canvas is a SAMPLE_RESOLUTION-square image stretched to ~85vw, so anything drawn into it is
// magnified two or three times, and 9px text came out unreadably blurry. Text and a dot cost
// nothing to position in CSS and render at the screen's own resolution.
const SETTLEMENT_DOT_PX = 7;
const FEATURE_SQUARE_PX = 6;
// Names are only legible where the map is zoomed in far enough for the dots to be spread out; in
// World view the whole continent is a few dozen pixels across and every label would overlap.
const SETTLEMENT_LABEL_MIN_HALF_SIZE = 12000;

// Roads are drawn as SVG in the same layer, under the settlement markers. Vector rather than
// canvas for the same reason the labels are DOM: the canvas is a small image stretched to fill the
// screen, and a one-pixel line drawn into it comes out two or three pixels wide and soft.
const ROAD_CASING_COLOR = "rgba(0, 0, 0, 0.55)";
const ROAD_COLOR = "rgb(228, 196, 140)";
const ROAD_WIDTH_PX = 1.4;
const ROAD_CASING_WIDTH_PX = 3;

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

type ViewMode = "world" | "continent" | "zone";

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
 * A large, full-screen-ish top-down debug map. Three views: "World" (every continent at once),
 * "Continent" (zoomed to whichever continent is nearest the player, revealing individual area
 * shapes) and "Zone" (zoomed to the area the player is standing in, with everything outside it
 * dimmed). Each view's base image is rendered once (lazily, on first need) and cached, since a
 * full sample pass is relatively expensive; a small live marker with a heading indicator is
 * cheaply redrawn on top every frame while visible. Click anywhere on the map to teleport there.
 */
export function createDebugMap(
  sampleTerrain: TerrainSampler,
  worldExtent: number,
  continents: ContinentPlan[],
  materialLibrary: MaterialLibrary,
  areaBounds: Map<number, AreaBounds>,
  areaNames: Map<number, string>,
  settlements: SettlementSite[],
  features: FeatureSite[],
  roads: RoadNetwork,
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
  const BASE_LABEL = "Map (M or Esc to close, click to teleport)";
  label.textContent = BASE_LABEL;
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
  const zoneTabButton = createTabButton("Zone");

  // In its own row: this is an overlay on whichever view is showing, not a fourth view.
  const overlays = document.createElement("div");
  overlays.style.cssText = "display: flex; gap: 6px;";
  overlay.appendChild(overlays);
  function createOverlayToggle(text: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.textContent = text;
    button.style.cssText = `
      font-family: sans-serif; font-size: 12px; padding: 4px 12px; border-radius: 3px;
      border: 1px solid rgba(255,255,255,0.4); background: rgba(255,255,255,0.1); color: #eee;
      cursor: pointer;
    `;
    overlays.appendChild(button);
    return button;
  }

  const settlementToggle = createOverlayToggle(`Settlements (${settlements.length})`);
  const roadToggle = createOverlayToggle(`Roads (${roads.links.length})`);

  const displayCanvas = document.createElement("canvas");
  displayCanvas.width = SAMPLE_RESOLUTION;
  displayCanvas.height = SAMPLE_RESOLUTION;
  displayCanvas.style.cssText = `
    display: block; width: 100%; height: 100%;
    border: 2px solid rgba(255,255,255,0.6); border-radius: 4px; cursor: crosshair;
    box-sizing: border-box;
  `;
  // The canvas and the settlement markers share one positioning context, so a marker can be placed
  // as a percentage of the map and follow it at whatever size DISPLAY_SIZE_CSS resolves to.
  const mapFrame = document.createElement("div");
  mapFrame.style.cssText = `position: relative; width: ${DISPLAY_SIZE_CSS}; height: ${DISPLAY_SIZE_CSS};`;
  mapFrame.appendChild(displayCanvas);

  const markerLayer = document.createElement("div");
  // Inset by the canvas border, so a marker sits over the map image rather than over the frame.
  // Transparent to the mouse, so click-to-teleport still reaches the canvas underneath.
  markerLayer.style.cssText = "position: absolute; inset: 2px; pointer-events: none; overflow: hidden;";
  mapFrame.appendChild(markerLayer);

  overlay.appendChild(mapFrame);
  document.body.appendChild(overlay);

  const displayCtx = displayCanvas.getContext("2d");
  if (!displayCtx) {
    throw new Error("2D canvas context unavailable");
  }

  const baseCanvasCache = new Map<string, HTMLCanvasElement>();
  const viewportCache = new Map<string, Viewport>();

  let visible = false;
  let viewMode: ViewMode = "continent";
  // Which zone the Zone view is framed on. Held rather than recomputed per redraw so that walking
  // across a border does not re-frame and re-render the map underneath the player mid-look; it is
  // refreshed when the view is opened or switched to.
  let zoneAreaId = -1;
  let showSettlements = true;
  let showRoads = true;
  let markerX = 0;
  let markerZ = 0;
  let heading = 0;

  const worldViewport: Viewport = { centerX: 0, centerZ: 0, halfSize: worldExtent / 2 };

  /** One extra terrain sample, only when the Zone view is opened or switched to. */
  function areaIdAtMarker(): number {
    return sampleTerrain(markerX, markerZ).primaryAreaId;
  }

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

  function zoneViewport(areaId: number): Viewport | null {
    const bounds = areaBounds.get(areaId);
    if (!bounds) return null;
    const halfSize = Math.max(
      ZONE_MIN_HALF_SIZE,
      (Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2) * ZONE_VIEW_MARGIN,
    );
    return { centerX: (bounds.minX + bounds.maxX) / 2, centerZ: (bounds.minZ + bounds.maxZ) / 2, halfSize };
  }

  function activeViewport(): Viewport {
    if (viewMode === "zone") {
      const key = `zone:${zoneAreaId}`;
      const cached = viewportCache.get(key);
      if (cached) return cached;
      const viewport = zoneViewport(zoneAreaId);
      // No zone here (standing at sea) - fall through to the continent framing rather than
      // showing nothing.
      if (!viewport) return continentViewport();
      viewportCache.set(key, viewport);
      return viewport;
    }
    if (viewMode === "world") return worldViewport;
    return continentViewport();
  }

  function continentViewport(): Viewport {
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
    if (viewMode === "zone") return areaBounds.has(zoneAreaId) ? `zone:${zoneAreaId}` : continentViewKey2();
    if (viewMode === "world") return "world";
    return continentViewKey2();
  }

  function continentViewKey2(): string {
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

  function renderBaseMap(viewport: Viewport, detailEnabled: boolean, focusAreaId: number): HTMLCanvasElement {
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
            roadGap: sample.roadGap,
            featureKind: sample.featureKind,
            featureGap: sample.featureGap,
            featureDepth: sample.featureDepth,
            reliefCurvature,
          };
          const materialIndex = materialLibrary.resolveMaterialIndex(worldX, worldZ, context, sample.primaryBiome);
          color = materialLibrary.getMaterialColor(materialIndex);
        } else {
          color = materialLibrary.getBiomeBaseColor(sample.primaryBiome);
        }

        let factor = 1;
        // Outside the focused zone - dimmed so the zone's own shape reads. Applied before emboss
        // so relief still shows through in the surroundings rather than flattening them.
        if (focusAreaId !== -1 && sample.primaryAreaId !== focusAreaId) factor *= ZONE_OUTSIDE_DIM;
        if (detailEnabled) {
          const neighborHeight = gridHeightAt(samples, px - 1, py - 1);
          const diff = sample.height - neighborHeight;
          const shade = Math.max(-1, Math.min(1, diff * EMBOSS_STRENGTH));
          factor *= 1 + shade * EMBOSS_INTENSITY;
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
    // Detail is off only in World view, where a pixel spans thousands of world units - see the
    // note on SLOPE_SAMPLE_STEP_PX. Zone view is closer still than Continent, so it always wants it.
    const canvas = renderBaseMap(activeViewport(), viewMode !== "world", viewMode === "zone" ? zoneAreaId : -1);
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
    const highlight = (button: HTMLButtonElement, active: boolean): void => {
      button.style.background = active ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.1)";
    };
    highlight(worldTabButton, viewMode === "world");
    highlight(continentTabButton, viewMode === "continent");
    highlight(zoneTabButton, viewMode === "zone");
    settlementToggle.style.background = showSettlements ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.1)";
    roadToggle.style.background = showRoads ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.1)";
  }

  /** Every road in frame as one SVG path, cased in dark so a pale line stays legible over sand and
   *  over snow alike. One path for the lot: 266 links is a few thousand points, and a path element
   *  each would be that many more nodes for the browser to lay out on every redraw. */
  const drawRoads = (): SVGSVGElement | null => {
    if (!showRoads) return null;
    const viewport = activeViewport();
    let d = "";

    for (const link of roads.links) {
      // Cheap reject on the link's own extent, so a zoomed-in view does not walk the whole world's
      // points to draw the handful that are visible.
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const point of link.points) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.z < minZ) minZ = point.z;
        if (point.z > maxZ) maxZ = point.z;
      }
      if (
        maxX < viewport.centerX - viewport.halfSize ||
        minX > viewport.centerX + viewport.halfSize ||
        maxZ < viewport.centerZ - viewport.halfSize ||
        minZ > viewport.centerZ + viewport.halfSize
      ) {
        continue;
      }

      link.points.forEach((point, index) => {
        const { x, y } = worldToPixel(point.x, point.z);
        d += `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      });
    }
    if (d === "") return null;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${SAMPLE_RESOLUTION} ${SAMPLE_RESOLUTION}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.cssText = "position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible;";

    for (const [color, width] of [
      [ROAD_CASING_COLOR, ROAD_CASING_WIDTH_PX],
      [ROAD_COLOR, ROAD_WIDTH_PX],
    ] as [string, number][]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", String(width));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      // Widths stay in screen pixels however far the viewBox is stretched, which is also what
      // keeps a road the same weight in every view.
      path.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(path);
    }
    return svg;
  };

  /** The whole overlay layer: roads underneath, then a dot for every settlement in frame, with
   *  names once the view is close enough to read them. Rebuilt wholesale on each redraw - a few
   *  hundred elements is nothing, and diffing against the previous view would be more code than it
   *  saves. */
  const drawOverlays = (): void => {
    markerLayer.replaceChildren();
    const roadLayer = drawRoads();
    if (roadLayer) markerLayer.appendChild(roadLayer);
    if (!showSettlements) return;

    const viewport = activeViewport();
    const labelled = viewport.halfSize <= SETTLEMENT_LABEL_MIN_HALF_SIZE;

    // Features as small grey squares, under the settlements' dots, named by kind when close.
    for (const feature of features) {
      // Settlements have their own dots.
      if (feature.settlement) continue;
      const { x, y } = worldToPixel(feature.x, feature.z);
      if (x < 0 || y < 0 || x > SAMPLE_RESOLUTION || y > SAMPLE_RESOLUTION) continue;
      const left = `${(x / SAMPLE_RESOLUTION) * 100}%`;
      const top = `${(y / SAMPLE_RESOLUTION) * 100}%`;
      const square = document.createElement("div");
      square.title = `${feature.kind.name} #${feature.id}`;
      square.style.cssText = `
        position: absolute; left: ${left}; top: ${top};
        width: ${FEATURE_SQUARE_PX}px; height: ${FEATURE_SQUARE_PX}px; margin: ${-FEATURE_SQUARE_PX / 2}px 0 0 ${-FEATURE_SQUARE_PX / 2}px;
        background: rgb(200, 200, 205); border: 1px solid rgba(0,0,0,0.75); box-sizing: border-box;
      `;
      markerLayer.appendChild(square);
      if (!labelled) continue;
      const name = document.createElement("div");
      name.textContent = feature.kind.name;
      name.style.cssText = `
        position: absolute; left: ${left}; top: ${top};
        transform: translate(-50%, 0); margin-top: ${FEATURE_SQUARE_PX}px;
        font-family: sans-serif; font-size: 10px; line-height: 1; white-space: nowrap;
        color: rgb(225, 225, 230);
        text-shadow: 0 0 3px #000, 0 0 3px #000, 1px 1px 2px #000;
      `;
      markerLayer.appendChild(name);
    }

    for (const site of settlements) {
      const { x, y } = worldToPixel(site.x, site.z);
      if (x < 0 || y < 0 || x > SAMPLE_RESOLUTION || y > SAMPLE_RESOLUTION) continue;
      const left = `${(x / SAMPLE_RESOLUTION) * 100}%`;
      const top = `${(y / SAMPLE_RESOLUTION) * 100}%`;

      const dot = document.createElement("div");
      dot.style.cssText = `
        position: absolute; left: ${left}; top: ${top};
        width: ${SETTLEMENT_DOT_PX}px; height: ${SETTLEMENT_DOT_PX}px; margin: ${-SETTLEMENT_DOT_PX / 2}px 0 0 ${-SETTLEMENT_DOT_PX / 2}px;
        border-radius: 50%; background: rgb(250, 230, 150); border: 1px solid rgba(0,0,0,0.75);
        box-sizing: border-box;
      `;
      markerLayer.appendChild(dot);

      if (!labelled) continue;
      const name = document.createElement("div");
      name.textContent = site.name;
      // Outlined rather than boxed: a settlement sits on land of every possible colour, and a
      // filled label plate would hide the terrain the placement is meant to be judged against.
      name.style.cssText = `
        position: absolute; left: ${left}; top: ${top};
        transform: translate(-50%, -100%); margin-top: ${-SETTLEMENT_DOT_PX}px;
        font-family: sans-serif; font-size: 11px; line-height: 1; white-space: nowrap;
        color: rgb(252, 240, 190);
        text-shadow: 0 0 3px #000, 0 0 3px #000, 1px 1px 2px #000;
      `;
      markerLayer.appendChild(name);
    }
  };

  const redraw = (): void => {
    // Named here rather than in the tab row: the Zone view is the only one framed on something with
    // a name, and it is the one where "which of the 66 is this" is the actual question.
    const zoneName = viewMode === "zone" ? areaNames.get(zoneAreaId) : undefined;
    label.textContent = zoneName ? `${BASE_LABEL}  -  ${zoneName}` : BASE_LABEL;

    displayCtx.drawImage(getBaseCanvas(), 0, 0);
    drawOverlays();

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
      if (viewMode === "zone") zoneAreaId = areaIdAtMarker();
      updateTabStyles();
      redraw();
    }
  }

  function setViewMode(mode: ViewMode): void {
    viewMode = mode;
    if (mode === "zone") zoneAreaId = areaIdAtMarker();
    updateTabStyles();
    if (visible) redraw();
  }

  worldTabButton.addEventListener("click", () => setViewMode("world"));
  continentTabButton.addEventListener("click", () => setViewMode("continent"));
  zoneTabButton.addEventListener("click", () => setViewMode("zone"));
  settlementToggle.addEventListener("click", () => {
    showSettlements = !showSettlements;
    updateTabStyles();
    if (visible) redraw();
  });
  roadToggle.addEventListener("click", () => {
    showRoads = !showRoads;
    updateTabStyles();
    if (visible) redraw();
  });

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
