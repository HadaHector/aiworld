import type { MapTileCache } from "../map/tileCache";
import { kindShown, placeMarkers, type MapMarker, type MarkerKind, type PlacedMarker } from "../map/markers";
import { MAP_METRES_PER_PIXEL } from "../map/tiles";
import { createMapView, MAX_ZOOM, MIN_ZOOM } from "./mapView";
import { drawMarkers, markerAt } from "./mapMarkers";
import { BUTTON_CLASS, DIM, GOLD, PANEL, TEXT, windowHead } from "./theme";

const ZOOM_STEP = 1.15;
const REDRAW_EVERY = 33;

export interface WorldMap {
  readonly element: HTMLElement;
  readonly visible: boolean;
  toggle: () => void;
  setCache: (cache: MapTileCache | null) => void;
  setMarkers: (kinds: ReadonlyMap<string, MarkerKind>, source: () => readonly MapMarker[]) => void;
  /** What the window's title says about a point - the zone there and its level band - and its colour. */
  setDescribe: (describe: (x: number, z: number) => { text: string; colour: string }) => void;
  /** Where the player is and faces; follows them until the map is dragged. */
  update: (x: number, z: number, facing: number) => void;
  /** Opens it centred on the player. */
  open: () => void;
  /** Marker kinds the player turned on or off here, apart from the minimap's (MAP.md). */
  choices: Record<string, boolean>;
  onChoices: ((choices: Record<string, boolean>) => void) | null;
  dispose: () => void;
}

/**
 * The world map (MAP.md, *The world map*): the minimap's tiles in a large window, square, at the same
 * 1x to 0.5x - dragged to look anywhere in the dimension, zoomed with the wheel, centred on the
 * player again by a button - with the zone in view and its levels in the title, the markers, and a
 * legend that turns each kind on or off.
 */
export function createWorldMap(): WorldMap {
  const root = document.createElement("div");
  root.style.cssText = `${PANEL} position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 948;
    padding: 8px 10px; display: none; flex-direction: column; gap: 6px;`;
  const { title } = windowHead(root, "Map", () => map.toggle());
  title.style.cssText = "white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
  document.body.appendChild(root);

  const view = createMapView("worldMap", false);
  view.canvas.style.cssText += `display: block; cursor: grab; border: 1px solid #000; box-shadow: 0 0 0 1px ${"#7a6235"};`;
  root.appendChild(view.canvas);

  const bar = document.createElement("div");
  bar.style.cssText = `display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; color: ${TEXT}; font-size: 11px;`;
  root.appendChild(bar);
  const centre = document.createElement("button");
  centre.className = BUTTON_CLASS;
  centre.textContent = "Centre";
  centre.title = "Back to where you are";
  centre.addEventListener("click", () => {
    following = true;
    dirty = true;
  });
  const legend = document.createElement("div");
  legend.style.cssText = "display: flex; flex-wrap: wrap; gap: 4px 10px; flex: 1;";
  bar.append(centre, legend);

  let kinds: ReadonlyMap<string, MarkerKind> = new Map();
  let source: () => readonly MapMarker[] = () => [];
  let describe: (x: number, z: number) => { text: string; colour: string } = () => ({ text: "Map", colour: GOLD });
  let placed: PlacedMarker[] = [];
  let visible = false;
  let following = true;
  let dirty = true;
  let lastDraw = 0;
  let zoom = MAX_ZOOM;
  let centreX = 0;
  let centreZ = 0;
  let player = { x: 0, z: 0, facing: 0 };

  function size(): void {
    const w = Math.max(320, Math.min(window.innerWidth - 80, 1100));
    const h = Math.max(240, Math.min(window.innerHeight - 160, 800));
    if (w !== view.width || h !== view.height) view.resize(w, h);
    dirty = true;
  }

  function drawLegend(): void {
    legend.replaceChildren();
    for (const kind of [...kinds.values()].filter((k) => k.worldMap).sort((a, b) => b.priority - a.priority)) {
      const item = document.createElement("label");
      item.style.cssText = `display: flex; align-items: center; gap: 4px; cursor: pointer; color: ${kindShown(kind, map.choices) ? TEXT : DIM};`;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = kindShown(kind, map.choices);
      box.addEventListener("change", () => {
        map.choices[kind.id] = box.checked;
        map.onChoices?.(map.choices);
        dirty = true;
        drawLegend();
      });
      const swatch = document.createElement("span");
      swatch.textContent = kind.shape === "icon" ? kind.glyph : kind.shape === "label" ? "Aa" : "●";
      swatch.style.cssText = `color: ${kind.colour}; font-weight: 700; text-shadow: 0 0 2px #000; min-width: 12px; text-align: center;`;
      item.append(box, swatch, document.createTextNode(kind.name));
      legend.appendChild(item);
    }
  }

  function draw(): void {
    if (following) {
      centreX = player.x;
      centreZ = player.z;
    }
    const ctx = view.draw({ centerX: centreX, centerZ: centreZ, zoom });
    placed = placeMarkers(source(), kinds, map.choices, view.toScreen, { round: null, width: view.width, height: view.height });
    drawMarkers(ctx, placed, view.toScreen, () => (dirty = true));
    const at = view.toScreen(player.x, player.z);
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(player.facing);
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fillStyle = GOLD;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    const about = describe(centreX, centreZ);
    if (title.textContent !== about.text) title.textContent = about.text;
    title.style.color = about.colour;
  }

  // Dragging pans; a drag of a few pixels or more is not a click.
  let drag: { x: number; y: number; cx: number; cz: number } | null = null;
  view.canvas.addEventListener("mousedown", (e) => {
    drag = { x: e.clientX, y: e.clientY, cx: centreX, cz: centreZ };
    view.canvas.style.cursor = "grabbing";
    e.preventDefault();
  });
  const onMove = (e: MouseEvent): void => {
    if (drag) {
      const scale = zoom / MAP_METRES_PER_PIXEL;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) following = false;
      centreX = drag.cx - (e.clientX - drag.x) / scale;
      centreZ = drag.cz + (e.clientY - drag.y) / scale;
      dirty = true;
      return;
    }
    if (e.target !== view.canvas) return;
    const rect = view.canvas.getBoundingClientRect();
    const hit = markerAt(placed, e.clientX - rect.left, e.clientY - rect.top, view.toScreen);
    const tip = hit ? (hit.count > 1 ? `${hit.marker.title} (+${hit.count - 1})` : hit.marker.title || hit.kind.name) : "";
    if (view.canvas.title !== tip) view.canvas.title = tip;
  };
  const onUp = (): void => {
    drag = null;
    view.canvas.style.cursor = "grab";
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("resize", size);
  view.canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
    if (next === zoom) return;
    // Zoomed about the point under the pointer, so it stays under it.
    const rect = view.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const before = view.toWorld(px, py);
    zoom = next;
    const scale = zoom / MAP_METRES_PER_PIXEL;
    centreX = before.x - (px - view.width / 2) / scale;
    centreZ = before.z + (py - view.height / 2) / scale;
    following = false;
    dirty = true;
  }, { passive: false });

  const map: WorldMap = {
    element: root,
    get visible() {
      return visible;
    },
    toggle() {
      if (visible) {
        visible = false;
        root.style.display = "none";
      } else map.open();
    },
    open() {
      visible = true;
      following = true;
      root.style.display = "flex";
      size();
      drawLegend();
      draw();
    },
    setCache(cache) {
      view.setCache(cache);
      cache?.onTile(() => (dirty = true));
      dirty = true;
    },
    setMarkers(nextKinds, nextSource) {
      kinds = nextKinds;
      source = nextSource;
      if (visible) drawLegend();
      dirty = true;
    },
    setDescribe(next) {
      describe = next;
    },
    update(x, z, facing) {
      if (!visible) return;
      const moved = player.x !== x || player.z !== z || player.facing !== facing;
      player = { x, z, facing };
      const now = performance.now();
      if (!(dirty || moved || now - lastDraw > 250) || now - lastDraw < REDRAW_EVERY) return;
      lastDraw = now;
      dirty = false;
      draw();
    },
    choices: {},
    onChoices: null,
    dispose() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("resize", size);
      view.setCache(null);
      root.remove();
    },
  };
  return map;
}
