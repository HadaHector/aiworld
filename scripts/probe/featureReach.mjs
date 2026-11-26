// Every compound can be walked to (FEATURES.md, *Reachable from two sides*; the owner's ruling of
// 2026-11-25): a feature need not be reachable from every side - a camp under a bank, a mine in a slope
// - but of its 4 approach directions (north, east, south, west) at least 2 must be clear. A direction
// is clear when the character can walk in from the edge of a disc round the yard, on that side, to the
// yard: a flood over a 1 m grid from the yard outward, each step no steeper than the motor's walk
// limit (DEFAULT_MOTOR.maxSlope; its step-up height is under that over a metre), not through deep
// water, a building or the compound's boundary (its openings are the gaps between its runs).
// Worlds: the riverLevels worlds (one autumn-wood zone with rivers; seed 4242 has the logging camp whose
// pad steps 3.4 m by a prop's pad) and the vale.
// And every prop its kind's list set down (CompoundLayout.looseProps) stands on level enough ground: the
// ground under its footprint and half a metre round rises no more than PROP_MAX_SLOPE over its run (the
// owner's note, 2026-11-25: no crates and barrels on slopes). A cemetery's graves (their own limit) and
// a boundary's gates are not in that list.
//   npm run probe -- scripts/probe/featureReach.mjs [seeds...] [--full]
const { pick } = await import("./mode.mjs");
const { packSourcesFromDisk, loadContentFromDisk } = await import("../diskContent.mjs");
const { readWorldConfig } = await import("../../src/world/content/worldConfig.ts");
const { resolveContent } = await import("../../src/world/content/resolveContent.ts");
const { createTerrainSampler } = await import("../../src/world/terrain/terrainSampler.ts");
const { polygonGap } = await import("../../src/world/features/yardShape.ts");
const { DEFAULT_MOTOR } = await import("../../src/world/collision/characterMotor.ts");
const { footprintSlope, PROP_MAX_SLOPE } = await import("../../src/world/features/compound.ts");

let failures = 0, checks = 0;
const check = (what, ok, detail = "") => { checks++; if (!ok) { failures++; console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`); } };
const log = console.log;
const quiet = (run) => { console.log = () => {}; console.info = () => {}; try { return run(); } finally { console.log = log; } };

/** The steepest rise a step of the grid may make: the walk limit's over a metre (the step-up is less). */
const GRID = 1;
const RISE = Math.max(DEFAULT_MOTOR.stepHeight, Math.tan((DEFAULT_MOTOR.maxSlope * Math.PI) / 180) * GRID);
/** Water deeper than this is swum, not walked. */
const DEEP = 1;
/** The disc walked in from reaches this far past the yard's levelled ground's blend. */
const APPROACH = 15;
const DIRECTIONS = ["north", "east", "south", "west"];
/** A direction's walk keeps within this angle of it (its quarter is 45 degrees either way). */
const WEDGE = (67.5 * Math.PI) / 180;
/** Clear directions a feature needs. */
const NEEDED = 2;

/** Which of the 4 directions a compound can be walked into from, and what blocked the rest. */
export function reach(sampleTerrain, layout) {
  const { yard } = layout;
  const cx = yard.x, cz = yard.z;
  const radius = Math.max(yard.radius, yard.level) + layout.padBlend.max + APPROACH;
  const n = Math.ceil(radius / GRID), side = 2 * n + 1;
  const at = (i, j) => [cx + (i - n) * GRID, cz + (j - n) * GRID];
  const inYard = (x, z) => (yard.outline ? polygonGap(yard.outline, x, z) === 0 && insidePolygon(yard.outline, x, z) : Math.hypot(x - yard.x, z - yard.z) < yard.radius);
  const height = new Float64Array(side * side).fill(NaN);
  const blocked = new Uint8Array(side * side);
  // Buildings and the boundary.
  const cellOf = (x, z) => [Math.round((x - cx) / GRID) + n, Math.round((z - cz) / GRID) + n];
  const mark = (x, z) => { const [i, j] = cellOf(x, z); if (i >= 0 && j >= 0 && i < side && j < side) blocked[j * side + i] = 1; };
  for (const b of layout.buildings) {
    const ux = -b.frontZ, uz = b.frontX;
    for (let a = -b.width / 2; a <= b.width / 2; a += GRID / 2) for (let d = -b.depth / 2; d <= b.depth / 2; d += GRID / 2) mark(b.x + ux * a + b.frontX * d, b.z + uz * a + b.frontZ * d);
  }
  for (const run of layout.walls) {
    if (run.width !== undefined || run.breach || run.prop.collide === false) continue; // A bridge, a breach (fallen wall, rubble), a mine's track: walked over.
    for (let k = 1; k < run.points.length; k++) {
      const p = run.points[k - 1], q = run.points[k], len = Math.hypot(q.x - p.x, q.z - p.z), steps = Math.max(1, Math.ceil(len / (GRID / 2)));
      for (let s = 0; s <= steps; s++) mark(p.x + ((q.x - p.x) * s) / steps, p.z + ((q.z - p.z) * s) / steps);
    }
  }
  const ground = (k) => {
    if (Number.isNaN(height[k])) {
      const [x, z] = at(k % side, Math.floor(k / side));
      const s = sampleTerrain(x, z);
      height[k] = s.height;
      if (s.waterSurface - s.height > DEEP) blocked[k] = 1;
    }
    return height[k];
  };
  const yard0 = [];
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    const [x, z] = at(i, j), k = j * side + i;
    if (inYard(x, z)) { ground(k); if (!blocked[k]) yard0.push(k); }
  }
  // Each direction walked on its own: out from the yard within its wedge (its quarter and some room to
  // wind either side), across the levelled ground anywhere, to the rim in its own quarter.
  const clear = [false, false, false, false];
  let worstWall = 0;
  const seen = new Uint8Array(side * side);
  for (let d = 0; d < 4; d++) {
    seen.fill(0);
    const queue = [...yard0];
    for (const k of queue) seen[k] = 1;
    const facing = (d * Math.PI) / 2;
    const off = (x, z) => Math.abs(((Math.atan2(x - cx, z - cz) - facing + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    for (let head = 0; head < queue.length && !clear[d]; head++) {
      const k = queue[head], i = k % side, j = Math.floor(k / side);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj, nk = nj * side + ni;
        if (ni < 0 || nj < 0 || ni >= side || nj >= side || seen[nk]) continue;
        const [x, z] = at(ni, nj), r = Math.hypot(x - cx, z - cz);
        if (r > radius) continue;
        if (r > yard.level && off(x, z) > WEDGE) continue;
        const h = ground(nk);
        if (blocked[nk]) continue;
        const rise = Math.abs(h - height[k]);
        if (rise > RISE) { worstWall = Math.max(worstWall, rise); continue; }
        seen[nk] = 1;
        if (r > radius - 1.5 * GRID && off(x, z) <= Math.PI / 4) { clear[d] = true; break; }
        queue.push(nk);
      }
    }
  }
  const yardCells = yard0.length;
  return { clear, yardCells, radius, worstWall };
}

function insidePolygon(points, x, z) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

const riverContent = (() => {
  const config = readWorldConfig("probe", JSON.stringify({ world: { areas: [1, 1], rivers: [2, 2], riverLength: [4, 6], riverTributaries: [1, 1], riverLevels: true }, content: { only: { biomes: ["autumnWood"] } } }));
  return resolveContent(packSourcesFromDisk(config).sources, config, null);
})();
const vale = loadContentFromDisk("vale").content;
const given = process.argv.slice(2).map(Number).filter(Number.isFinite);
const worlds = [
  ...(given.length ? given : [1338, 7, 4242, 90210]).map((seed) => ({ seed, content: riverContent, name: "rivers" })),
  ...(given.length ? [] : Array.from({ length: pick(3, 8) }, (_, i) => ({ seed: 1000 + i * 7919, content: vale, name: "vale" }))),
];
let compounds = 0, loose = 0, steepest = 0;
const tally = [0, 0, 0, 0, 0];
for (const { seed, content, name } of worlds) {
  const t = quiet(() => createTerrainSampler(seed, content));
  const groundAt = (x, z) => t.sampleTerrain(x, z).height;
  for (const layout of t.compoundLayouts) {
    for (const prop of layout.looseProps ?? []) {
      if (prop.on) continue;
      loose++;
      const slope = footprintSlope({ x: prop.x, z: prop.z, ax: prop.frontZ, az: -prop.frontX, hw: prop.halfWidth, hd: prop.halfDepth }, groundAt);
      steepest = Math.max(steepest, slope);
      check(`${name} seed ${seed} ${layout.kindId} ${layout.featureId}: its ${prop.prop.id} stands on level enough ground`, slope <= PROP_MAX_SLOPE + 1e-6, `${slope.toFixed(3)} rise over run at (${prop.x.toFixed(0)}, ${prop.z.toFixed(0)})`);
    }
    if (layout.yard.level <= 0) continue; // A roadside one: no yard, on its road.
    compounds++;
    const r = reach(t.sampleTerrain, layout);
    const count = r.clear.filter(Boolean).length;
    tally[count]++;
    const where = `${name} seed ${seed} ${layout.kindId} ${layout.featureId} at (${layout.x.toFixed(0)}, ${layout.z.toFixed(0)})`;
    const dirs = DIRECTIONS.filter((_, d) => r.clear[d]).join(", ") || "none";
    check(`${where}: walked to from ${NEEDED} of 4 directions`, r.yardCells > 0 && count >= NEEDED, `clear: ${dirs}; ${r.yardCells} yard cells, steepest step refused ${r.worstWall.toFixed(1)} m in ${GRID} m`);
    if (name === "rivers" && seed === 4242 && Math.hypot(layout.x - 743, layout.z - 1074) < 60) log(`${where}: clear from ${dirs} (${count}/4); steepest step refused ${r.worstWall.toFixed(1)} m`);
  }
}
check("some compounds checked", compounds >= 5, `${compounds}`);
check("some props checked", loose >= 100, `${loose}`);
log(`featureReach: ${loose} props on the ground, steepest ${steepest.toFixed(3)} (limit ${PROP_MAX_SLOPE})`);
log(`featureReach: ${compounds} compounds, clear directions 0..4: ${tally.join(" / ")}`);
log(`${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
