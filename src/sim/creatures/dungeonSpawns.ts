// A dungeon's spawn points (DUNGEONS.md, *What fills it*): at its parts' `spawns` spots, a group of
// creatures each - from two of its style's groups (the undead, grave robbers, spiders), which two
// rolled for each dungeon - at the level of the zone over its mouth, and higher the deeper in;
// at its boss's spot, the strongest of them, named, a few levels up. Each point and member keyed
// by the dungeon's id, so the delta keeps who was killed in it as outdoors.
import type { CreatureKind, CreatureRules } from "../rules/creatureRules";
import type { DungeonCreatures } from "../../world/dungeons/dungeonDefs";
import { graphDistances, placedSpots, type DungeonLayout } from "../../world/dungeons/layout";
import { hashString } from "../../world/content/dimensions";
import { deriveSeed, mulberry32 } from "../../world/rng";
import type { SpawnMember, SpawnPoint } from "./spawnPoints";
import { rollRange, type Zone } from "./zones";

/** How far round its spot a member of a group stands, at most (a crypt's floors are not wide). */
const SPREAD = 2;

/**
 * The spawn points of a dungeon laid out as `layout`, its id `id`, in the zone over its mouth.
 * Kinds its style names that the rules do not have are left out (and said once by the caller).
 */
export function dungeonSpawnPoints(id: string, layout: DungeonLayout, spec: DungeonCreatures, rules: CreatureRules, zone: Zone | undefined): SpawnPoint[] {
  const random = mulberry32(deriveSeed(layout.seed, hashString(`${id}/creatures`)));
  // Its groups' kinds: each named species' variants, or a kind by its own id.
  const groups = spec.groups
    .map((g) => ({ weight: g.weight, kinds: g.kinds.flatMap((k) => rules.speciesKinds.get(k) ?? (rules.kinds.get(k) ? [rules.kinds.get(k)!] : [])) }))
    .filter((g) => g.kinds.length > 0);
  if (groups.length === 0) return [];
  // Which of them this dungeon holds: `pick` of them, by weight, without putting one back.
  const chosen: typeof groups = [];
  const left = [...groups];
  while (chosen.length < spec.pick && left.length > 0) {
    const total = left.reduce((s, g) => s + g.weight, 0);
    let r = random() * total;
    let i = 0;
    while (i < left.length - 1 && r >= left[i].weight) r -= left[i++].weight;
    chosen.push(left.splice(i, 1)[0]);
  }
  const base = zone?.levels ?? ([1, 2] as [number, number]);
  const depth = graphDistances(layout.parts.length, layout.joins, 0);
  const points: SpawnPoint[] = [];
  /** A kind of one of the chosen groups, for a member here (a variant fitting the zone's biome if any does). */
  const kindOf = (group: (typeof chosen)[number]): CreatureKind => {
    const fitting = zone ? group.kinds.filter((k) => k.habitat.has(zone.biome)) : [];
    const from = fitting.length > 0 ? fitting : group.kinds;
    return from[Math.floor(random() * from.length)];
  };
  layout.parts.forEach((p, i) => {
    const deeper = Math.floor(Math.max(0, depth[i]) / spec.deeper);
    const spots = [...placedSpots(p, "spawns").map((at) => ({ at, boss: false })), ...(i === layout.boss ? placedSpots(p, "boss").map((at) => ({ at, boss: true })) : [])];
    spots.forEach(({ at, boss }, k) => {
      const key = `${id}/s/${i}/${k}`;
      const group = chosen[Math.floor(random() * chosen.length)];
      const members: SpawnMember[] = [];
      const add = (kind: CreatureKind, level: number, name: string, x: number, z: number): void => {
        members.push({ key: `${key}/${members.length}`, kind, level, name, homeX: x, homeY: at.y, homeZ: z, spread: 0, wander: Math.min(kind.wander, 4), respawn: kind.respawn });
      };
      if (boss) {
        // The strongest of its group's kinds, alone, named after the dungeon's depth.
        const kind = [...group.kinds].sort((a, b) => b.levelOffset - a.levelOffset)[0];
        add(kind, rollRange(base, random) + deeper + kind.levelOffset + spec.boss, "Warden of the Deep", at.x, at.z);
      } else {
        const kind = kindOf(group);
        const count = rollRange(kind.group.size, random);
        const level = rollRange(base, random) + deeper + kind.levelOffset;
        for (let m = 0; m < count; m++) {
          const a = random() * Math.PI * 2, r = m === 0 ? 0 : SPREAD * Math.sqrt(random());
          add(kind, Math.max(1, level + (m === 0 ? 0 : Math.floor(random() * 3) - 1)), "", at.x + Math.sin(a) * r, at.z + Math.cos(a) * r);
        }
      }
      points.push({ key, x: at.x, y: at.y, z: at.z, zone: zone?.id ?? -1, camp: null, members });
    });
  });
  return points;
}
