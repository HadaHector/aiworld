import type { PackSource } from "../world/content/resolveContent";
import { parseFile } from "../world/content/resolveContent";
import type { ContentIssue } from "../world/content/contentReader";
import type { ItemTypeDef } from "../sim/rules/itemRules";
import type { SkillDef } from "../sim/rules/skillRules";

/**
 * Icons for items and skills (ICONS.md). A pack may hold icon sets - `icons/<id>.json5`, an atlas
 * picture and each icon's cell in it - and an item type or skill names its icon (`icon: "ore-iron"`).
 * A name no pack provides, or no name, gets a generated placeholder: a coloured glyph for the item's
 * kind or the skill's school, so the game looks consistent on a fresh clone without any art.
 *
 * One library per page, set up with `loadIconSets` when the packs are known; the screens draw icons
 * with `iconFace` and never care where they came from.
 */

/** A glyph the placeholders can draw. */
export type Glyph = "weapon" | "armour" | "clothing" | "food" | "material" | "key" | "book" | "trinket" | "quest" | "tool" | "misc" | "fire" | "frost" | "holy" | "shadow" | "nature" | "arcane" | "physical" | "spell";

/** What to draw for a thing: the icon it names, and the placeholder if that is not there. */
export interface IconSpec {
  name: string;
  glyph: Glyph;
  color: string;
}

interface IconSet {
  url: string;
  columns: number;
  rows: number;
  cells: Map<string, [number, number]>;
}

/** Icon name to the set holding it - later packs (higher priority) replace earlier ones' names. */
const known = new Map<string, IconSet>();

/**
 * Reads the icon sets out of the packs, in load order. The atlas URL is made from where the pack
 * is served, so this takes `baseUrl` like the content loader. Problems are warned about, not thrown:
 * icons are decoration.
 */
export function loadIconSets(sources: readonly PackSource[], baseUrl: string = import.meta.env.BASE_URL): void {
  known.clear();
  for (const pack of sources) {
    for (const { path, text } of pack.files) {
      const parts = path.split("/");
      if (parts.length !== 2 || parts[0] !== "icons") continue;
      const issues: ContentIssue[] = [];
      const data = parseFile(`${pack.id}/${path}`, text, issues) as { atlas?: unknown; size?: unknown; columns?: unknown; rows?: unknown; icons?: Record<string, unknown> } | undefined;
      if (!data || typeof data.atlas !== "string" || typeof data.icons !== "object" || data.icons === null || typeof data.columns !== "number" || typeof data.rows !== "number") {
        console.warn(`icon set ${pack.id}/${path}: expected { atlas, columns, rows, icons }`, issues);
        continue;
      }
      const set: IconSet = { url: `${baseUrl}packs/${pack.id}/icons/${data.atlas}`, columns: data.columns, rows: data.rows, cells: new Map() };
      for (const [name, cell] of Object.entries(data.icons)) {
        if (Array.isArray(cell) && typeof cell[0] === "number" && typeof cell[1] === "number") {
          known.set(name, set);
          set.cells.set(name, [cell[0], cell[1]]);
        }
      }
    }
  }
}

/** Whether some loaded icon set has this icon. */
export const hasIcon = (name: string): boolean => known.has(name);

// --- placeholders ---

const GLYPH_BY_KIND: Record<string, Glyph> = { weapon: "weapon", armour: "armour", clothing: "clothing", food: "food", material: "material", key: "key", book: "book", trinket: "trinket", quest: "quest", tool: "tool" };

/** Placeholder colours of the schools the core skills use; any other school gets one from its name. */
const SCHOOL_COLOURS: Record<string, string> = { fire: "#e8742a", frost: "#6cc4f0", holy: "#f4e08a", shadow: "#9a6cd0", nature: "#6cc060", arcane: "#d070e0" };
const SCHOOL_GLYPHS: Record<string, Glyph> = { fire: "fire", frost: "frost", holy: "holy", shadow: "shadow", nature: "nature", arcane: "arcane" };

function hashColour(text: string): string {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 55%, 62%)`;
}

/** What to draw for an item type (`color` is its rarity's); a missing type is a "?" misc. */
export function itemIcon(type: ItemTypeDef | null | undefined, color: string): IconSpec {
  return { name: type?.icon ?? "", glyph: GLYPH_BY_KIND[type?.kind ?? ""] ?? "misc", color };
}

/** What to draw for a skill: its school's glyph and colour, or a swing for a physical skill. */
export function skillIcon(skill: SkillDef | null | undefined): IconSpec {
  const school = skill?.tags.find((t) => t.startsWith("school."))?.slice(7);
  if (school) return { name: skill?.icon ?? "", glyph: SCHOOL_GLYPHS[school] ?? "spell", color: SCHOOL_COLOURS[school] ?? hashColour(school) };
  return { name: skill?.icon ?? "", glyph: skill?.type === "physical" || skill?.tags.includes("melee") ? "physical" : "spell", color: skill?.type === "physical" || skill?.tags.includes("melee") ? "#d0c8b8" : "#c8a8e8" };
}

/** The debug teleport's icon: it is no skill. */
export const TELEPORT_ICON: IconSpec = { name: "", glyph: "arcane", color: "#d070e0" };

type Draw = (g: CanvasRenderingContext2D) => void;

/** Each glyph on a 64 x 64 canvas, in the current fill and stroke. Plain shapes, drawn not loaded. */
const DRAWINGS: Record<Glyph, Draw> = {
  weapon: (g) => {
    path(g, [[44, 10], [54, 10], [54, 20], [24, 50], [16, 42]]);
    path(g, [[12, 38], [26, 52], [22, 56], [8, 42]]);
    path(g, [[10, 54], [18, 46], [20, 48], [12, 56]]);
  },
  armour: (g) => {
    path(g, [[14, 12], [50, 12], [50, 34], [32, 54], [14, 34]]);
  },
  clothing: (g) => {
    path(g, [[22, 12], [42, 12], [58, 22], [50, 32], [44, 28], [44, 54], [20, 54], [20, 28], [14, 32], [6, 22]]);
  },
  food: (g) => {
    g.beginPath();
    g.ellipse(32, 36, 22, 14, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.beginPath();
    for (const x of [22, 32, 42]) {
      g.moveTo(x - 3, 28);
      g.lineTo(x + 3, 40);
    }
    g.stroke();
  },
  material: (g) => {
    path(g, [[32, 8], [52, 26], [32, 56], [12, 26]]);
    g.beginPath();
    g.moveTo(12, 26);
    g.lineTo(52, 26);
    g.moveTo(32, 8);
    g.lineTo(24, 26);
    g.lineTo(32, 56);
    g.moveTo(32, 8);
    g.lineTo(40, 26);
    g.lineTo(32, 56);
    g.stroke();
  },
  key: (g) => {
    g.beginPath();
    g.arc(22, 22, 12, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    path(g, [[28, 30], [34, 24], [56, 46], [56, 54], [48, 54], [48, 48], [42, 48], [42, 42], [36, 42]]);
  },
  book: (g) => {
    path(g, [[14, 10], [50, 10], [50, 54], [14, 54]]);
    g.beginPath();
    g.moveTo(22, 10);
    g.lineTo(22, 54);
    g.moveTo(28, 22);
    g.lineTo(44, 22);
    g.moveTo(28, 30);
    g.lineTo(44, 30);
    g.stroke();
  },
  trinket: (g) => {
    g.beginPath();
    g.arc(32, 38, 15, 0, Math.PI * 2);
    g.lineWidth = 6;
    g.stroke();
    g.lineWidth = 2.5;
    path(g, [[32, 6], [40, 14], [32, 22], [24, 14]]);
  },
  quest: (g) => {
    path(g, [[8, 16], [56, 16], [56, 50], [8, 50]]);
    g.beginPath();
    g.moveTo(8, 16);
    g.lineTo(32, 36);
    g.lineTo(56, 16);
    g.stroke();
  },
  tool: (g) => {
    path(g, [[8, 20], [28, 8], [46, 18], [36, 24], [28, 18], [18, 24]]);
    path(g, [[30, 24], [36, 24], [38, 56], [28, 56]]);
  },
  misc: (g) => {
    path(g, [[24, 10], [40, 10], [36, 20], [50, 30], [52, 50], [44, 56], [20, 56], [12, 50], [14, 30], [28, 20]]);
  },
  fire: (g) => {
    path(g, [[32, 6], [40, 20], [48, 28], [50, 42], [42, 56], [22, 56], [14, 42], [18, 28], [26, 34], [28, 18]]);
  },
  frost: (g) => {
    g.lineWidth = 4;
    g.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI) / 3;
      g.moveTo(32 + Math.cos(a) * 24, 32 + Math.sin(a) * 24);
      g.lineTo(32 - Math.cos(a) * 24, 32 - Math.sin(a) * 24);
    }
    g.stroke();
    g.lineWidth = 2.5;
    g.beginPath();
    g.arc(32, 32, 6, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  },
  holy: (g) => {
    g.beginPath();
    g.arc(32, 32, 11, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.lineWidth = 4;
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      g.moveTo(32 + Math.cos(a) * 17, 32 + Math.sin(a) * 17);
      g.lineTo(32 + Math.cos(a) * 26, 32 + Math.sin(a) * 26);
    }
    g.stroke();
  },
  shadow: (g) => {
    g.beginPath();
    g.arc(32, 32, 22, 0.5 * Math.PI, 1.5 * Math.PI);
    g.arc(40, 32, 17, 1.5 * Math.PI, 0.5 * Math.PI, true);
    g.closePath();
    g.fill();
    g.stroke();
  },
  nature: (g) => {
    g.beginPath();
    g.moveTo(10, 54);
    g.quadraticCurveTo(8, 12, 54, 10);
    g.quadraticCurveTo(56, 52, 10, 54);
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(10, 54);
    g.lineTo(40, 24);
    g.stroke();
  },
  arcane: (g) => {
    path(g, [[32, 4], [38, 26], [60, 32], [38, 38], [32, 60], [26, 38], [4, 32], [26, 26]]);
  },
  physical: (g) => {
    path(g, [[10, 8], [18, 8], [56, 46], [50, 52]]);
    path(g, [[54, 8], [46, 8], [8, 46], [14, 52]]);
  },
  spell: (g) => {
    path(g, [[32, 6], [56, 32], [32, 58], [8, 32]]);
    g.beginPath();
    g.arc(32, 32, 7, 0, Math.PI * 2);
    g.stroke();
  },
};

function path(g: CanvasRenderingContext2D, points: [number, number][]): void {
  g.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  g.closePath();
  g.fill();
  g.stroke();
}

const placeholders = new Map<string, string>();

/** A placeholder's picture as a data URL, drawn once per glyph and colour. */
function placeholder(glyph: Glyph, color: string): string {
  const key = `${glyph}|${color}`;
  let url = placeholders.get(key);
  if (url !== undefined) return url;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const g = canvas.getContext("2d");
  if (!g) return "";
  g.lineJoin = "round";
  g.lineCap = "round";
  g.fillStyle = color;
  g.globalAlpha = 0.9;
  g.strokeStyle = "rgba(0, 0, 0, 0.75)";
  g.lineWidth = 2.5;
  DRAWINGS[glyph](g);
  url = canvas.toDataURL();
  placeholders.set(key, url);
  return url;
}

/**
 * Draws an icon into `parent`, filling it: the named icon from the loaded sets, or the placeholder.
 * Returns the element and whether it is a real icon - a screen that labels placeholders by name
 * (the action bar) reads that.
 */
export function iconFace(parent: HTMLElement, spec: IconSpec, css = ""): { element: HTMLElement; real: boolean } {
  const element = document.createElement("div");
  const set = spec.name ? known.get(spec.name) : undefined;
  const base = "position: absolute; inset: 0; pointer-events: none; background-repeat: no-repeat;";
  if (set) {
    const [col, row] = set.cells.get(spec.name)!;
    // The atlas is `columns` x `rows` cells: scale it so one cell fills the box, then slide to the cell.
    const x = set.columns > 1 ? (col / (set.columns - 1)) * 100 : 0;
    const y = set.rows > 1 ? (row / (set.rows - 1)) * 100 : 0;
    element.style.cssText = `${base} background-image: url(${set.url}); background-size: ${set.columns * 100}% ${set.rows * 100}%; background-position: ${x}% ${y}%; ${css}`;
  } else {
    element.style.cssText = `${base} background-image: url(${placeholder(spec.glyph, spec.color)}); background-size: 100% 100%; ${css}`;
  }
  parent.appendChild(element);
  return { element, real: !!set };
}

/** An icon as an HTML string, for tooltips built from text: `size` px square, inline. */
export function iconHtml(spec: IconSpec, size: number): string {
  const holder = document.createElement("span");
  holder.style.cssText = `display: inline-block; position: relative; width: ${size}px; height: ${size}px; vertical-align: middle;`;
  iconFace(holder, spec);
  return holder.outerHTML;
}

/** A square box of `size` px in `parent` holding an icon - for rows of text that carry one. */
export function iconBox(parent: HTMLElement, spec: IconSpec, size: number, css = ""): HTMLElement {
  const box = document.createElement("div");
  box.style.cssText = `position: relative; flex: none; width: ${size}px; height: ${size}px; ${css}`;
  parent.appendChild(box);
  iconFace(box, spec);
  return box;
}
