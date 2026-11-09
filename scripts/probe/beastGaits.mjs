// Runs every beast plan's gaits for ten seconds each and follows its feet in the world (forward
// kinematics of the animator's poses, the body carried forward at the speed): a foot that is down
// must stay where it came down. Fails over 3 cm of slide, or a sole more than 2 cm under the ground.
// npm run probe -- scripts/probe/beastGaits.mjs
import { packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
const { resolveBeasts } = await import("../../src/character/beast/beastDef.ts");
const { buildBeast } = await import("../../src/character/beast/beastBuild.ts");
const { bakeGaits, createBeastAnimator, qmul } = await import("../../src/character/beast/beastAnim.ts");
let failures = 0;
const beasts = resolveBeasts(packSourcesFromDisk(readConfigFromDisk()).sources);
const rot = (q, v) => { const [x,y,z,w]=q; const u=[x,y,z]; const c=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; const t=c(u,v).map(e=>e*2); const ct=c(u,t); return [v[0]+t[0]*w+ct[0], v[1]+t[1]*w+ct[1], v[2]+t[2]*w+ct[2]]; };
for (const def of beasts.values()) {
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
    console.log(`${bad ? 'FAIL ' : ''}${def.id} @${speed} m/s: slide while down ${worst.toFixed(3)} m, sole y ${lowest.toFixed(3)}..${highest.toFixed(3)}`);
  }
}
console.log(failures ? `${failures} failures` : 'all good');
process.exit(failures ? 1 : 0);
