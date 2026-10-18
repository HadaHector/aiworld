import { hashString } from "../../world/content/dimensions";
import { SEA_LEVEL } from "../../world/cells/areaField";
import { deriveSeed, mulberry32 } from "../../world/rng";
import type { WorldData } from "../../world/worldData";
import type { CampDef, CreatureKind, CreatureRules } from "../rules/creatureRules";
import { rollRange, type Zone } from "./zones";

/** One creature a spawn point holds. */
export interface SpawnMember {
  /** `<point key>/<n>`: what the delta keys its death by, and what seeds its rolls. */
  key: string;
  kind: CreatureKind;
  level: number;
  /** Its own name over its kind's (a camp's captain), or "". */
  name: string;
  /** Where it stands and wanders about. */
  homeX: number;
  homeZ: number;
  /** How far from the point it may come back, and wander from its home. */
  spread: number;
  wander: number;
  respawn: [number, number];
}

/** A spawn point (see CREATURES.md, *Spawn points*): a place, and the creatures it holds. */
export interface SpawnPoint {
  /** `<dimension>/s/<i>,<j>` - stable for a seed, whatever else changes. */
  key: string;
  x: number;
  z: number;
  zone: number;
  /** The camp it is, or null for a lone creature, a pair or a group. */
  camp: CampDef | null;
  /** Every member is one group: pulling one pulls them all. */
  members: SpawnMember[];
}

/** Ground no creature stands on: roads and their verges, water, settlements, yards. */
const ROAD_CLEARANCE = 8;
const RIVER_CLEARANCE = 10;
const SETTLEMENT_CLEARANCE = 25;
const YARD_CLEARANCE = 15;
/** Ground under this much over the sea is the shore or under water. */
const SHORE_HEIGHT = 0.6;

export interface SpawnPointField {
  /** Every spawn point whose place is within `radius` of (x, z): worked out the first time it is
   *  asked for, then kept. */
  near(x: number, z: number, radius: number): SpawnPoint[];
  /** The zones, by id. */
  zones: readonly Zone[];
  /** Whether a creature may stand at a point: wild, dry, walkable ground. */
  open(x: number, z: number): boolean;
}

/**
 * The spawn points of one dimension's world, derived lazily from the world's seed: a jittered
 * lattice at the rules' spacing, each candidate kept only on open wild ground, and what stands there
 * drawn from its zone's roster.
 */
export function createSpawnPointField(dimension: string, world: WorldData, rules: CreatureRules, zones: readonly Zone[], keepOut: readonly { x: number; z: number }[]): SpawnPointField {
  const { config } = rules;
  const spacing = config.spacing;
  const cache = new Map<string, SpawnPoint | null>();
  const half = world.worldExtent / 2;

  function slope(x: number, z: number, h: number): number {
    const d = 2;
    const dx = (world.heightAt(x + d, z) - world.heightAt(x - d, z)) / (2 * d);
    const dz = (world.heightAt(x, z + d) - world.heightAt(x, z - d)) / (2 * d);
    return Math.max(Math.abs(dx), Math.abs(dz), Math.abs(world.heightAt(x, z) - h));
  }

  /** Whether a creature may stand at (x, z): wild, dry, walkable ground. */
  function open(x: number, z: number): boolean {
    if (Math.abs(x) > half || Math.abs(z) > half) return false;
    const s = world.sampleTerrain(x, z);
    if (!s.isLand || s.height < SEA_LEVEL + SHORE_HEIGHT || s.lakeFactor > 0.05) return false;
    if (s.riverGap < RIVER_CLEARANCE || s.roadGap < ROAD_CLEARANCE) return false;
    if (slope(x, z, s.height) > config.maxSlope) return false;
    if (world.buildingAt(x, s.height + 1, z)) return false;
    for (const l of world.settlementLayouts) if (Math.hypot(x - l.x, z - l.z) < l.radius + SETTLEMENT_CLEARANCE) return false;
    for (const c of world.compoundLayouts) if (Math.hypot(x - c.yard.x, z - c.yard.z) < c.yard.radius + YARD_CLEARANCE) return false;
    return true;
  }

  /** A spot within `spread` of (x, z) that is open, tried a few times; the point itself failing that. */
  function spotNear(x: number, z: number, spread: number, random: () => number): { x: number; z: number } {
    for (let tries = 0; tries < 6; tries++) {
      const angle = random() * Math.PI * 2;
      const r = spread * Math.sqrt(random());
      const sx = x + Math.sin(angle) * r;
      const sz = z + Math.cos(angle) * r;
      if (open(sx, sz)) return { x: sx, z: sz };
    }
    return { x, z };
  }

  function pickWeighted(list: { weight: number }[], random: () => number): number {
    const total = list.reduce((sum, e) => sum + e.weight, 0);
    let r = random() * total;
    for (let i = 0; i < list.length - 1; i++) {
      if (r < list[i].weight) return i;
      r -= list[i].weight;
    }
    return list.length - 1;
  }

  function make(i: number, j: number): SpawnPoint | null {
    const key = `${dimension}/s/${i},${j}`;
    const random = mulberry32(deriveSeed(world.seed, hashString(key)));
    const x = (i + 0.5 + (random() - 0.5) * 0.8) * spacing;
    const z = (j + 0.5 + (random() - 0.5) * 0.8) * spacing;
    if (random() < config.emptyChance) return null;
    if (keepOut.some((p) => Math.hypot(x - p.x, z - p.z) < config.safeRadius)) return null;
    if (!open(x, z)) return null;
    const zone = zones[world.sampleTerrain(x, z).primaryAreaId];
    if (!zone || zone.roster.length === 0) return null;
    const levelFor = (offset: number): number => Math.max(1, rollRange(zone.levels, random) + offset);
    const members: SpawnMember[] = [];
    const add = (kind: CreatureKind, level: number, name: string, home: { x: number; z: number }, spread: number, wander: number, respawn: [number, number]): void => {
      members.push({ key: `${key}/${members.length}`, kind, level, name, homeX: home.x, homeZ: home.z, spread, wander, respawn });
    };

    if (zone.camps.length > 0 && random() < config.campChance) {
      const camp = zone.camps[pickWeighted(zone.camps, random)].camp;
      for (const member of camp.members) {
        // A member naming a species takes the variant whose habitat fits the zone, else the first.
        const kinds = member.kinds.map((id) => rules.kinds.get(id)!);
        const kind = kinds.find((k) => k.habitat.has(zone.biome)) ?? kinds[0];
        const n = rollRange(member.count, random);
        for (let m = 0; m < n; m++) {
          const home = member.centre ? { x, z } : spotNear(x, z, camp.radius, random);
          add(kind, levelFor(kind.levelOffset + member.levelOffset), member.name, home, camp.radius, camp.wander, camp.respawn);
        }
      }
      return members.length > 0 ? { key, x, z, zone: zone.id, camp, members } : null;
    }

    const kind = zone.roster[pickWeighted(zone.roster, random)].kind;
    const { single, pair, group } = config.groups;
    const shape = pickWeighted([{ weight: single }, { weight: pair }, { weight: group }], random);
    const count = shape === 0 ? 1 : shape === 1 ? 2 : rollRange(kind.group.size, random);
    // A group stands together at one level, give or take one.
    const level = levelFor(kind.levelOffset);
    for (let m = 0; m < count; m++) {
      const home = m === 0 ? { x, z } : spotNear(x, z, kind.group.spread, random);
      add(kind, Math.max(1, level + (m === 0 ? 0 : Math.floor(random() * 3) - 1)), "", home, Math.max(kind.group.spread, 4), kind.wander, kind.respawn);
    }
    return { key, x, z, zone: zone.id, camp: null, members };
  }

  return {
    zones,
    open,
    near(x, z, radius) {
      const out: SpawnPoint[] = [];
      // A point lies within 0.4 spacing of its lattice cell's middle.
      const reach = radius + spacing;
      for (let i = Math.floor((x - reach) / spacing); i <= Math.floor((x + reach) / spacing); i++) {
        for (let j = Math.floor((z - reach) / spacing); j <= Math.floor((z + reach) / spacing); j++) {
          const id = `${i},${j}`;
          let point = cache.get(id);
          if (point === undefined) {
            point = make(i, j);
            cache.set(id, point);
          }
          if (point && Math.hypot(point.x - x, point.z - z) <= radius) out.push(point);
        }
      }
      return out;
    },
  };
}

/** A spot for a member coming back: within its spread of its point, from a stream of its key and
 *  how many times it has come back (see CREATURES.md, *Death, corpses and respawn*). */
export function respawnSpot(point: SpawnPoint, member: SpawnMember, counter: number, isOpen?: (x: number, z: number) => boolean): { x: number; z: number } {
  const random = mulberry32(deriveSeed(hashString(member.key), counter + 1));
  for (let tries = 0; tries < 6; tries++) {
    const angle = random() * Math.PI * 2;
    const r = member.spread * Math.sqrt(random());
    const x = point.x + Math.sin(angle) * r;
    const z = point.z + Math.cos(angle) * r;
    if (!isOpen || isOpen(x, z)) return { x, z };
  }
  return { x: member.homeX, z: member.homeZ };
}
