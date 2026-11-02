import type { MapTileCache } from "../map/tileCache";
import { placeMarkers, type MapMarker, type MarkerKind, type PlacedMarker } from "../map/markers";
import { drawMarkers, markerAt } from "./mapMarkers";
import { createMapView, MAX_ZOOM, MIN_ZOOM } from "./mapView";
import { BRONZE, GOLD, QUIET_PANEL, TITLE_FONT } from "./theme";

/** The ring's size, in CSS pixels. */
const SIZE = 180;
/** How far one wheel notch or button press zooms. */
const ZOOM_STEP = 1.15;
/** Redraws no more often than this (ms), however fast the frames come. */
const REDRAW_EVERY = 33;
/** And at least this often (ms) while shown, for markers that move on their own - creatures. */
const MARKERS_EVERY = 100;

/** What the minimap remembers between sessions (kept with the character, see MAP.md). */
export interface MinimapSettings {
  shown: boolean;
  zoom: number;
  /** Marker kinds the player turned on or off, by id; the rest show by their kind's default. */
  markers: Record<string, boolean>;
}

export interface Minimap {
  /** For the HUD's info region (ui/hud.ts). */
  readonly element: HTMLElement;
  /** The current dimension's tiles - null between dimensions. */
  setCache: (cache: MapTileCache | null) => void;
  /** The name under the ring - the settlement the player is in, else the zone - and its tooltip. */
  setPlace: (name: string, detail: string) => void;
  /** Where the player is and faces (radians, as the body's rotation.y), and which way the camera
   *  looks across the ground. Redraws when anything shown moved. */
  update: (x: number, z: number, facing: number, lookX: number, lookZ: number) => void;
  /** The marker kinds, and what gives the markers now - asked on every redraw (MAP.md, *Markers*). */
  setMarkers: (kinds: ReadonlyMap<string, MarkerKind>, source: () => readonly MapMarker[]) => void;
  /** Asks for a redraw on the next update: markers changed. */
  invalidate: () => void;
  /** Called by the map button and a click on the map. */
  onOpenMap: (() => void) | null;
  settings: MinimapSettings;
  /** Takes settings as kept - a character's, when it enters. */
  applySettings: (settings: MinimapSettings) => void;
  /** Called when the player changes the settings. */
  onSettings: ((settings: MinimapSettings) => void) | null;
}

/**
 * The minimap (MAP.md, *The minimap*): the map's tiles round the player in a bronze ring, north up,
 * the player an arrow in the middle; the place's name on a plate under it. Zoomed by its buttons or
 * the wheel, folded down to its plate by its toggle.
 */
export function createMinimap(): Minimap {
  const element = document.createElement("div");
  element.style.cssText = "display: flex; flex-direction: column; align-items: center; gap: 4px;";

  const ring = document.createElement("div");
  ring.style.cssText = `position: relative; width: ${SIZE}px; height: ${SIZE}px; border-radius: 50%;
    box-shadow: 0 0 0 2px #000, 0 0 0 4px ${BRONZE}, 0 0 0 5px #000, 0 4px 14px rgba(0, 0, 0, 0.7); margin: 5px;`;
  element.appendChild(ring);
  const view = createMapView("minimap", true);
  view.resize(SIZE, SIZE);
  view.canvas.style.cssText += "display: block; border-radius: 50%; cursor: pointer;";
  ring.appendChild(view.canvas);

  const north = document.createElement("div");
  north.textContent = "N";
  north.style.cssText = `position: absolute; top: -6px; left: 50%; transform: translateX(-50%); pointer-events: none;
    font: 700 11px/1 ${TITLE_FONT}; color: ${GOLD}; text-shadow: 0 0 3px #000, 0 0 2px #000;`;
  ring.appendChild(north);

  const button = (text: string, title: string, css: string, onClick: () => void): HTMLElement => {
    const b = document.createElement("div");
    b.textContent = text;
    b.title = title;
    b.style.cssText = `position: absolute; ${css} width: 20px; height: 20px; border-radius: 50%; cursor: pointer;
      display: flex; align-items: center; justify-content: center; user-select: none;
      background: radial-gradient(circle at 40% 35%, #5d4c2e, #241d12); border: 1px solid #8a6d3b; box-shadow: 0 0 0 1px #000;
      font: 700 13px/1 ${TITLE_FONT}; color: ${GOLD}; text-shadow: 0 1px 1px #000;`;
    b.addEventListener("mouseenter", () => (b.style.borderColor = GOLD));
    b.addEventListener("mouseleave", () => (b.style.borderColor = "#8a6d3b"));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };
  ring.appendChild(button("+", "Zoom in", "right: -4px; bottom: 30px;", () => zoomBy(ZOOM_STEP)));
  ring.appendChild(button("−", "Zoom out", "right: 14px; bottom: 6px;", () => zoomBy(1 / ZOOM_STEP)));
  ring.appendChild(button("M", "World map (M)", "left: -4px; bottom: 30px;", () => minimap.onOpenMap?.()));

  const plate = document.createElement("div");
  plate.style.cssText = `${QUIET_PANEL} display: flex; align-items: center; gap: 8px; padding: 3px 6px 3px 10px;
    font: 600 13px/1.3 ${TITLE_FONT}; color: ${GOLD}; letter-spacing: 0.03em; text-shadow: 0 1px 2px #000; white-space: nowrap; max-width: 220px;`;
  const name = document.createElement("span");
  name.style.cssText = "overflow: hidden; text-overflow: ellipsis;";
  name.textContent = "-";
  plate.appendChild(name);
  const fold = document.createElement("span");
  fold.title = "Hide the minimap";
  fold.style.cssText = `cursor: pointer; color: ${GOLD}; font-size: 11px; opacity: 0.8; user-select: none;`;
  fold.addEventListener("click", () => {
    minimap.settings.shown = !minimap.settings.shown;
    applyShown();
    minimap.onSettings?.(minimap.settings);
  });
  plate.appendChild(fold);
  element.appendChild(plate);

  let kinds: ReadonlyMap<string, MarkerKind> = new Map();
  let source: () => readonly MapMarker[] = () => [];
  let placed: PlacedMarker[] = [];
  let player = { x: 0, z: 0 };
  let dirty = true;
  let lastDraw = 0;
  let drawn = { x: NaN, z: NaN, facing: NaN, lookX: NaN, lookZ: NaN };

  function applyShown(): void {
    ring.style.display = minimap.settings.shown ? "" : "none";
    fold.textContent = minimap.settings.shown ? "▴" : "▾";
    fold.title = minimap.settings.shown ? "Hide the minimap" : "Show the minimap";
    dirty = true;
  }

  function zoomBy(factor: number): void {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, minimap.settings.zoom * factor));
    if (next === minimap.settings.zoom) return;
    minimap.settings.zoom = next;
    dirty = true;
    minimap.onSettings?.(minimap.settings);
  }

  view.canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  }, { passive: false });
  view.canvas.addEventListener("click", () => minimap.onOpenMap?.());
  // A marker's name under the pointer, as the canvas's tooltip.
  view.canvas.addEventListener("mousemove", (e) => {
    const rect = view.canvas.getBoundingClientRect();
    const hit = markerAt(placed, e.clientX - rect.left, e.clientY - rect.top, view.toScreen);
    const title = hit ? (hit.count > 1 ? `${hit.marker.title} (+${hit.count - 1})` : hit.marker.title || hit.kind.name) : "";
    if (view.canvas.title !== title) view.canvas.title = title;
  });

  function draw(x: number, z: number, facing: number, lookX: number, lookZ: number): void {
    const ctx = view.draw({ centerX: x, centerZ: z, zoom: minimap.settings.zoom });
    const r = SIZE / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.clip();
    player = { x, z };
    placed = placeMarkers(source(), kinds, minimap.settings.markers, view.toScreen, { round: { cx: r, cy: r, r, player }, width: SIZE, height: SIZE });
    drawMarkers(ctx, placed, view.toScreen, () => (dirty = true));
    // Where the camera looks: a faint cone.
    const look = Math.atan2(lookX, -lookZ);
    ctx.translate(r, r);
    ctx.rotate(look);
    const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.55);
    cone.addColorStop(0, "rgba(255, 240, 200, 0.28)");
    cone.addColorStop(1, "rgba(255, 240, 200, 0)");
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r * 0.55, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.rotate(-look);
    // The player: an arrow the way the body faces (its +z turned by rotation.y).
    ctx.rotate(Math.atan2(Math.sin(facing), -Math.cos(facing)));
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fillStyle = GOLD;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  const minimap: Minimap = {
    element,
    setCache(cache) {
      view.setCache(cache);
      cache?.onTile(() => (dirty = true));
      dirty = true;
    },
    setPlace(text, detail) {
      if (name.textContent !== text) name.textContent = text;
      if (plate.title !== detail) plate.title = detail;
    },
    update(x, z, facing, lookX, lookZ) {
      if (!minimap.settings.shown) return;
      const now = performance.now();
      const scale = minimap.settings.zoom * 4;
      const moved =
        dirty ||
        now - lastDraw > MARKERS_EVERY ||
        Math.hypot(x - drawn.x, z - drawn.z) * scale > 0.5 ||
        Math.abs(facing - drawn.facing) > 0.02 ||
        Math.abs(Math.atan2(lookX, lookZ) - Math.atan2(drawn.lookX, drawn.lookZ)) > 0.02;
      if (!moved || now - lastDraw < REDRAW_EVERY) return;
      lastDraw = now;
      dirty = false;
      drawn = { x, z, facing, lookX, lookZ };
      draw(x, z, facing, lookX, lookZ);
    },
    setMarkers(nextKinds, nextSource) {
      kinds = nextKinds;
      source = nextSource;
      dirty = true;
    },
    invalidate() {
      dirty = true;
    },
    onOpenMap: null,
    settings: { shown: true, zoom: MAX_ZOOM, markers: {} },
    applySettings(settings) {
      minimap.settings = { shown: settings.shown !== false, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(settings.zoom) || MAX_ZOOM)), markers: { ...settings.markers } };
      applyShown();
    },
    onSettings: null,
  };
  applyShown();
  return minimap;
}
