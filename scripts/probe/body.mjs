// Builds every race's body, both sexes, bare and in each outfit (src/character, see CHARACTERS.md)
// and checks it: triangles per part; on the body, edges not shared by exactly two triangles (holes
// or overlaps in its surface); everywhere, neighbouring triangles wound against each other; faces
// turned toward their own bone; skin weights.
// npm run probe -- scripts/probe/body.mjs [raceId] [detail]
import { packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
const { resolveRaces, forSex, SEXES } = await import("../../src/character/raceDef.ts");
const { buildBody } = await import("../../src/character/bodyMesh.ts");
const { resolveGear, resolveOutfits } = await import("../../src/character/gearDef.ts");

const [only, detailArg] = process.argv.slice(2);
const packs = packSourcesFromDisk(readConfigFromDisk()).sources;
const races = resolveRaces(packs);
const gear = resolveGear(packs);
const outfits = resolveOutfits(packs, gear);
const dressings = [["bare", []], ...[...outfits.values()].map((o) => [o.id, o.gear.map((id) => gear.get(id))])];

for (const base of races.values()) for (const sex of SEXES) for (const [dressing, worn] of dressings) {
  if (only && base.id !== only) continue;
  const race = forSex(base, sex);
  const body = buildBody(race, { detail: Number(detailArg) || 1, gear: worn });
  const P = body.positions, I = body.indices;
  const p = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const onBody = (t) => body.triangleLayers[t] < 0;
  // The body is closed: every edge of its own triangles shared by exactly two of them.
  const edges = new Map();
  for (let t = 0; t < I.length; t += 3) {
    if (!onBody(t / 3)) continue;
    for (let e = 0; e < 3; e++) {
      const a = I[t + e], b = I[t + ((e + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const open = [...edges].filter(([, n]) => n !== 2);
  // Wound consistently, each shared edge is walked one way by one triangle and back by the other:
  // the same way twice means one of them is turned over.
  const directed = new Map();
  const partOf = (t) => (onBody(t) ? body.regions[body.triangleRegions[t]].name : `gear ${body.layers[body.triangleLayers[t]].material}`);
  for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) {
    const key = `${I[t + e]},${I[t + ((e + 1) % 3)]}`;
    directed.set(key, [...(directed.get(key) ?? []), t / 3]);
  }
  const flipped = new Map();
  for (const [, list] of directed) if (list.length > 1) for (const t of list) flipped.set(partOf(t), (flipped.get(partOf(t)) ?? 0) + 1);
  // Faces turned toward their bone (a thumb stands off its hand's axis, so some of its faces turn
  // toward it - expected; gear is left out, its pieces standing off their bones).
  let inward = 0;
  const inwardBones = new Map();
  const degenerate = [];
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [p(I[t]), p(I[t + 1]), p(I[t + 2])];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.hypot(...n) < 1e-10) { degenerate.push(t / 3); continue; }
    if (!onBody(t / 3)) continue;
    const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const bone = body.bones[body.joints[I[t] * 4]];
    const ab = [bone.tail[0] - bone.head[0], bone.tail[1] - bone.head[1], bone.tail[2] - bone.head[2]];
    const am = [mid[0] - bone.head[0], mid[1] - bone.head[1], mid[2] - bone.head[2]];
    const s = Math.min(1, Math.max(0, (am[0] * ab[0] + am[1] * ab[1] + am[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
    const out = [mid[0] - bone.head[0] - ab[0] * s, mid[1] - bone.head[1] - ab[1] * s, mid[2] - bone.head[2] - ab[2] * s];
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) { inward++; inwardBones.set(bone.name, (inwardBones.get(bone.name) ?? 0) + 1); }
  }
  let badWeights = 0;
  for (let v = 0; v < P.length / 3; v++) {
    const sum = body.weights.slice(v * 4, v * 4 + 4).reduce((s, w) => s + w, 0);
    if (Math.abs(sum - 1) > 1e-4) badWeights++;
  }
  const ys = P.filter((_, i) => i % 3 === 1);
  console.log(`${base.id} (${sex}, ${dressing}): ${body.triangles} triangles (${Object.entries(body.parts).map(([k, n]) => `${k} ${n}`).join(", ")}), ${(Math.max(...ys) - Math.min(...ys)).toFixed(2)} m tall, lowest ${Math.min(...ys).toFixed(3)}`);
  console.log(`  ${[...flipped.values()].reduce((x, y) => x + y, 0)} triangles turned against their neighbours${flipped.size ? ` (${[...flipped].map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}`);
  console.log(`  ${open.length} body edges not shared by two triangles${open.length ? `: ${open.slice(0, 8).map(([k, n]) => `${k}×${n}`).join(" ")}` : ""}`);
  console.log(`  ${inward} body triangles facing their bone${inward ? ` (${[...inwardBones].map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}, ${degenerate.length} degenerate, ${badWeights} vertices whose weights don't sum to 1`);
}
