// A polygon-yard compound (the sheepfold) laid out on a patch of ground, over many seeds and variants:
// the yard's shape (convex, balanced, the area of its round), the buildings against its edges and
// clear of each other, its lanes and its wall, the props off the buildings.
// npm run probe -- scripts/probe/yardShape.mjs [kind] [seeds...]
const { loadContent } = await import("./loadContent.mjs");
const { buildFeaturePreview } = await import("../../src/workbench/featurePreview.ts");
const { polygonGap, offsetPolygon } = await import("../../src/world/features/yardShape.ts");
const content = loadContent();
const kindId = process.argv[2] ?? "sheepfold";
const seeds = process.argv.length > 3 ? process.argv.slice(3).map(Number) : [1338, 77, 4242, 9001];
const kind = content.featureKinds.find((k) => k.id === kindId);
if (!kind?.compound?.yard.polygon) throw new Error(`${kindId} has no polygon yard`);

const corners = (b) => {
  const ux = -b.frontZ, uz = b.frontX, wx = b.frontX, wz = b.frontZ;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => ({ x: b.x + ux * (b.width / 2) * a + wx * (b.depth / 2) * c, z: b.z + uz * (b.width / 2) * a + wz * (b.depth / 2) * c }));
};
const overlap = (p, q) => {
  for (const r of [p, q]) {
    for (const ax of [{ x: -r.frontZ, z: r.frontX }, { x: r.frontX, z: r.frontZ }]) {
      const proj = (b) => corners(b).map((c) => c.x * ax.x + c.z * ax.z);
      const a = proj(p), b = proj(q);
      if (Math.max(...a) < Math.min(...b) || Math.max(...b) < Math.min(...a)) return false;
    }
  }
  return true;
};
const segDist = (x, z, a, b) => { const dx = b.x - a.x, dz = b.z - a.z, L = dx * dx + dz * dz; const u = L > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / L)) : 0; return Math.hypot(x - a.x - u * dx, z - a.z - u * dz); };
const lineDist = (pts, x, z) => { let d = Infinity; for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(x, z, pts[i], pts[i + 1])); return d; };
const area = (poly) => Math.abs(poly.reduce((sum, p, i) => { const q = poly[(i + 1) % poly.length]; return sum + (p.x * q.z - q.x * p.z) / 2; }, 0));

let faults = 0;
const fault = (msg) => { faults++; if (faults <= 40) console.log("    FAULT", msg); };
const grounds = { flat: () => 30, slope: (x, z) => 30 + 0.08 * x + 0.04 * z };
const stats = { layouts: 0, corners: {}, dropped: 0, minBuildingGap: Infinity, minLane: Infinity, minFront: Infinity, maxArc: 0, areaRatio: [Infinity, 0], wallOff: [Infinity, 0], buildings: 0, props: 0, droppedProps: 0 };
for (const [name, height] of Object.entries(grounds)) {
  for (const seed of seeds) {
    for (let variant = 0; variant < 8; variant++) {
      const f = buildFeaturePreview(kind, content, seed, variant, false, height);
      const tag = `${name} seed ${seed} variant ${variant}`;
      const c = f.layout;
      stats.layouts++;
      const poly = c.yard.outline.map((p) => ({ x: p.x - c.x, z: p.z - c.z }));
      stats.corners[poly.length] = (stats.corners[poly.length] ?? 0) + 1;
      // The shape: convex, wound one way, the middle inside, no arc over 150 degrees, the round's area.
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n], d = poly[(i + 2) % n];
        if ((b.x - a.x) * (d.z - b.z) - (b.z - a.z) * (d.x - b.x) <= 0) fault(`${tag}: yard not convex at corner ${i}`);
        let arc = Math.atan2(b.z, b.x) - Math.atan2(a.z, a.x);
        arc = ((arc % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        stats.maxArc = Math.max(stats.maxArc, arc / (Math.PI * 2));
        if (arc > (150 / 180) * Math.PI) fault(`${tag}: an arc of ${((arc * 180) / Math.PI).toFixed(0)} degrees`);
      }
      if (polygonGap(poly, 0, 0) !== 0) fault(`${tag}: its middle is outside the yard`);
      // The buildings: against the rim, 5 m out from the yard's edge, clear of each other and the lanes.
      c.buildings.forEach((b, i) => {
        stats.buildings++;
        for (const p of corners(b)) {
          const d = polygonGap(c.yard.outline, p.x, p.z);
          stats.minFront = Math.min(stats.minFront, d);
          if (d < 4.9) fault(`${tag}: building ${i} (${b.building.id}) ${d.toFixed(2)} m from the yard - its setback is 5`);
        }
        for (let j = 0; j < i; j++) {
          if (overlap(b, c.buildings[j])) fault(`${tag}: buildings ${j} and ${i} overlap`);
        }
        for (const line of c.lanes) for (const p of [...corners(b), { x: b.x, z: b.z }]) {
          const d = lineDist(line.points, p.x, p.z);
          stats.minLane = Math.min(stats.minLane, d);
          if (d < 3.5) { fault(`${tag}: building ${i} stands on a lane`); break; }
        }
        // On its pad.
        let worst = 0;
        for (const p of [...corners(b), { x: b.x, z: b.z }]) worst = Math.max(worst, Math.abs(f.heightAt(p.x, p.z) - b.y));
        if (worst > 0.3) fault(`${tag}: building ${i} not on its pad: ${worst.toFixed(2)} m off`);
      });
      stats.dropped += c.droppedRequired;
      if (c.droppedRequired > 0) fault(`${tag}: ${c.droppedRequired} required buildings found no room`);
      // The yard level before the fronts: the yard's ground at the polygon's edge and a little out of it.
      const yardY = c.yard.y;
      for (let k = 0; k < n; k++) {
        const a = c.yard.outline[k], b = c.yard.outline[(k + 1) % n];
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const off = Math.abs(f.heightAt(mx, mz) - yardY);
        if (off > 0.3) { fault(`${tag}: yard not level at its edge ${k}: ${off.toFixed(2)} m off`); break; }
      }
      // The props: off the buildings, inside the level ground or out in the camp, off the lanes.
      for (const p of c.props) {
        stats.props++;
        const rect = { x: p.x, z: p.z, frontX: p.frontX, frontZ: p.frontZ, width: p.halfWidth * 2, depth: p.halfDepth * 2 };
        for (const b of c.buildings) if (overlap(rect, b)) { fault(`${tag}: prop ${p.prop.id} overlaps building ${b.building.id}`); break; }
        if (!["gate", "lychgate"].includes(p.prop.generator)) for (const line of c.lanes) if (lineDist(line.points, p.x, p.z) < p.reach) { fault(`${tag}: prop ${p.prop.id} on a lane`); break; }
        if (!["gate", "lychgate"].includes(p.prop.generator)) for (const run of c.walls) if (lineDist(run.points, p.x, p.z) < Math.min(p.halfWidth, p.halfDepth)) { fault(`${tag}: prop ${p.prop.id} stands in the wall`); break; }
      }
      stats.droppedProps += c.droppedProps.length;
      // The wall: along the yard moved out 8 m (setback 5 and a gate's 3), its corners mitred; through no building.
      const wallLine = offsetPolygon(c.yard.outline, 8);
      wallLine.push(wallLine[0]);
      for (const run of c.walls) for (const p of run.points) {
        const d = lineDist(wallLine, p.x, p.z);
        stats.wallOff = [Math.min(stats.wallOff[0], d), Math.max(stats.wallOff[1], d)];
        if (d > 0.35) { fault(`${tag}: the wall ${d.toFixed(2)} m off its line`); break; }
      }
      for (const run of c.walls) {
        for (const b of c.buildings) {
          const pts = run.points;
          if (pts.some((p) => overlap({ x: p.x, z: p.z, frontX: 0, frontZ: 1, width: 0.01, depth: 0.01 }, b))) { fault(`${tag}: a wall runs through building ${b.building.id}`); break; }
        }
      }
    }
  }
}
console.log(`${stats.layouts} layouts of ${kindId}: corners ${JSON.stringify(stats.corners)}, widest arc ${(stats.maxArc * 360).toFixed(0)} degrees, ${stats.buildings} buildings (nearest to the yard ${stats.minFront.toFixed(2)} m, nearest to a lane ${stats.minLane.toFixed(2)} m), ${stats.props} props (${stats.droppedProps} dropped), the wall ${stats.wallOff[1].toFixed(2)} m off its line at most`);
console.log(faults === 0 ? "no faults" : `${faults} faults`);
