import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSampler } from "../terrain/terrainSampler";
import type { PropDef } from "../props/propTypes";
import { arrangeProp, setDown, type PlacedProp } from "../props/propGroups";
import { measureProp } from "../props/propGenerator";
import { deriveSeed, mulberry32 } from "../rng";
import type { RoadNetwork } from "./roadNetwork";
import type { PlaceLabel } from "../worldData";

/**
 * Fingerposts at the roads' junctions: a post in the widest wedge between the roads, and on it an
 * arm down each road that leads somewhere - pointing along it, saying where it leads (the nearest
 * place that way, by road) and how far. Each arm is a prop of its own with a label of its own: a
 * player by the post reads one by pointing at it (see ui/placeLabels.ts).
 */
export interface RoadSigns {
  props: PlacedProp[];
  labels: PlaceLabel[];
}

/** Where a road's end is, rounded so the ends meeting at one junction share it. */
const KEY_SNAP = 0.5;
/** A stretch's end this near a place's gate is at that gate. */
const GATE_SNAP = 4;
/** No fingerpost this near a place's gate - its own roads' ends, not a crossroads. */
const GATE_CLEARANCE = 25;
/** How far along a branch its way is judged, metres - past the junction's own curve. */
const BRANCH_LOOK = 12;
/** The post stands this far from either road's middle beside it (in their widths), past their
 *  surface; no further out from the junction than POST_MAX_OUT. */
const POST_FROM_ROAD = 5.5;
const POST_MAX_OUT = 22;
/** And this clear of any levelled ground (a building's, a prop's). */
const POST_PAD_CLEARANCE = 2;
/** Its arms: the top one this far under the post's head, each next this much lower. */
const ARM_TOP = 0.35;
const ARM_STEP = 0.32;
const SIGN_SALT = 2207;
/** How many places down a branch are looked for; and how far apart two posts stand at the least -
 *  one for a cluster of junctions close together. */
const BRANCH_PLACES = 4;
const POST_SPACING = 120;

export function planRoadSigns(network: Pick<RoadNetwork, "stretches" | "gates" | "places">, sampleTerrain: TerrainSampler, props: ReadonlyMap<string, PropDef>, seed: number): RoadSigns {
  const postDef = props.get("fingerpost");
  const armDef = props.get("fingerArm");
  if (!postDef || !armDef) return { props: [], labels: [] };
  const key = (p: CellPoint): string => `${Math.round(p.x / KEY_SNAP)},${Math.round(p.z / KEY_SNAP)}`;

  // The network's nodes - where stretches end - and the stretches between them.
  interface End {
    stretch: number;
    atStart: boolean;
  }
  const nodes = new Map<string, { at: CellPoint; ends: End[]; place: number | null }>();
  const lengths: number[] = [];
  network.stretches.forEach((stretch, i) => {
    let length = 0;
    for (let k = 1; k < stretch.points.length; k++) length += Math.hypot(stretch.points[k].x - stretch.points[k - 1].x, stretch.points[k].z - stretch.points[k - 1].z);
    lengths.push(length);
    for (const atStart of [true, false]) {
      const at = atStart ? stretch.points[0] : stretch.points[stretch.points.length - 1];
      const node = nodes.get(key(at)) ?? { at, ends: [], place: null };
      node.ends.push({ stretch: i, atStart });
      nodes.set(key(at), node);
    }
  });
  const gates: { x: number; z: number; place: number }[] = network.gates.flatMap((list, place) => list.map((gate) => ({ x: gate.x, z: gate.z, place })));
  for (const node of nodes.values()) {
    const gate = gates.find((g) => Math.hypot(g.x - node.at.x, g.z - node.at.z) < GATE_SNAP);
    if (gate) node.place = gate.place;
  }
  const otherEnd = (end: End): string => {
    const s = network.stretches[end.stretch];
    return key(end.atStart ? s.points[s.points.length - 1] : s.points[0]);
  };

  /** The places down a branch, nearest first, by road - never back through the junction - and how
   *  far each is. */
  const leadsTo = (junction: string, branch: End): { place: number; distance: number }[] => {
    const best = new Map<string, number>([[otherEnd(branch), lengths[branch.stretch]]]);
    const done = new Set<string>([junction]);
    const found: { place: number; distance: number }[] = [];
    for (;;) {
      let next: string | null = null;
      let nextDistance = Infinity;
      for (const [k, d] of best) if (!done.has(k) && d < nextDistance) [next, nextDistance] = [k, d];
      if (next === null || found.length >= BRANCH_PLACES) return found;
      done.add(next);
      const node = nodes.get(next)!;
      // A place's gate is the road's end: it is found, and not gone through.
      if (node.place !== null) {
        if (!found.some((f) => f.place === node.place)) found.push({ place: node.place, distance: nextDistance });
        continue;
      }
      for (const end of node.ends) {
        const far = otherEnd(end);
        if (done.has(far)) continue;
        const d = nextDistance + lengths[end.stretch];
        if (d < (best.get(far) ?? Infinity)) best.set(far, d);
      }
    }
  };
  /** Which way a branch leaves the junction, judged BRANCH_LOOK along it. */
  const wayOf = (end: End): { x: number; z: number; widthScale: number } => {
    const s = network.stretches[end.stretch];
    const points = end.atStart ? s.points : [...s.points].reverse();
    let travelled = 0;
    let p = points[points.length - 1];
    for (let k = 1; k < points.length; k++) {
      travelled += Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z);
      if (travelled >= BRANCH_LOOK) {
        p = points[k];
        break;
      }
    }
    const l = Math.hypot(p.x - points[0].x, p.z - points[0].z) || 1;
    return { x: (p.x - points[0].x) / l, z: (p.z - points[0].z) / l, widthScale: s.widthScale };
  };
  const nameOf = (place: number): string => {
    const p = network.places[place];
    return p.feature ? (p.feature.name ?? p.feature.kind.name) : p.name;
  };
  const distanceText = (metres: number): string => `${Math.max(0.1, metres / 1000).toFixed(1)} km`;

  const out: RoadSigns = { props: [], labels: [] };
  /** The junctions with a post already. */
  const posts: CellPoint[] = [];
  const postHeight = (variant: number): number => measureProp(postDef, seed, variant).height;
  for (const [k, node] of nodes) {
    if (node.ends.length < 3 || node.place !== null) continue;
    if (gates.some((g) => Math.hypot(g.x - node.at.x, g.z - node.at.z) < GATE_CLEARANCE)) continue;
    if (posts.some((p) => Math.hypot(p.x - node.at.x, p.z - node.at.z) < POST_SPACING)) continue;
    // Each road's arm names the nearest place down it that no road nearer its own place names -
    // two roads round a loop to one place do not both point at it.
    const branches = node.ends.map((end) => ({ end, places: leadsTo(k, end) })).filter((b) => b.places.length > 0).sort((p, q) => p.places[0].distance - q.places[0].distance);
    const named = new Set<number>();
    const arms = branches.flatMap(({ end, places }) => {
      const to = places.find((p) => !named.has(p.place));
      if (!to) return [];
      named.add(to.place);
      return [{ way: wayOf(end), to }];
    });
    if (arms.length < 2) continue;
    // The post: in the widest wedge between the junction's roads, as far out as it must be to stand
    // clear of the two roads either side of it.
    const angles = node.ends.map((end) => {
      const way = wayOf(end);
      return { a: Math.atan2(way.z, way.x), w: way.widthScale };
    }).sort((p, q) => p.a - q.a);
    let gap = { from: angles[angles.length - 1], to: angles[0], size: angles[0].a + Math.PI * 2 - angles[angles.length - 1].a };
    for (let i = 1; i < angles.length; i++) if (angles[i].a - angles[i - 1].a > gap.size) gap = { from: angles[i - 1], to: angles[i], size: angles[i].a - angles[i - 1].a };
    const bisector = gap.from.a + gap.size / 2;
    const out_ = (POST_FROM_ROAD * Math.max(gap.from.w, gap.to.w)) / Math.max(0.2, Math.sin(gap.size / 2));
    if (out_ > POST_MAX_OUT) continue;
    const x = node.at.x + Math.cos(bisector) * out_;
    const z = node.at.z + Math.sin(bisector) * out_;
    const ground = sampleTerrain(x, z);
    if (!ground.isLand || ground.lakeFactor > 0.02 || ground.padGap < POST_PAD_CLEARANCE || ground.roadGap < POST_FROM_ROAD - 0.5) continue;

    const rng = mulberry32(deriveSeed(deriveSeed(seed, SIGN_SALT), Math.round(node.at.x) * 7919 + Math.round(node.at.z)));
    const [post] = setDown(arrangeProp(postDef, seed, rng), x, z, Math.cos(bisector), Math.sin(bisector), 0);
    posts.push(node.at);
    post.y = ground.height;
    out.props.push(post);
    const top = postHeight(post.variant);
    arms.forEach(({ way, to }, n) => {
      const [arm] = setDown(arrangeProp(armDef, seed, rng), x, z, way.x, way.z, 0);
      arm.on = post;
      arm.lift = top - ARM_TOP - n * ARM_STEP;
      arm.y = post.y + arm.lift;
      out.props.push(arm);
      // Its label at the board's middle, a little toward its point.
      const along = arm.halfDepth * 0.6;
      out.labels.push({ x: x + way.x * along, y: arm.y, z: z + way.z * along, text: `${nameOf(to.place)} · ${distanceText(to.distance)}`, hover: true });
    });
  }
  return out;
}
