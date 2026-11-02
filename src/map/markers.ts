import { parseFile, type PackSource } from "../world/content/resolveContent";
import type { ContentIssue } from "../world/content/contentReader";

/**
 * Map markers (MAP.md, *Markers*): kinds from the packs' `mapMarkers/`, and the markers the game
 * puts on the map, each of a kind. Pure - no DOM - so the rules for what shows can be probed.
 */

export interface MarkerKind {
  id: string;
  name: string;
  /** "icon" (the icon, or its glyph), a "dot", an "area" (a soft circle as wide as the marker's
   *  radius) or a "label" (the marker's text alone). */
  shape: "icon" | "dot" | "area" | "label";
  /** An icon name (ICONS.md); missing, or no pack has it, the glyph in the colour. */
  icon: string;
  glyph: string;
  colour: string;
  /** CSS pixels. */
  size: number;
  /** Drawn over lower ones; the one a cluster shows. */
  priority: number;
  /** On the minimap: shown out to `range` metres; past the ring but within it, an arrow on the ring
   *  if `edge`. 0: never on the minimap. */
  minimap: { range: number; edge: boolean };
  worldMap: boolean;
  /** Same-kind markers closer than this many pixels merge into one with a count. */
  cluster: number;
  /** On until the player turns it off. */
  default: boolean;
  /** An NPC with this quest mark for the character (QUESTS.md, *Markers*: "!", "?", "!grey",
   *  "?grey") is shown as this kind. */
  mark: string;
  /** An NPC whose role has this service (npcRoles' `services`) is shown as this kind - only its
   *  highest-priority service kind, beside any quest kind. */
  service: string;
}

/** One thing on the map. */
export interface MapMarker {
  kind: string;
  x: number;
  z: number;
  /** An area's radius, in metres. */
  radius?: number;
  /** The tooltip: a name, a quest's title. */
  title: string;
}

const SHAPES = ["icon", "dot", "area", "label"] as const;

/** Every pack's marker kinds, later packs replacing earlier ones' of the same id. */
export function loadMarkerKinds(sources: readonly PackSource[]): Map<string, MarkerKind> {
  const kinds = new Map<string, MarkerKind>();
  for (const pack of sources) {
    for (const { path, text } of pack.files) {
      const parts = path.split("/");
      if (parts.length !== 2 || parts[0] !== "mapMarkers" || !parts[1].endsWith(".json5")) continue;
      const id = parts[1].slice(0, -".json5".length);
      const issues: ContentIssue[] = [];
      const d = parseFile(`${pack.id}/${path}`, text, issues) as Partial<Record<string, unknown>> | undefined;
      if (!d || typeof d !== "object") {
        console.warn(`map marker ${pack.id}/${path}: not read`, issues);
        continue;
      }
      const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
      const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
      const minimap = (d.minimap ?? {}) as Record<string, unknown>;
      kinds.set(id, {
        id,
        name: str(d.name, id),
        shape: SHAPES.includes(d.shape as (typeof SHAPES)[number]) ? (d.shape as MarkerKind["shape"]) : "icon",
        icon: str(d.icon, ""),
        glyph: str(d.glyph, "•"),
        colour: str(d.colour, "#ffffff"),
        size: num(d.size, 14),
        priority: num(d.priority, 0),
        minimap: { range: num(minimap.range, 200), edge: minimap.edge === true },
        worldMap: d.worldMap !== false,
        cluster: num(d.cluster, 0),
        default: d.default !== false,
        mark: str(d.mark, ""),
        service: str(d.service, ""),
      });
    }
  }
  return kinds;
}

/** An NPC on the map (the server's MapPins): its quest kind, and its highest service kind. */
export function npcMarkers(kinds: ReadonlyMap<string, MarkerKind>, x: number, z: number, mark: string, services: readonly string[], title: string): MapMarker[] {
  const out: MapMarker[] = [];
  let service: MarkerKind | null = null;
  for (const kind of kinds.values()) {
    if (mark && kind.mark === mark) out.push({ kind: kind.id, x, z, title });
    if (kind.service && services.includes(kind.service) && (!service || kind.priority > service.priority)) service = kind;
  }
  if (service) out.push({ kind: service.id, x, z, title });
  return out;
}

/** Whether a kind shows: the player's choice where they made one, else the kind's default. */
export function kindShown(kind: MarkerKind, choices: Readonly<Record<string, boolean>>): boolean {
  return choices[kind.id] ?? kind.default;
}

/** A marker placed on a view: where on it, and whether it is pinned to the ring's edge. */
export interface PlacedMarker {
  marker: MapMarker;
  kind: MarkerKind;
  x: number;
  y: number;
  /** On the ring's edge, pointing out to it (radians, clockwise from up). */
  edge: number | null;
  /** How many merged into it. */
  count: number;
}

/**
 * Where the markers go on a view: those shown and in range, at their places; those off a round
 * view's edge but in range and of an edge kind pinned to the edge; same-kind ones close together
 * merged; drawn lowest priority first. `toScreen` gives CSS pixels; `round` is the ring's middle and
 * radius for the minimap, null for a square view of `width` x `height`.
 */
export function placeMarkers(
  markers: readonly MapMarker[],
  kinds: ReadonlyMap<string, MarkerKind>,
  choices: Readonly<Record<string, boolean>>,
  toScreen: (x: number, z: number) => { x: number; y: number },
  view: { round: { cx: number; cy: number; r: number; player: { x: number; z: number } } | null; width: number; height: number },
): PlacedMarker[] {
  const out: PlacedMarker[] = [];
  for (const marker of markers) {
    const kind = kinds.get(marker.kind);
    if (!kind || !kindShown(kind, choices)) continue;
    const at = toScreen(marker.x, marker.z);
    const round = view.round;
    if (round) {
      if (kind.minimap.range <= 0) continue;
      const metres = Math.hypot(marker.x - round.player.x, marker.z - round.player.z) - (marker.radius ?? 0);
      if (metres > kind.minimap.range) continue;
      const dx = at.x - round.cx;
      const dy = at.y - round.cy;
      const d = Math.hypot(dx, dy);
      const inside = kind.shape === "area" ? d - areaPixels(marker, toScreen) < round.r : d < round.r - kind.size / 3;
      if (!inside) {
        if (!kind.minimap.edge) continue;
        const angle = Math.atan2(dx, -dy);
        const r = round.r - 7;
        out.push({ marker, kind, x: round.cx + Math.sin(angle) * r, y: round.cy - Math.cos(angle) * r, edge: angle, count: 1 });
        continue;
      }
    } else {
      if (!kind.worldMap) continue;
      const pad = kind.shape === "area" ? areaPixels(marker, toScreen) : kind.size;
      if (at.x < -pad || at.y < -pad || at.x > view.width + pad || at.y > view.height + pad) continue;
    }
    out.push({ marker, kind, x: at.x, y: at.y, edge: null, count: 1 });
  }
  out.sort((a, b) => a.kind.priority - b.kind.priority);
  // Clusters: a marker within its kind's distance of a kept one of the same kind joins it.
  const kept: PlacedMarker[] = [];
  for (let i = out.length - 1; i >= 0; i--) {
    const p = out[i];
    const near = p.kind.cluster > 0 && p.edge === null ? kept.find((k) => k.kind === p.kind && k.edge === null && Math.hypot(k.x - p.x, k.y - p.y) < p.kind.cluster) : undefined;
    if (near) near.count++;
    else kept.push(p);
  }
  return kept.reverse();
}

/** An area marker's radius on screen. */
export function areaPixels(marker: MapMarker, toScreen: (x: number, z: number) => { x: number; y: number }): number {
  return Math.abs(toScreen(marker.x + (marker.radius ?? 0), marker.z).x - toScreen(marker.x, marker.z).x);
}
