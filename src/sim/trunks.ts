import { buildChunkCollision } from "../world/terrain/chunkGround";
import type { TreeScatter } from "../world/foliage/treeScatter";
import { treeVariant, type TreeCollider, type TreeHulls } from "../world/foliage/treeColliders";
import { hullOfTriangles, type Plane } from "../world/collision/hull";
import type { Vec3 } from "../world/collision/vec";
import type { WorldData } from "../world/worldData";
import { COLLISION_CHUNK_SIZE, collisionChunkRequest } from "./collisionStreamer";

/** A tree's pieces lower than this over the ground under a body, in metres, are a root it steps
 *  onto rather than one it is stuck in - under the motor's step height (see characterMotor.ts). */
const STEP = 0.5;
/** ...and higher than this are over its head (a capsule 1.8 m tall). */
const HEAD = 1.8;
/** A profile's rings, and the directions round each it looks along, in a tree's own units. */
const RING = 0.1;
const DIRECTIONS = 32;
/** Chunks whose trees are kept, the most recently asked for. */
const KEEP_CHUNKS = 96;

/** Where the trees and buildings stand, roughly: whether a body fits somewhere, without the
 *  collision world. */
export interface TrunkField {
  /** Whether a body standing at (x, z) keeps `reach` clear of every tree's trunk and roots and of
   *  every building's footprint. */
  clear(x: number, z: number, reach: number): boolean;
}

/** Where a tree's pieces stand at each distance from its foot, in its own units: ring i, i * RING
 *  out, holds each piece reaching it as its lowest and highest point all the way round, in turn. */
type Profile = Float32Array[];

/** The lowest and highest points of a convex piece straight over (x, z), or null where none is. */
function column(planes: readonly Plane[], x: number, z: number): [number, number] | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (const { normal: n, d } of planes) {
    // n.x x + n.y y + n.z z <= d along the column.
    const rest = d - n.x * x - n.z * z;
    if (n.y > 1e-6) top = Math.min(top, rest / n.y);
    else if (n.y < -1e-6) bottom = Math.max(bottom, rest / n.y);
    else if (rest < 0) return null;
  }
  return top >= bottom ? [bottom, top] : null;
}

function heightProfile(pieces: readonly TreeCollider[]): Profile {
  const hullsOf = pieces.map(({ corners, triangles }) => {
    const points: Vec3[] = [];
    for (let i = 0; i < corners.length; i += 3) points.push({ x: corners[i], y: corners[i + 1], z: corners[i + 2] });
    let r = 0;
    for (const p of points) r = Math.max(r, Math.hypot(p.x, p.z));
    return { planes: hullOfTriangles(points, triangles).planes, r };
  });
  const out = Math.max(0, ...hullsOf.map((h) => h.r));
  const profile: Profile = [];
  for (let i = 0; i * RING <= out; i++) {
    const r = i * RING;
    const ring: number[] = [];
    for (const h of hullsOf) {
      if (h.r < r) continue;
      let low = Infinity;
      let high = -Infinity;
      for (let k = 0; k < DIRECTIONS; k++) {
        const angle = (k / DIRECTIONS) * Math.PI * 2;
        const span = column(h.planes, Math.sin(angle) * r, Math.cos(angle) * r);
        if (!span) continue;
        low = Math.min(low, span[0]);
        high = Math.max(high, span[1]);
      }
      if (high >= low) ring.push(low, high);
    }
    profile.push(Float32Array.from(ring));
  }
  return profile;
}

/** A tree, as the trunk field keeps it: where its foot is, how big, its kind's profile, and how
 *  far out its pieces reach at all, in metres. */
interface Trunk {
  x: number;
  y: number;
  z: number;
  scale: number;
  profile: Profile;
  r: number;
}

/**
 * Each tree as rings round its foot - how high its collision pieces stand at each distance, all the
 * way round - so a body is put down only where none is in its way above a step, standing at most
 * on a root or under a branch; and each building as its footprint: what a creature must not be put down inside of (see
 * CREATURES.md, *Spawn points*). The trees are the ones the server's collision chunks scatter, from
 * the same requests, so they are the trees a body would bump into there - whether that chunk's
 * collision is in yet or not.
 */
export function createTrunkField(world: WorldData, hulls: TreeHulls, scatterTrees: TreeScatter): TrunkField {
  /** Each kind's variants' height profiles, worked out the first time a tree of it is met. */
  const profiles = new Map<string, { near: Profile[]; stump: Profile[] } | null>();
  function profilesOf(kind: string): { near: Profile[]; stump: Profile[] } | null {
    let own = profiles.get(kind);
    if (own === undefined) {
      const variants = hulls.get(kind);
      own = variants ? { near: variants.map((v) => heightProfile(v.near)), stump: variants.map((v) => heightProfile(v.stump)) } : null;
      profiles.set(kind, own);
    }
    return own;
  }
  let widest = 0;
  const chunks = new Map<string, Trunk[]>();

  function trunksOf(cx: number, cz: number): Trunk[] {
    const key = `${cx},${cz}`;
    let trunks = chunks.get(key);
    if (trunks) {
      // Most recently used last, so the first is the one to drop.
      chunks.delete(key);
      chunks.set(key, trunks);
      return trunks;
    }
    const { trees } = buildChunkCollision(collisionChunkRequest(cx, cz), { sampleTerrain: world.sampleTerrain, scatterTrees });
    trunks = [];
    for (const tree of trees) {
      const own = profilesOf(tree.kind);
      if (!own) continue;
      const list = tree.stump ? own.stump : own.near;
      const profile = list[treeVariant(tree, list.length)];
      const r = profile.length * RING * tree.scale;
      if (r <= 0) continue;
      trunks.push({ x: tree.x, y: tree.y, z: tree.z, scale: tree.scale, profile, r });
      widest = Math.max(widest, r);
    }
    chunks.set(key, trunks);
    if (chunks.size > KEEP_CHUNKS) chunks.delete(chunks.keys().next().value!);
    return trunks;
  }

  /** Whether a tree has a piece in the way of a body `reach` wide standing on the ground at (x, z),
   *  `distance` from its foot: higher than a step over that ground and lower than its head, in any
   *  ring the body covers. */
  function inTheWay(t: Trunk, distance: number, reach: number, ground: number): boolean {
    const unit = RING * t.scale;
    const low = (ground - t.y + STEP) / t.scale;
    const high = (ground - t.y + HEAD) / t.scale;
    const last = Math.min(t.profile.length - 1, Math.ceil((distance + reach) / unit));
    for (let i = Math.max(0, Math.floor((distance - reach) / unit)); i <= last; i++) {
      const ring = t.profile[i];
      for (let k = 0; k < ring.length; k += 2) if (ring[k + 1] > low && ring[k] < high) return true;
    }
    return false;
  }

  function clearOfTrees(x: number, z: number, reach: number): boolean {
    // Trees are scattered within their chunk: one standing just across a border reaches over it.
    // The widest seen so far stands in for any; the chunk under the point comes first, so it is known.
    const own = trunksOf(Math.floor(x / COLLISION_CHUNK_SIZE), Math.floor(z / COLLISION_CHUNK_SIZE));
    const far = reach + Math.max(widest, 3);
    const ground = world.heightAt(x, z);
    for (let cx = Math.floor((x - far) / COLLISION_CHUNK_SIZE); cx <= Math.floor((x + far) / COLLISION_CHUNK_SIZE); cx++) {
      for (let cz = Math.floor((z - far) / COLLISION_CHUNK_SIZE); cz <= Math.floor((z + far) / COLLISION_CHUNK_SIZE); cz++) {
        const trunks = cx === Math.floor(x / COLLISION_CHUNK_SIZE) && cz === Math.floor(z / COLLISION_CHUNK_SIZE) ? own : trunksOf(cx, cz);
        for (const t of trunks) {
          const distance = Math.hypot(t.x - x, t.z - z);
          if (distance < reach + t.r && inTheWay(t, distance, reach, ground)) return false;
        }
      }
    }
    return true;
  }

  function clearOfBuildings(x: number, z: number, reach: number): boolean {
    const y = world.heightAt(x, z) + 1;
    if (world.buildingAt(x, y, z)) return false;
    for (let k = 0; k < 8; k++) {
      const angle = (k / 8) * Math.PI * 2;
      if (world.buildingAt(x + Math.sin(angle) * reach, y, z + Math.cos(angle) * reach)) return false;
    }
    return true;
  }

  return {
    clear: (x, z, reach) => clearOfBuildings(x, z, reach) && clearOfTrees(x, z, reach),
  };
}
