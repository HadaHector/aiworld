// Builds every beast plan (beasts/<id>.json5, see BEASTS.md) at several seeds and checks it: the
// same seed twice gives the same body; triangles and bones; feet on the ground; weights summing to
// one; every bone a gait names exists; the gaits bake and the animator runs a few seconds of each
// speed, dying and getting up, with no NaN in any pose; the atlas paints. Then the gaits in the world: each
// gait run for ten seconds, its feet followed (forward kinematics of the animator's poses, the body carried
// forward at the speed): a foot that is down must stay where it came down. Fails over 3 cm of slide, or a
// sole more than 2 cm under the ground.
// npm run probe -- scripts/probe/beast.mjs [beastId]
import { packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
const { resolveBeasts } = await import("../../src/character/beast/beastDef.ts");
const { buildBeast } = await import("../../src/character/beast/beastBuild.ts");
const { paintBeast } = await import("../../src/character/beast/beastPaint.ts");
const { bakeGaits, createBeastAnimator, qmul } = await import("../../src/character/beast/beastAnim.ts");

const [only] = process.argv.slice(2);
const packs = packSourcesFromDisk(readConfigFromDisk()).sources;
const beasts = resolveBeasts(packs);
let failures = 0;
const fail = (message) => {
  failures++;
  console.log(`  FAIL ${message}`);
};

for (const def of beasts.values()) {
  if (only && def.id !== only) continue;
  console.log(`${def.id}: ${def.trunk.length} trunk segments, ${def.limbs.reduce((s, l) => s + l.count * (l.single ? 1 : 2), 0)} limbs, ${def.gaits.length} gaits, ${def.clips.size} clips`);
  for (const seed of [1, 2, 3, 77]) {
    const t0 = performance.now();
    const body = buildBeast(def, { seed, atlas: 256 });
    const t1 = performance.now();
    const again = buildBeast(def, { seed, atlas: 256 });
    if (again.positions.length !== body.positions.length || again.positions.some((v, i) => v !== body.positions[i])) fail(`seed ${seed}: not the same twice`);
    if (body.positions.some((v) => !Number.isFinite(v))) fail(`seed ${seed}: NaN in positions`);
    if (body.normals.some((v) => !Number.isFinite(v))) fail(`seed ${seed}: NaN in normals`);
    for (let v = 0; v < body.weights.length; v += 4) {
      const sum = body.weights[v] + body.weights[v + 1] + body.weights[v + 2] + body.weights[v + 3];
      if (Math.abs(sum - 1) > 1e-3) {
        fail(`seed ${seed}: vertex ${v / 4} weights sum to ${sum}`);
        break;
      }
    }
    for (const limb of body.limbs.filter((l) => l.walks)) if (Math.abs(limb.tip[1] - limb.sole) > 0.12) console.log(`  note: ${limb.set}${limb.side < 0 ? "L" : "R"} rests ${(limb.tip[1] - limb.sole).toFixed(3)} m off the ground (the stand pose puts it down)`);
    const t2 = performance.now();
    const painted = paintBeast(def, body, { seed });
    const t3 = performance.now();
    const baked = bakeGaits(def, body);
    const t4 = performance.now();
    const animator = createBeastAnimator(def, body, baked, seed);
    let bad = 0;
    let steps = 0;
    for (const [speed, seconds, extra] of [[0, 2, {}], [1, 2, {}], [3, 2, {}], [6, 2, {}], [0, 1, { play: "attack" }], [0, 2, { dead: true }], [0, 1, {}]]) {
      for (let t = 0; t < seconds; t += 1 / 30) {
        const pose = animator.update({ speed, ...(t === 0 ? extra : { dead: extra.dead }) }, 1 / 30);
        if (pose.step !== undefined) steps++;
        if (pose.rotations.some((v) => !Number.isFinite(v)) || pose.offset.some((v) => !Number.isFinite(v))) bad++;
      }
    }
    if (bad) fail(`seed ${seed}: ${bad} poses with NaN`);
    if (def.gaits.length && steps === 0) fail(`seed ${seed}: no footsteps`);
    if (seed === 1) console.log(`  ${body.triangles} triangles (${body.cards.count} cards), ${body.bones.length} bones, ${body.height.toFixed(2)} m tall, ${body.length.toFixed(2)} m long, ${body.width.toFixed(2)} m wide; parts ${body.parts.join(" ") || "-"}; build ${(t1 - t0).toFixed(1)} ms, paint ${(t3 - t2).toFixed(1)} ms, bake ${(t4 - t3).toFixed(1)} ms; ${steps} steps`);
    if (painted.atlas.length !== body.atlasSize * body.atlasSize * 4) fail("atlas size");
  }
}
// The gaits' feet in the world (moved here from beastGaits.mjs).
const rot = (q, v) => { const [x,y,z,w]=q; const u=[x,y,z]; const c=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; const t=c(u,v).map(e=>e*2); const ct=c(u,t); return [v[0]+t[0]*w+ct[0], v[1]+t[1]*w+ct[1], v[2]+t[2]*w+ct[2]]; };
for (const def of beasts.values()) {
  if (only && def.id !== only) continue;
  const body = buildBeast(def, { seed: 1 });
  const anim = createBeastAnimator(def, body, bakeGaits(def, body), 1);
  for (const speed of def.gaits.map(g => g.speed)) {
    let travelled = 0; const dt = 1/60;
    const walking = body.limbs.filter(l => l.walks);
    const stance = walking.map(() => null); let worst = 0; let lowest = 9, highest = -9;
    for (let f = 0; f < 600; f++) {
      const pose = anim.update({ speed }, dt); travelled += speed*dt;
      const R = [], H = [];
      body.bones.forEach((b, i) => {
        const w = Array.from(pose.rotations.slice(i*4, i*4+4));
        if (b.parent < 0) { R[i] = w; H[i] = [b.head[0]+pose.offset[0], b.head[1]+pose.offset[1], b.head[2]+pose.offset[2]]; }
        else { const p = b.parent; R[i] = qmul(R[p], w); const d = rot(R[p], [b.head[0]-body.bones[p].head[0], b.head[1]-body.bones[p].head[1], b.head[2]-body.bones[p].head[2]]); H[i] = [H[p][0]+d[0], H[p][1]+d[1], H[p][2]+d[2]]; }
      });
      if (f < 240) continue;
      walking.forEach((l, k) => {
        const last = l.bones[l.bones.length-1]; const b = body.bones[last];
        const d = rot(R[last], [b.tail[0]-b.head[0], b.tail[1]-b.head[1], b.tail[2]-b.head[2]]);
        const tip = [H[last][0]+d[0], H[last][1]+d[1], H[last][2]+d[2]];
        const worldZ = tip[2] + travelled; const y = tip[1] - l.sole;
        lowest = Math.min(lowest, y); highest = Math.max(highest, y);
        if (y < 0.004) { if (stance[k] === null) stance[k] = worldZ; else worst = Math.max(worst, Math.abs(worldZ - stance[k])); } else stance[k] = null;
      });
    }
    const bad = worst > 0.03 || lowest < -0.02;
    if (bad) failures++;
    console.log(`${bad ? '  FAIL ' : '  '}${def.id} @${speed} m/s: slide while down ${worst.toFixed(3)} m, sole y ${lowest.toFixed(3)}..${highest.toFixed(3)}`);
  }
}
console.log(failures ? `${failures} failures` : "all good");
process.exit(failures ? 1 : 0);
