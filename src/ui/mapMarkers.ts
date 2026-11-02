import { areaPixels, type PlacedMarker } from "../map/markers";
import { iconCell } from "./icons";
import { TITLE_FONT } from "./theme";

/** Atlases by URL, loading or loaded; `onLoad` asks for a redraw when one arrives. */
const atlases = new Map<string, HTMLImageElement>();
function atlas(url: string, onLoad: () => void): HTMLImageElement | null {
  let image = atlases.get(url);
  if (!image) {
    image = new Image();
    image.src = url;
    image.addEventListener("load", onLoad, { once: true });
    atlases.set(url, image);
  }
  return image.complete && image.naturalWidth > 0 ? image : null;
}

/**
 * Draws placed markers (map/markers.ts) into a map view's canvas: areas as soft circles, dots, icons
 * from their atlas or their glyph in their colour, names, a count on a cluster, and those pinned to
 * the ring as a small arrow pointing out.
 */
export function drawMarkers(ctx: CanvasRenderingContext2D, placed: readonly PlacedMarker[], toScreen: (x: number, z: number) => { x: number; y: number }, onLoad: () => void): void {
  for (const p of placed) {
    const { kind } = p;
    ctx.save();
    if (p.edge !== null) {
      ctx.translate(p.x, p.y);
      ctx.rotate(p.edge);
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(5, 3);
      ctx.lineTo(-5, 3);
      ctx.closePath();
      ctx.fillStyle = kind.colour;
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      continue;
    }
    if (kind.shape === "area") {
      const r = Math.max(kind.size / 2, areaPixels(p.marker, toScreen));
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = kind.colour;
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = kind.colour;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    } else if (kind.shape === "dot") {
      ctx.beginPath();
      ctx.arc(p.x, p.y, kind.size / 2, 0, Math.PI * 2);
      ctx.fillStyle = kind.colour;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    } else if (kind.shape === "label") {
      ctx.font = `600 ${kind.size}px ${TITLE_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      // Over its point rather than on it, so it does not hide what stands there.
      const y = p.y - kind.size * 1.6;
      ctx.strokeText(p.marker.title, p.x, y);
      ctx.fillStyle = kind.colour;
      ctx.fillText(p.marker.title, p.x, y);
    } else {
      const cell = kind.icon ? iconCell(kind.icon) : null;
      const image = cell ? atlas(cell.url, onLoad) : null;
      if (cell && image) {
        const w = image.naturalWidth / cell.columns;
        const h = image.naturalHeight / cell.rows;
        ctx.drawImage(image, cell.column * w, cell.row * h, w, h, p.x - kind.size / 2, p.y - kind.size / 2, kind.size, kind.size);
      } else {
        ctx.font = `700 ${kind.size}px ${TITLE_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#000";
        ctx.strokeText(kind.glyph, p.x, p.y);
        ctx.fillStyle = kind.colour;
        ctx.fillText(kind.glyph, p.x, p.y);
      }
    }
    if (p.count > 1) {
      ctx.font = `700 9px sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#000";
      ctx.strokeText(String(p.count), p.x + kind.size / 3, p.y);
      ctx.fillStyle = "#fff";
      ctx.fillText(String(p.count), p.x + kind.size / 3, p.y);
    }
    ctx.restore();
  }
}

/** The topmost marker under a CSS pixel, for a tooltip - an area counts anywhere inside it. */
export function markerAt(placed: readonly PlacedMarker[], x: number, y: number, toScreen: (x: number, z: number) => { x: number; y: number }): PlacedMarker | null {
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    const reach = p.kind.shape === "area" && p.edge === null ? Math.max(p.kind.size / 2, areaPixels(p.marker, toScreen)) : Math.max(6, p.kind.size / 2);
    if (Math.hypot(p.x - x, p.y - y) <= reach) return p;
  }
  return null;
}
