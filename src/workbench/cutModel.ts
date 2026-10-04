import type { BuildingModel } from "../world/buildings/buildingTypes";

/**
 * A building cut open for the workbench, to see inside it: everything on the far side of a plane
 * taken away - over a height, for a plan of a level, or in front of a depth, for a section. Each
 * triangle the plane crosses is clipped along it, every vertex attribute carried across.
 */

/** The part kept: where `axis` is below `at` (y: under the cut; z: behind it; x: left of it). */
export interface Cut {
  axis: "x" | "y" | "z";
  at: number;
}

const AXIS = { x: 0, y: 1, z: 2 } as const;

export function cutModel(model: BuildingModel, cut: Cut): BuildingModel {
  const a = AXIS[cut.axis];
  const out: BuildingModel = { ...model, positions: [], normals: [], tangents: [], uvs: [], colors: [], materialSlots: [], indices: [] };
  type Vertex = { p: number[]; n: number[]; t: number[]; uv: number[]; c: number[]; slot: number };
  const vertex = (index: number): Vertex => ({
    p: model.positions.slice(index * 3, index * 3 + 3),
    n: model.normals.slice(index * 3, index * 3 + 3),
    t: model.tangents.slice(index * 3, index * 3 + 3),
    uv: model.uvs.slice(index * 2, index * 2 + 2),
    c: model.colors.slice(index * 4, index * 4 + 4),
    slot: model.materialSlots[index],
  });
  const mix = (p: number[], q: number[], s: number): number[] => p.map((v, i) => v + (q[i] - v) * s);
  const between = (u: Vertex, v: Vertex, s: number): Vertex => ({ p: mix(u.p, v.p, s), n: mix(u.n, v.n, s), t: mix(u.t, v.t, s), uv: mix(u.uv, v.uv, s), c: mix(u.c, v.c, s), slot: u.slot });
  const push = (v: Vertex): number => {
    out.positions.push(...v.p);
    out.normals.push(...v.n);
    out.tangents.push(...v.t);
    out.uvs.push(...v.uv);
    out.colors.push(...v.c);
    out.materialSlots.push(v.slot);
    return out.positions.length / 3 - 1;
  };
  for (let f = 0; f < model.indices.length; f += 3) {
    const polygon = [vertex(model.indices[f]), vertex(model.indices[f + 1]), vertex(model.indices[f + 2])];
    // Sutherland-Hodgman against the one plane.
    const kept: Vertex[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const u = polygon[i];
      const v = polygon[(i + 1) % polygon.length];
      const du = u.p[a] - cut.at;
      const dv = v.p[a] - cut.at;
      if (du <= 0) kept.push(u);
      if ((du <= 0) !== (dv <= 0)) kept.push(between(u, v, du / (du - dv)));
    }
    if (kept.length < 3) continue;
    const base = kept.map(push);
    for (let i = 1; i < base.length - 1; i++) out.indices.push(base[0], base[i], base[i + 1]);
  }
  return out;
}
