import type { BiomeArea } from "./biomeArea";
import type { TextureImage } from "./textureView";
import type { TreePlacement } from "../world/foliage/treeScatter";

/**
 * The workbench's 2D views of a biome area (see biomeArea.ts): each an image and a legend - what the
 * colours are, and the area's numbers. Every view is shaded by the ground's relief and, with `water`,
 * shows what is under the water blue, so it can be read as a map.
 */
export interface MapView {
  image: TextureImage;
  legend: HTMLElement;
}

export type Rgb = [number, number, number];

/** Categorical colours, told apart at a glance - materials and plant kinds take them in order. */
const PALETTE: Rgb[] = [
  [0.89, 0.42, 0.27],
  [0.3, 0.6, 0.86],
  [0.95, 0.77, 0.24],
  [0.45, 0.75, 0.37],
  [0.68, 0.45, 0.82],
  [0.35, 0.82, 0.78],
  [0.92, 0.5, 0.66],
  [0.62, 0.5, 0.33],
  [0.78, 0.84, 0.36],
  [0.55, 0.58, 0.64],
  [0.95, 0.62, 0.38],
  [0.38, 0.42, 0.78],
];

export function paletteColor(i: number): Rgb {
  return PALETTE[i % PALETTE.length];
}

const SHALLOW: Rgb = [0.36, 0.56, 0.7];
const DEEP: Rgb = [0.08, 0.2, 0.36];

/** The blue of water `depth` metres deep, deepest by three metres. */
function waterColor(depth: number): Rgb {
  const t = Math.min(1, depth / 3);
  return [0, 1, 2].map((c) => SHALLOW[c] + (DEEP[c] - SHALLOW[c]) * t) as Rgb;
}

/** Relief shading as a brightness factor - flat ground about 1. */
function relief(area: BiomeArea, i: number): number {
  return 0.55 + 0.6 * area.shade[i];
}

function percent(share: number): string {
  return `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
}

/** Writes an image of the area, one pixel a grid point, from each point's colour (0-1). */
function paint(area: BiomeArea, colorAt: (i: number) => Rgb, describe: (i: number) => string): TextureImage {
  const { size } = area;
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const rgb = colorAt(i);
    pixels[i * 4] = Math.round(255 * Math.min(1, Math.max(0, rgb[0])));
    pixels[i * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0, rgb[1])));
    pixels[i * 4 + 2] = Math.round(255 * Math.min(1, Math.max(0, rgb[2])));
    pixels[i * 4 + 3] = 255;
  }
  return { width: size, height: size, pixels, tiles: 1, describe: (x, y) => describe(y * size + x) };
}

/** What every view says of a point under the cursor: where it is, how high, how steep, what of. */
function describePoint(area: BiomeArea, i: number): string {
  const { size, step } = area;
  const x = area.minX + (i % size) * step;
  const z = area.maxZ - Math.floor(i / size) * step;
  const top = area.materials
    .map((material, m) => [material.id, area.blend[i * area.materials.length + m]] as const)
    .filter(([, w]) => w > 0.02)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, w]) => `${id} ${percent(w)}`)
    .join(", ");
  const degrees = (Math.asin(Math.min(1, area.slopes[i])) * 180) / Math.PI;
  return `x ${x.toFixed(0)} z ${z.toFixed(0)}  height ${area.heights[i].toFixed(2)}  slope ${degrees.toFixed(0)}°  ${top}`;
}

// ---------------------------------------------------------------------------------------------
// The legend

function legendBox(title: string): HTMLElement {
  const box = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = title;
  box.append(heading);
  return box;
}

function addTable(box: HTMLElement, rows: (string | [Rgb | null, ...string[]])[][]): void {
  const table = document.createElement("table");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      if (Array.isArray(cell)) {
        const [swatch, ...text] = cell;
        if (swatch) {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.style.background = `rgb(${swatch.map((c) => Math.round(c * 255)).join(",")})`;
          td.append(chip);
        }
        td.append(text.join(" "));
      } else {
        td.textContent = cell;
      }
      tr.append(td);
    }
    table.append(tr);
  }
  box.append(table);
}

function quantile(values: Float32Array, q: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

/** The numbers every view shows: how big the area is, how high and how wet. */
function addAreaStats(box: HTMLElement, area: BiomeArea): void {
  const count = area.heights.length;
  let wet = 0;
  let steep = 0;
  for (let i = 0; i < count; i++) {
    if (area.heights[i] < 0) wet++;
    if (area.slopes[i] > 0.5) steep++;
  }
  const extent = area.step * (area.size - 1);
  addTable(box, [
    ["area", `${extent.toFixed(0)} m, a point every ${area.step.toFixed(1)} m`],
    ["height", `${quantile(area.heights, 0).toFixed(1)} … ${quantile(area.heights, 0.5).toFixed(1)} … ${quantile(area.heights, 1).toFixed(1)} m`],
    ["p5 / p95", `${quantile(area.heights, 0.05).toFixed(1)} / ${quantile(area.heights, 0.95).toFixed(1)} m`],
    ["under water", percent(wet / count)],
    ["steeper than 30°", percent(steep / count)],
  ]);
}

// ---------------------------------------------------------------------------------------------
// Views

/** Height: water blue by depth, land in a ramp from its lowest to its highest, contour lines at an
 *  interval that gives a dozen or so of them. */
export function heightView(area: BiomeArea): MapView {
  const { heights, size } = area;
  let top = 0;
  for (const h of heights) top = Math.max(top, h);
  const range = Math.max(0.5, top - Math.min(0, quantile(heights, 0)));
  const interval = [0.25, 0.5, 1, 2, 5, 10, 20, 50].find((n) => range / n <= 14) ?? 100;
  const ramp: [number, Rgb][] = [
    [0, [0.36, 0.5, 0.3]],
    [0.35, [0.62, 0.6, 0.38]],
    [0.7, [0.55, 0.42, 0.3]],
    [1, [0.92, 0.92, 0.92]],
  ];
  const land = (t: number): Rgb => {
    for (let k = 1; k < ramp.length; k++) {
      if (t <= ramp[k][0]) {
        const f = (t - ramp[k - 1][0]) / (ramp[k][0] - ramp[k - 1][0]);
        return [0, 1, 2].map((c) => ramp[k - 1][1][c] + (ramp[k][1][c] - ramp[k - 1][1][c]) * f) as Rgb;
      }
    }
    return ramp[ramp.length - 1][1];
  };
  const band = (h: number): number => Math.floor(h / interval);
  const image = paint(
    area,
    (i) => {
      const h = heights[i];
      const base = h < 0 ? waterColor(-h) : land(Math.min(1, h / Math.max(0.5, top)));
      const r = Math.floor(i / size);
      const c = i % size;
      const line = (c + 1 < size && band(heights[i + 1]) !== band(h)) || (r + 1 < size && band(heights[i + size]) !== band(h));
      const shading = h < 0 ? 1 : relief(area, i);
      return base.map((v) => v * shading * (line ? 0.7 : 1)) as Rgb;
    },
    (i) => describePoint(area, i),
  );
  const legend = legendBox("Height");
  addTable(legend, [
    [[waterColor(0.2), "water, shallow"]],
    [[waterColor(3), "water, 3 m and deeper"]],
    [[land(0), "land at the water"]],
    [[land(1), `land at ${top.toFixed(1)} m`]],
    ["contours", `every ${interval} m`],
  ]);
  addAreaStats(legend, area);
  return { image, legend };
}

/**
 * Materials: each point the blend of its materials' colours, by weight - their own average colours
 * (`colors`, as the ground draws them) or a categorical colour each - or, with `only`, one
 * material's weight alone. The legend lists every material with its share of the area (its mean
 * weight) and where it is the strongest.
 */
export function materialsView(area: BiomeArea, colors: Rgb[] | null, only: string, water: boolean): MapView {
  const k = area.materials.length;
  const count = area.heights.length;
  const share = new Float64Array(k);
  const leads = new Float64Array(k);
  for (let i = 0; i < count; i++) {
    let best = 0;
    for (let m = 0; m < k; m++) {
      const w = area.blend[i * k + m];
      share[m] += w;
      if (w > area.blend[i * k + best]) best = m;
    }
    leads[best]++;
  }
  const colorOf = (m: number): Rgb => colors?.[m] ?? paletteColor(m);
  const floats = area.materials.map((material) => material.floats);
  const onlyIndex = area.materials.findIndex((material) => material.id === only);
  const image = paint(
    area,
    (i) => {
      let rgb: Rgb;
      if (onlyIndex >= 0) {
        const w = area.blend[i * k + onlyIndex];
        rgb = [w, w, w];
      } else {
        // The bed and what floats on the water apart: a floating material is no part of the bed,
        // and shows on the surface where it covers more than half of it (as the game draws it).
        const bed: Rgb = [0, 0, 0];
        const floating: Rgb = [0, 0, 0];
        let bedWeight = 0;
        let floatWeight = 0;
        for (let m = 0; m < k; m++) {
          const w = area.blend[i * k + m];
          if (w <= 0) continue;
          const c = colorOf(m);
          const into = floats[m] ? floating : bed;
          into[0] += c[0] * w;
          into[1] += c[1] * w;
          into[2] += c[2] * w;
          if (floats[m]) floatWeight += w;
          else bedWeight += w;
        }
        const h = area.heights[i];
        rgb = bed.map((v) => (v / Math.max(bedWeight, 1e-4)) * relief(area, i)) as Rgb;
        if (water && h < 0) {
          const blue = waterColor(-h);
          const t = 0.25 + 0.35 * Math.min(1, -h / 3);
          rgb = rgb.map((v, c) => v + (blue[c] - v) * t) as Rgb;
        }
        if (h < 0 && floatWeight > 0.5) rgb = floating.map((v) => v / floatWeight) as Rgb;
        return rgb;
      }
      const h = area.heights[i];
      rgb = rgb.map((v) => v * relief(area, i)) as Rgb;
      if (water && h < 0) {
        const blue = waterColor(-h);
        const t = 0.25 + 0.35 * Math.min(1, -h / 3);
        rgb = rgb.map((v, c) => v + (blue[c] - v) * t) as Rgb;
      }
      return rgb;
    },
    (i) => describePoint(area, i),
  );
  const legend = legendBox(onlyIndex >= 0 ? `Material: ${only}` : "Materials");
  const order = [...area.materials.keys()].sort((a, b) => share[b] - share[a]);
  addTable(legend, [
    ["", "share", "strongest"],
    ...order.map((m) => [[colorOf(m), area.materials[m].id] as [Rgb, string], percent(share[m] / count), percent(leads[m] / count)]),
  ]);
  addAreaStats(legend, area);
  return { image, legend };
}

/** One of the biome's ground layers: its raw weight (before it shares out against the others),
 *  black at 0, full yellow at 1, red past it - layers are often weighted past 1 to win. */
export function layerView(area: BiomeArea, layerId: string, water: boolean): MapView {
  const layer = area.layers.find((l) => l.id === layerId) ?? area.layers[0];
  const legend = legendBox(layer ? `Layer: ${layer.id}` : "Layers");
  if (!layer) {
    legend.append("This biome has no ground layers of its own.");
    return { image: paint(area, (i) => [relief(area, i) * 0.4, relief(area, i) * 0.4, relief(area, i) * 0.4], (i) => describePoint(area, i)), legend };
  }
  const { weights } = layer;
  let max = 0;
  let sum = 0;
  let some = 0;
  let full = 0;
  for (const w of weights) {
    max = Math.max(max, w);
    sum += w;
    if (w > 0.05) some++;
    if (w >= 1) full++;
  }
  const image = paint(
    area,
    (i) => {
      const w = weights[i];
      let rgb: Rgb = w <= 1 ? [w, w * 0.85, w * 0.2] : [1, Math.max(0.2, 0.85 - (w - 1) * 0.3), 0.2 * Math.max(0, 1 - (w - 1))];
      const dim = 0.12 * relief(area, i);
      rgb = rgb.map((v) => v + dim) as Rgb;
      const h = area.heights[i];
      if (water && h < 0) rgb = rgb.map((v, c) => v + (waterColor(-h)[c] - v) * 0.35) as Rgb;
      return rgb;
    },
    (i) => `${describePoint(area, i)}  ${layer.id} ${weights[i].toFixed(2)}`,
  );
  const count = weights.length;
  addTable(legend, [
    ["material", layer.materialId],
    [[[0.5, 0.42, 0.1], "weight 0.5"]],
    [[[1, 0.85, 0.2], "weight 1"]],
    [[[1, 0.25, 0.1], "weight 3 and over"]],
    ["mean", sum / count >= 0.01 ? (sum / count).toFixed(2) : (sum / count).toExponential(1)],
    ["highest", max.toFixed(2)],
    ["any (over 0.05)", percent(some / count)],
    ["full (1 and over)", percent(full / count)],
  ]);
  addAreaStats(legend, area);
  return { image, legend };
}

/** Plants: where the scatters put every tree, bush and stone - a dot each, by kind - over the ground
 *  shaded by how wooded it is. `show` keeps to one of the three. */
export function plantsView(area: BiomeArea, show: string, water: boolean): MapView {
  const { size, step } = area;
  const plants = area.plants();
  const groups: [string, TreePlacement[], number][] = [
    ["rocks", plants.rocks, 0.8],
    ["bushes", plants.bushes, 0.9],
    ["trees", plants.trees, 3],
  ];
  const shown = groups.filter(([name]) => show === "all" || show === name);
  const kinds = [...new Set(shown.flatMap(([, list]) => list.map((p) => p.kind)))];
  const colorOfKind = (kind: string): Rgb => paletteColor(kinds.indexOf(kind));
  const base = new Float32Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    const g = 0.22 + 0.25 * area.shade[i];
    const wood = area.cover[i] * 0.25;
    let rgb: Rgb = [g, g + wood, g];
    const h = area.heights[i];
    if (water && h < 0) rgb = rgb.map((v, c) => v + (waterColor(-h)[c] - v) * 0.6) as Rgb;
    base.set(rgb, i * 3);
  }
  // Dots: a tree a few metres across, smaller things at least a pixel.
  for (const [, list, metres] of shown) {
    for (const p of list) {
      const cx = (p.x - area.minX) / step;
      const cy = (area.maxZ - p.z) / step;
      const radius = Math.max(0.6, (metres * p.scale) / step);
      const rgb = colorOfKind(p.kind);
      for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
        for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
          if (x < 0 || y < 0 || x >= size || y >= size || Math.hypot(x - cx, y - cy) > radius) continue;
          base.set(rgb, (y * size + x) * 3);
        }
      }
    }
  }
  const image = paint(
    area,
    (i) => [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]],
    (i) => `${describePoint(area, i)}  wooded ${area.cover[i].toFixed(2)}`,
  );
  const extent = step * (size - 1);
  const hectares = (extent * extent) / 10000;
  const legend = legendBox("Plants");
  const rows: (string | [Rgb | null, ...string[]])[][] = [["", "count", "per ha"]];
  for (const [name, list] of shown) {
    const byKind = new Map<string, number>();
    for (const p of list) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
    rows.push([[null, name], String(list.length), (list.length / hectares).toFixed(list.length / hectares < 1 ? 2 : 1)]);
    for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) rows.push([[colorOfKind(kind), kind], String(n), (n / hectares).toFixed(n / hectares < 1 ? 2 : 1)]);
  }
  addTable(legend, rows);
  addTable(legend, [["wooded (cover > 0.5)", percent(area.cover.filter((c) => c > 0.5).length / area.cover.length)]]);
  addAreaStats(legend, area);
  return { image, legend };
}
