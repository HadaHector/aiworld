import { MAP_METRES_PER_PIXEL, MAP_TILE_METRES, mapTileAt } from "../map/tiles";
import type { MapTileCache } from "../map/tileCache";

/** What a view shows: its middle in the world, and how far in it is zoomed - 1 is one map pixel
 *  (MAP_METRES_PER_PIXEL) to a CSS pixel, 0.5 half that (MAP.md, *One resolution*). */
export interface MapFrame {
  centerX: number;
  centerZ: number;
  zoom: number;
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 1;

/** Where nothing is drawn yet: a tile still being made. */
const EMPTY = "#2a261e";

/**
 * The map's tiles drawn into a canvas for a frame, north up (+z at the top, +x to the right: the
 * world is left-handed, so that is how it lies seen from above), round or square - what
 * the minimap and the world map both are (MAP.md, *One source, two views*). Asks the tile cache for
 * the tiles it shows and a ring round them, nearest first.
 */
export interface MapView {
  readonly canvas: HTMLCanvasElement;
  setCache: (cache: MapTileCache | null) => void;
  /** Sizes the canvas to `cssSize` square CSS pixels at the screen's own pixels. */
  resize: (cssWidth: number, cssHeight: number) => void;
  /** Draws the tiles; returns the 2D context, its transform in CSS pixels, for markers on top. */
  draw: (frame: MapFrame) => CanvasRenderingContext2D;
  /** A world point's place on the canvas, in CSS pixels, for the frame last drawn. */
  toScreen: (x: number, z: number) => { x: number; y: number };
  /** The world point under a CSS pixel of the canvas, for the frame last drawn. */
  toWorld: (x: number, y: number) => { x: number; z: number };
  readonly width: number;
  readonly height: number;
}

export function createMapView(id: string, round: boolean): MapView {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  let cache: MapTileCache | null = null;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let last: MapFrame = { centerX: 0, centerZ: 0, zoom: 1 };
  /** CSS pixels to a metre, for a zoom. */
  const scaleOf = (zoom: number): number => zoom / MAP_METRES_PER_PIXEL;

  return {
    canvas,
    setCache(next) {
      cache?.want(id, []);
      cache = next;
    },
    resize(cssWidth, cssHeight) {
      dpr = window.devicePixelRatio || 1;
      width = cssWidth;
      height = cssHeight;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    },
    draw(frame) {
      last = frame;
      const scale = scaleOf(frame.zoom);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      if (round) {
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, Math.min(width, height) / 2, 0, Math.PI * 2);
        ctx.clip();
      }
      ctx.fillStyle = EMPTY;
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "medium";
      // The tiles in view, and a ring round them to have ready when the view moves on.
      const halfW = width / 2 / scale;
      const halfH = height / 2 / scale;
      const from = mapTileAt(frame.centerX - halfW, frame.centerZ - halfH);
      const to = mapTileAt(frame.centerX + halfW, frame.centerZ + halfH);
      const tileCss = MAP_TILE_METRES * scale;
      const wanted: { tx: number; tz: number; d: number }[] = [];
      for (let tz = from.tz - 1; tz <= to.tz + 1; tz++) {
        for (let tx = from.tx - 1; tx <= to.tx + 1; tx++) {
          const midX = (tx + 0.5) * MAP_TILE_METRES;
          const midZ = (tz + 0.5) * MAP_TILE_METRES;
          wanted.push({ tx, tz, d: Math.hypot(midX - frame.centerX, midZ - frame.centerZ) });
          if (tx < from.tx || tx > to.tx || tz < from.tz || tz > to.tz) continue;
          const bitmap = cache?.get(tx, tz);
          if (!bitmap) continue;
          const left = width / 2 + (tx * MAP_TILE_METRES - frame.centerX) * scale;
          // A tile's rows run from its smallest z, which is at its bottom on screen: drawn upside down.
          const bottom = height / 2 - (tz * MAP_TILE_METRES - frame.centerZ) * scale;
          ctx.save();
          ctx.translate(left, bottom);
          ctx.scale(1, -1);
          // A hair over, so neighbouring tiles leave no seam between them when scaled.
          ctx.drawImage(bitmap, 0, 0, tileCss + 0.5, tileCss + 0.5);
          ctx.restore();
        }
      }
      ctx.restore();
      wanted.sort((a, b) => a.d - b.d);
      cache?.want(id, wanted);
      return ctx;
    },
    toScreen(x, z) {
      const scale = scaleOf(last.zoom);
      return { x: width / 2 + (x - last.centerX) * scale, y: height / 2 - (z - last.centerZ) * scale };
    },
    toWorld(x, y) {
      const scale = scaleOf(last.zoom);
      return { x: last.centerX + (x - width / 2) / scale, z: last.centerZ - (y - height / 2) / scale };
    },
    get width() {
      return width;
    },
    get height() {
      return height;
    },
  };
}
