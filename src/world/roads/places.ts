import type { FeatureSite } from "../features/featureSites";
import type { SettlementSite } from "../settlements/settlementSites";
import type { SettlementGate } from "../settlements/gates";
import { GATE_ROAD_EXCLUSION_MARGIN } from "../settlements/settlementConfig";
import { ROAD_CLASSES, type RoadClass } from "./roadConfig";

/**
 * Something the road network joins: a settlement, or a feature whose kind wants roads (its `road`
 * block - see PlaceRoadSpec). The network is planned over places, not over settlements with the
 * features hung off it afterwards, so a camp or an inn is as much an end of a road as a village is.
 */
export interface Place {
  /** Its index in the places list. The settlements come first, so a settlement's place id is its
   *  own id. */
  id: number;
  /** "settlement", or the feature's kind id - what other places' `wants` name. */
  kindId: string;
  name: string;
  x: number;
  z: number;
  /** The ground at its centre, and the circle its gates stand on. */
  height: number;
  radius: number;
  areaId: number;
  /** Roads keep out of this circle, but for its own. */
  avoidRadius: number;
  importance: number;
  /** The fewest roads it is given, and the most it takes. */
  links: [number, number];
  wants: string[];
  /** The longest straight line it is joined across. */
  maxLength: number;
  /**
   * Where its roads must arrive - a quarry has one way in, at its open front - each with its level
   * already set. Null for a place whose gates are found on its rim facing each road, as a
   * settlement's are.
   */
  fixedGates: SettlementGate[] | null;
  settlement: SettlementSite | null;
  feature: FeatureSite | null;
}

/** How much a settlement matters when its kind gives no road block - only an unloadable pack's. */
const FALLBACK_IMPORTANCE = 2;

/**
 * Every place the roads join: each settlement (in id order), then each feature whose kind has a
 * road block. A feature with no way in (no entrance) is left out.
 */
export function collectPlaces(settlements: SettlementSite[], features: FeatureSite[]): Place[] {
  const settlementKind = new Map(features.flatMap((feature) => (feature.settlement ? [[feature.settlement, feature.kind] as const] : [])));
  const places: Place[] = settlements.map((site) => {
    const road = settlementKind.get(site)?.road ?? null;
    const importance = road ? (typeof road.importance === "number" ? road.importance : road.importance[site.tier]) : FALLBACK_IMPORTANCE;
    return {
      id: site.id,
      kindId: "settlement",
      name: site.name,
      x: site.x,
      z: site.z,
      height: site.height,
      radius: site.radius,
      areaId: site.areaId,
      avoidRadius: Math.max(0, site.radius - GATE_ROAD_EXCLUSION_MARGIN),
      importance,
      links: road?.links ?? [1, Infinity],
      wants: road?.wants ?? [],
      maxLength: road?.maxLength ?? Infinity,
      fixedGates: null,
      settlement: site,
      feature: null,
    };
  });
  for (const feature of features) {
    const road = feature.kind.road;
    if (feature.settlement || !road) continue;
    const importance = typeof road.importance === "number" ? road.importance : road.importance.village;
    // A compound's gates are found on its circle, facing each road, as a settlement's are.
    const compound = feature.compound;
    if (compound) {
      places.push({
        id: places.length,
        kindId: feature.kind.id,
        name: `${feature.kind.name} #${feature.id}`,
        x: compound.x,
        z: compound.z,
        height: compound.height,
        radius: compound.radius,
        areaId: feature.areaId,
        // All of it: its roads are routed to points outside it, and its buildings reach near its edge.
        avoidRadius: compound.radius,
        importance,
        links: road.links,
        wants: road.wants,
        maxLength: road.maxLength,
        fixedGates: null,
        settlement: null,
        feature,
      });
      continue;
    }
    const entrance = feature.entrance;
    if (!entrance) continue;
    const angle = Math.atan2(entrance.approachZ - entrance.z, entrance.approachX - entrance.x);
    places.push({
      id: places.length,
      kindId: feature.kind.id,
      name: `${feature.kind.name} #${feature.id}`,
      x: feature.x,
      z: feature.z,
      height: entrance.height,
      radius: Math.hypot(entrance.x - feature.x, entrance.z - feature.z),
      areaId: feature.areaId,
      avoidRadius: feature.footprint,
      importance,
      links: road.links,
      wants: road.wants,
      maxLength: road.maxLength,
      fixedGates: [{ x: entrance.x, z: entrance.z, angle, approachX: entrance.approachX, approachZ: entrance.approachZ, roadHeight: entrance.height }],
      settlement: null,
      feature,
    });
  }
  return places;
}

/** Whether a road from `a` to `b` leads somewhere either of them wants. */
export function wanted(a: Place, b: Place): boolean {
  return a.wants.includes(b.kindId) || b.wants.includes(a.kindId);
}

/** How grand a road carrying this much traffic is - see ROAD_CLASSES. */
export function roadClassFor(traffic: number): RoadClass {
  return ROAD_CLASSES.find((roadClass) => traffic >= roadClass.minTraffic) ?? ROAD_CLASSES[ROAD_CLASSES.length - 1];
}
