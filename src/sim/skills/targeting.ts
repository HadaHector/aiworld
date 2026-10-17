import type { Entity } from "../entity";
import type { AreaDef, FilterDef, GroupDef } from "../rules/skillRules";
import { hasFlag } from "./flags";
import { evaluate, members } from "./magic";
import type { Magic, Sys } from "./types";
import { gap, hasMagic, hiddenFrom, inFront, isAlive, radiusOf, relationIs } from "./unit";

/**
 * Areas and target groups (see ABILITIES.md, *Areas and target groups*): who a group of a magic's
 * skill holds, worked out from its source, its filter, its order and its size.
 */
export function groupMembers(sys: Sys, magic: Magic, index: number): number[] {
  const group = magic.skill.groups[index];
  const caster = sys.world.entity(magic.caster);
  const host = magic.host ? sys.world.entity(magic.host) : undefined;
  let units = fromSource(sys, magic, group, caster, host);
  units = units.filter((u) => u.dimension === magic.dimension && passes(sys, magic, group.filter, caster, u));
  units = sorted(sys, magic, group, units, caster ?? host);
  if (group.chain && units.length > 0) units = chained(sys, magic, group, units[0], caster);
  if (group.max) units = units.slice(0, Math.max(0, Math.floor(evaluate(sys, magic, group.max))));
  return units.map((u) => u.id);
}

function fromSource(sys: Sys, magic: Magic, group: GroupDef, caster: Entity | undefined, host: Entity | undefined): Entity[] {
  const one = (id: number): Entity[] => {
    const unit = id ? sys.world.entity(id) : undefined;
    return unit ? [unit] : [];
  };
  switch (group.from.kind) {
    case "target":
      return one(magic.target);
    case "caster":
      return caster ? [caster] : [];
    case "host":
      return host ? [host] : [];
    case "owner":
      return one(host?.combat?.owner ?? 0);
    case "summons":
      return (caster?.combat?.summons ?? []).flatMap(one);
    case "attacking":
      return host?.combat?.attacking ? one(host.combat.target) : [];
    case "threat": {
      const table = host?.combat?.threat;
      if (!table) return [];
      return [...table.entries()].sort((a, b) => b[1].amount - a[1].amount || a[0] - b[0]).flatMap(([id]) => one(id));
    }
    case "group":
      return members(sys, magic, group.from.group);
    case "area": {
      const area = magic.skill.areas[group.from.area];
      const out: Entity[] = [];
      for (const unit of sys.world.entitiesIn(magic.dimension)) if (unit.combat && inArea(sys, magic, area, unit)) out.push(unit);
      return out;
    }
  }
}

/** Where an area stands and which way it faces. */
function areaPlace(sys: Sys, magic: Magic, area: AreaDef): { x: number; z: number; facing: number } {
  const of = (id: number) => (id ? sys.world.entity(id) : undefined);
  const unit = area.at === "caster" ? of(magic.caster) : area.at === "host" ? of(magic.host) : area.at === "target" ? of(magic.target) : undefined;
  const facing = of(magic.caster)?.facing ?? 0;
  return unit ? { x: unit.x, z: unit.z, facing: unit.facing } : { x: magic.x, z: magic.z, facing };
}

function inArea(sys: Sys, magic: Magic, area: AreaDef, unit: Entity): boolean {
  const at = areaPlace(sys, magic, area);
  const dx = unit.x - at.x;
  const dz = unit.z - at.z;
  const r = radiusOf(unit);
  const distance = Math.hypot(dx, dz);
  // Along the facing, and to its side.
  const along = Math.sin(at.facing) * dx + Math.cos(at.facing) * dz;
  const side = Math.cos(at.facing) * dx - Math.sin(at.facing) * dz;
  const v = (expr: AreaDef["radius"]) => evaluate(sys, magic, expr, unit);
  switch (area.shape) {
    case "circle":
      return distance - r <= v(area.radius);
    case "ring":
      return distance - r <= v(area.radius) && distance + r >= v(area.inner);
    case "cone": {
      if (distance - r > v(area.radius)) return false;
      if (distance < 1e-6) return true;
      const half = (v(area.angle) * Math.PI) / 360;
      return Math.acos(Math.max(-1, Math.min(1, along / distance))) <= half + Math.asin(Math.min(1, r / distance));
    }
    case "rect":
      return along >= -r && along - r <= v(area.length) && Math.abs(side) - r <= v(area.width) / 2;
  }
}

/** Whether a unit passes a group's filter, as seen by the magic's caster. */
export function passes(sys: Sys, magic: Magic, filter: FilterDef, caster: Entity | undefined, unit: Entity): boolean {
  if (!unit.combat) return false;
  if (filter.alive !== null && isAlive(unit) !== filter.alive) return false;
  if (!filter.self && caster === unit) return false;
  // With its caster gone, a magic can no longer tell friend from foe: it picks nobody by relation.
  if (!caster && filter.relation !== "any") return false;
  if (caster) {
    if (!relationIs(sys, caster, unit, filter.relation)) return false;
    if (filter.relation === "enemy" && hiddenFrom(sys, unit, caster)) return false;
    if (filter.range && gap(caster, unit) > evaluate(sys, magic, filter.range, unit)) return false;
    if (filter.facing && !inFront(caster, unit)) return false;
    if (filter.los && caster !== unit && !sys.world.lineOfSight(magic.dimension, caster, unit)) return false;
  }
  if (filter.has.length > 0 && !hasMagic(unit, filter.has)) return false;
  if (filter.hasNot.length > 0 && hasMagic(unit, filter.hasNot)) return false;
  if (filter.flags.some((f) => !hasFlag(unit.combat!.flags, f))) return false;
  if (filter.notFlags.some((f) => hasFlag(unit.combat!.flags, f))) return false;
  return true;
}

function sorted(sys: Sys, magic: Magic, group: GroupDef, units: Entity[], from: Entity | undefined): Entity[] {
  const health = sys.rules.health;
  const byDistance = (a: Entity, b: Entity) => (from ? gap(from, a) - gap(from, b) : 0) || a.id - b.id;
  switch (group.sort) {
    case "none":
      return units;
    case "nearest":
      return [...units].sort(byDistance);
    case "farthest":
      return [...units].sort((a, b) => byDistance(b, a));
    case "lowestHealth": {
      const fraction = (u: Entity) => (u.resources && u.resources.max[health] > 0 ? u.resources.current[health] / u.resources.max[health] : 1);
      return [...units].sort((a, b) => fraction(a) - fraction(b) || a.id - b.id);
    }
    case "random": {
      const out = [...units].sort((a, b) => a.id - b.id);
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(magic.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }
  }
}

/** From the first unit, jumps to the nearest one passing the chain's filter, never the same twice. */
function chained(sys: Sys, magic: Magic, group: GroupDef, first: Entity, caster: Entity | undefined): Entity[] {
  const chain = group.chain!;
  const out = [first];
  const jumps = Math.max(0, Math.floor(evaluate(sys, magic, chain.jumps)));
  for (let i = 0; i < jumps; i++) {
    const from = out[out.length - 1];
    const radius = evaluate(sys, magic, chain.radius, from);
    let best: Entity | null = null;
    let bestGap = Infinity;
    for (const unit of sys.world.entitiesIn(magic.dimension)) {
      if (out.includes(unit) || !passes(sys, magic, chain.filter, caster, unit)) continue;
      const g = gap(from, unit);
      if (g <= radius && (g < bestGap || (g === bestGap && best && unit.id < best.id))) {
        best = unit;
        bestGap = g;
      }
    }
    if (!best) break;
    out.push(best);
  }
  return out;
}
