import type { DimensionDef, StartAnchor, StartDef, StartRule, StartSpot } from "../content/dimensions";
import type { SettlementLayout } from "./settlementLayout";
import type { SettlementSite } from "./settlementSites";

/** What choosing a start needs of a generated world: its settlements, laid out, and its size. */
export interface StartWorld {
  settlements: readonly SettlementSite[];
  settlementLayouts: readonly SettlementLayout[];
  worldExtent: number;
}

/** A start once the world is generated: where a new character appears, its first home, and the
 *  entities that stand there. */
export interface ChosenStart {
  id: string;
  for: StartDef["for"];
  /** The settlement chosen (its site id), or null for a fixed point. */
  settlement: number | null;
  name: string;
  x: number;
  z: number;
  /** Radians about y, 0 facing +z. */
  facing: number;
  home: { x: number; z: number };
  entities: { template: string; x: number; z: number; facing: number }[];
  /** The rule's conditions dropped to find a match, in the order dropped. */
  relaxed: string[];
}

/** How far in front of a building's door its anchor stands. */
const DOOR_CLEARANCE = 3;

// Conditions a rule drops, in this order, when nothing matches it (NPCS.md, *Relaxing*).
const RELAX_ORDER = ["centre", "biomes", "buildings", "tiers"] as const;
type Condition = (typeof RELAX_ORDER)[number];

function matches(rule: StartRule, site: SettlementSite, layout: SettlementLayout, half: number, kept: ReadonlySet<Condition>): boolean {
  if (kept.has("tiers") && rule.tiers && !rule.tiers.includes(site.tier)) return false;
  if (kept.has("buildings") && !rule.buildings.every((b) => layout.houses.some((h) => h.building.id === b))) return false;
  const biomes = rule.biomes;
  if (kept.has("biomes") && biomes && ("only" in biomes ? !biomes.only.includes(site.biome.id) : biomes.except.includes(site.biome.id))) return false;
  if (kept.has("centre") && rule.centre !== null && Math.hypot(site.x, site.z) > rule.centre * half) return false;
  return true;
}

/** Where an anchor is in a settlement, or null when the settlement has no such thing. */
function anchorPoint(anchor: StartAnchor, layout: SettlementLayout | null): { x: number; z: number } | null {
  if (anchor.kind === "point") return { x: anchor.x, z: anchor.z };
  if (!layout) return null;
  if (anchor.kind === "square") return { x: layout.square.x, z: layout.square.z };
  if (anchor.kind === "gate") {
    // The gate nearest the world's centre: the way a new character sets out.
    const gate = [...layout.gates].sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
    return gate ? { x: gate.x, z: gate.z } : null;
  }
  // The building of that kind nearest the square, in front of its door.
  const square = layout.square;
  const house = layout.houses
    .filter((h) => h.building.id === anchor.building)
    .sort((a, b) => Math.hypot(a.x - square.x, a.z - square.z) - Math.hypot(b.x - square.x, b.z - square.z))[0];
  if (!house) return null;
  const out = house.depth / 2 + DOOR_CLEARANCE;
  return { x: house.x + house.frontX * out, z: house.z + house.frontZ * out };
}

/** A spot's point: its anchor, else the square (the anchor that every settlement has), moved by its offset. */
function spotPoint(spot: StartSpot, layout: SettlementLayout | null, fallback: { x: number; z: number }): { x: number; z: number } {
  const at = anchorPoint(spot.at, layout) ?? anchorPoint({ kind: "square" }, layout) ?? fallback;
  return { x: at.x + spot.offset.x, z: at.z + spot.offset.z };
}

function facingOf(facing: number | StartAnchor, from: { x: number; z: number }, layout: SettlementLayout | null): number {
  if (typeof facing === "number") return facing;
  const to = anchorPoint(facing, layout);
  return to && Math.hypot(to.x - from.x, to.z - from.z) > 0.01 ? Math.atan2(to.x - from.x, to.z - from.z) : 0;
}

/** The settlement a rule picks, and what it had to drop to find one; null when there is no
 *  settlement at all. Ties break on the site id, so the same world always gives the same place. */
function pickSettlement(rule: StartRule, world: StartWorld): { site: SettlementSite; layout: SettlementLayout; relaxed: string[] } | null {
  const half = world.worldExtent / 2;
  const layouts = new Map(world.settlementLayouts.map((l) => [l.siteId, l]));
  const sites = world.settlements.filter((s) => layouts.has(s.id));
  const kept = new Set<Condition>(RELAX_ORDER);
  const relaxed: Condition[] = [];
  const candidatesFor = (conditions: ReadonlySet<Condition>): SettlementSite[] => sites.filter((s) => matches(rule, s, layouts.get(s.id)!, half, conditions));
  for (let drop = 0; drop <= RELAX_ORDER.length; drop++) {
    let candidates = candidatesFor(kept);
    if (candidates.length > 0) {
      // Put back what turned out not to be needed: a later drop may have been the one that mattered.
      for (const condition of [...relaxed]) {
        const tighter = new Set(kept).add(condition);
        const still = candidatesFor(tighter);
        if (still.length === 0) continue;
        kept.add(condition);
        relaxed.splice(relaxed.indexOf(condition), 1);
        candidates = still;
      }
      const rank = (s: SettlementSite): number => rule.prefer.centre * (1 - Math.min(1, Math.hypot(s.x, s.z) / half)) + rule.prefer.score * s.score;
      const best = candidates.sort((a, b) => rank(b) - rank(a) || a.id - b.id)[0];
      return { site: best, layout: layouts.get(best.id)!, relaxed };
    }
    if (drop < RELAX_ORDER.length) {
      kept.delete(RELAX_ORDER[drop]);
      relaxed.push(RELAX_ORDER[drop]);
    }
  }
  return null;
}

/**
 * Every start of a dimension, placed in its generated world (NPCS.md, *The starting site*). Run by
 * the server and the page alike, from the same world, so both put a new character in the same place.
 * A dimension with no `starts` has one, `default`, at its `spawn`.
 */
export function chooseStarts(world: StartWorld, definition: DimensionDef, warn: (message: string) => void = () => {}): ChosenStart[] {
  const defs: StartDef[] = definition.starts.length > 0
    ? definition.starts
    : [{ id: "default", for: null, rule: null, arrive: { at: { kind: "point", ...definition.spawn }, offset: { x: 0, z: 0 } }, facing: 0, home: { at: { kind: "point", ...definition.spawn }, offset: { x: 0, z: 0 } }, entities: [], intro: [] }];
  return defs.map((def) => {
    const picked = def.rule ? pickSettlement(def.rule, world) : null;
    if (def.rule && !picked) warn(`${definition.id}: no settlement for the start "${def.id}"; it is at the dimension's spawn`);
    else if (picked && picked.relaxed.length > 0) warn(`${definition.id}: the start "${def.id}" dropped ${picked.relaxed.join(", ")} to find a settlement (${picked.site.name})`);
    const layout = picked?.layout ?? null;
    const arrive = spotPoint(def.arrive, layout, definition.spawn);
    return {
      id: def.id,
      for: def.for,
      settlement: picked?.site.id ?? null,
      name: picked?.site.name ?? definition.name,
      ...arrive,
      facing: facingOf(def.facing, arrive, layout),
      home: spotPoint(def.home, layout, arrive),
      entities: def.entities.map((e) => {
        const at = spotPoint(e.spot, layout, arrive);
        return { template: e.template, ...at, facing: facingOf(e.facing, at, layout) };
      }),
      relaxed: picked?.relaxed ?? [],
    };
  });
}

/** Whether a character with these origins may start at a start. */
export function startAllows(start: Pick<StartDef, "for">, origins: Readonly<Record<string, string>>): boolean {
  return !start.for || Object.entries(start.for).every(([slot, ids]) => ids.includes(origins[slot] ?? ""));
}
