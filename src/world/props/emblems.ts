import type { Vec3 } from "../buildings/buildingGeometry";
import type { Paint } from "../buildings/buildingTypes";
import { at, type Frame, type Shaper } from "./propShapes";

/**
 * The world's own faiths' emblems (designers/cemetery-faiths.md) - a few simple marks, cut or set
 * proud on a headstone's face, a grave post's board, a lintel: readable at 20 m, a few dozen
 * triangles each. No real faith's.
 *
 * - `ringDot`: a ring with a dot in it - the lamp in the dark that shows the dead the way;
 * - `gable`: a gable's triangle - the roof the dead are kept under;
 * - `flame`: a flame of three triangles stacked, pointing up;
 * - `threeDots`: three dots in a triangle - the stones carried up to a grave;
 * - `barRing`: a ring with a bar through it - a lid weighed down on the cold dead;
 * - `waves`: two wavy lines - the water that carries the dead away.
 */
export const EMBLEMS = ["ringDot", "gable", "flame", "threeDots", "barRing", "waves"] as const;
export type Emblem = (typeof EMBLEMS)[number];

/** How far an emblem stands proud of what it is set on. */
const RELIEF = 0.025;

/**
 * An emblem `size` metres across, set on a face: `f`'s origin its middle, its x across the face, its y
 * up it, its z out of it. Built of thin bars and discs standing RELIEF proud.
 */
export function emblem(shape: Shaper, f: Frame, kind: Emblem, size: number, paint: Paint, far: boolean): void {
  const r = size / 2;
  const line = Math.max(0.03, size * 0.12);
  const bar = (x0: number, y0: number, x1: number, y1: number, width = line): void => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l = Math.hypot(dx, dy) || 1;
    // Square to it, in the face, half its width either side.
    const nx = (-dy / l) * (width / 2);
    const ny = (dx / l) * (width / 2);
    slab([[x0 + nx, y0 + ny], [x0 - nx, y0 - ny], [x1 - nx, y1 - ny], [x1 + nx, y1 + ny]]);
  };
  const disc = (cx: number, cy: number, radius: number): void => {
    const sides = far ? 5 : 8;
    slab(Array.from({ length: sides }, (_, k): [number, number] => [cx + Math.cos((k / sides) * Math.PI * 2) * radius, cy + Math.sin((k / sides) * Math.PI * 2) * radius]));
  };
  const ring = (radius: number): void => {
    const sides = far ? 6 : 10;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const b = ((k + 1) / sides) * Math.PI * 2;
      bar(Math.cos(a) * radius, Math.sin(a) * radius, Math.cos(b) * radius, Math.sin(b) * radius);
    }
  };
  const triangle = (cx: number, cy: number, w: number, h: number): void => slab([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx, cy + h / 2]]);
  // A flat piece of its outline (convex), standing RELIEF proud: its face and its edges.
  function slab(outline: [number, number][]): void {
    const front = outline.map(([x, y]) => at(f, [x, y, RELIEF]));
    const back = outline.map(([x, y]) => at(f, [x, y, 0]));
    shape.b.face(front, f.z, paint);
    if (far) return;
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length;
      const [ax, ay] = outline[i];
      const [bx, by] = outline[j];
      const l = Math.hypot(bx - ax, by - ay) || 1;
      const n: Vec3 = [f.x[0] * ((by - ay) / l) - f.y[0] * ((bx - ax) / l), f.x[1] * ((by - ay) / l) - f.y[1] * ((bx - ax) / l), f.x[2] * ((by - ay) / l) - f.y[2] * ((bx - ax) / l)];
      shape.b.face([front[i], back[i], back[j], front[j]], n, paint);
    }
  }

  switch (kind) {
    case "ringDot":
      ring(r - line / 2);
      disc(0, 0, r * 0.28);
      break;
    case "gable":
      bar(-r, -r * 0.6, 0, r * 0.75);
      bar(0, r * 0.75, r, -r * 0.6);
      bar(-r - line / 2, -r * 0.6, r + line / 2, -r * 0.6);
      break;
    case "flame":
      triangle(0, -r * 0.55, r * 1.3, r * 0.75);
      triangle(0, 0, r, r * 0.75);
      triangle(0, r * 0.55, r * 0.7, r * 0.75);
      break;
    case "threeDots":
      disc(0, r * 0.5, r * 0.26);
      disc(-r * 0.55, -r * 0.4, r * 0.26);
      disc(r * 0.55, -r * 0.4, r * 0.26);
      break;
    case "barRing":
      ring(r * 0.8 - line / 2);
      bar(-r, 0, r, 0);
      break;
    case "waves": {
      for (const y of [r * 0.3, -r * 0.3]) {
        const steps = far ? 4 : 8;
        for (let k = 0; k < steps; k++) {
          const x0 = -r + (2 * r * k) / steps;
          const x1 = -r + (2 * r * (k + 1)) / steps;
          bar(x0, y + Math.sin((k / steps) * Math.PI * 2) * r * 0.18, x1, y + Math.sin(((k + 1) / steps) * Math.PI * 2) * r * 0.18);
        }
      }
      break;
    }
  }
}
