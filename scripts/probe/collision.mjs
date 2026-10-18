// Checks the collision system's maths at random against slow, obvious answers (see COLLISION.md).
//   npm run probe -- scripts/probe/collision.mjs
import { mulberry32 } from "../../src/world/rng.ts";
import {
  boxCorners, containsPoint, createCollisionWorld, createShape, heightfieldHeight, madd, normalize, quatFromEuler, rayShape, separate, toBoxFrame, vec3,
  createCharacterMotor,
} from "../../src/world/collision/index.ts";
import { PRESETS } from "../../src/collisionSandbox/presets.ts";
import { heightfieldTriangles } from "../../src/world/collision/raycast.ts";
import { takeCollisionStats } from "../../src/world/collision/stats.ts";

const rng = mulberry32(7);
const rand = (lo, hi) => lo + rng() * (hi - lo);
const randVec = (s) => vec3(rand(-s, s), rand(-s, s), rand(-s, s));
const randDir = () => {
  for (;;) {
    const v = randVec(1);
    const l = Math.hypot(v.x, v.y, v.z);
    if (l > 0.1 && l <= 1) return normalize(v);
  }
};

let failures = 0;
function check(ok, what) {
  if (ok) return;
  failures++;
  if (failures <= 20) console.log("FAIL", what);
}

function randomDesc(spread = 4) {
  const kind = ["sphere", "capsule", "box", "convex"][Math.floor(rng() * 4)];
  const center = randVec(spread);
  switch (kind) {
    case "sphere":
      return { kind, center, radius: rand(0.2, 1.5) };
    case "capsule":
      return { kind, a: center, b: madd(center, randDir(), rand(0, 2)), radius: rand(0.1, 0.8) };
    case "box":
      return { kind, center, half: vec3(rand(0.1, 1.5), rand(0.1, 1.5), rand(0.1, 1.5)), rotation: quatFromEuler(rand(0, 7), rand(0, 7), rand(0, 7)) };
    case "convex":
      return { kind, points: Array.from({ length: 4 + Math.floor(rng() * 12) }, () => madd(center, randVec(1.2), 1)) };
  }
}

function randomField() {
  const columns = 12, rows = 10;
  const heights = Array.from({ length: columns * rows }, () => rand(-3, 0));
  const holes = new Uint8Array((columns - 1) * (rows - 1)).map(() => (rng() < 0.1 ? 1 : 0));
  return { kind: "heightfield", originX: -6, originZ: -5, cell: 1, columns, rows, heights, holes, split: rng() < 0.5 ? "diagonal" : "centre" };
}

// --- Each shape's ray test, against marching along the ray and asking "inside yet?" ---------
const STEP = 0.002;
{
  let hits = 0;
  for (let n = 0; n < 4000; n++) {
    const desc = n % 10 === 0 ? randomField() : randomDesc(0.5);
    const shape = createShape(desc, 1);
    const origin = randVec(6);
    // Aim near the shape half the time, so plenty of rays hit.
    const dir = n % 2 ? randDir() : normalize(madd(randVec(1), origin, -1));
    const maxT = 14;
    const hit = rayShape(shape, origin, dir, maxT);
    const startsInside = containsPoint(shape, origin);
    // The first step that lands inside, marching from the start.
    let marched = null;
    if (!startsInside) {
      for (let t = 0; t <= maxT; t += STEP) {
        if (containsPoint(shape, madd(origin, dir, t))) { marched = t; break; }
      }
    }
    if (hit) hits++;
    if (startsInside) { check(hit === null, `${desc.kind}: hit from inside`); continue; }
    if (marched === null) {
      // A ray can graze a shape between two steps; only a hit deep in would be wrong.
      check(hit === null || !containsPoint(shape, madd(origin, dir, hit.t + 4 * STEP)) || desc.kind === "heightfield", `${desc.kind}: hit ${hit?.t} where marching found nothing`);
      continue;
    }
    // Ground is only entered through its top: coming in from a side or a hole's edge is no hit.
    if (desc.kind === "heightfield") {
      const before = madd(origin, dir, Math.max(0, marched - STEP));
      if (heightfieldHeight(shape, before.x, before.z) === null) continue;
    }
    check(hit !== null && Math.abs(hit.t - marched) <= 2 * STEP, `${desc.kind}: hit ${hit?.t} vs marched ${marched}`);
    if (hit) {
      const n1 = hit.normal;
      check(Math.abs(Math.hypot(n1.x, n1.y, n1.z) - 1) < 1e-6, `${desc.kind}: normal not unit`);
      check(n1.x * dir.x + n1.y * dir.y + n1.z * dir.z <= 1e-9, `${desc.kind}: normal faces away from the ray`);
      check(!containsPoint(shape, madd(madd(origin, dir, hit.t), n1, 0.01)), `${desc.kind}: off the normal is still inside`);
    }
  }
  console.log(`shape rays: 4000 cast, ${hits} hit`);
}

// --- The world's search, against testing every shape -----------------------------------------
{
  const world = createCollisionWorld();
  const descs = [randomField(), ...Array.from({ length: 300 }, () => randomDesc(20))];
  const batchA = world.addBatch(descs.slice(0, 150));
  world.addBatch(descs.slice(150));
  for (let i = 0; i < 10; i++) world.add({ ...randomDesc(20), layers: 1 << (i % 3) });
  const all = () => {
    const out = [];
    world.forEachShapeInBounds({ min: vec3(-1e9, -1e9, -1e9), max: vec3(1e9, 1e9, 1e9) }, ~0, (s) => out.push(s));
    return out;
  };
  for (const round of [0, 1]) {
    if (round === 1) world.removeBatch(batchA);
    const shapes = all();
    let hits = 0;
    for (let n = 0; n < 3000; n++) {
      const origin = randVec(25);
      const dir = randDir();
      const mask = n % 4 === 0 ? 1 << (n % 3) : ~0;
      const got = world.raycast(origin, dir, 40, mask);
      let best = null;
      for (const s of shapes) {
        if (!(s.layers & mask)) continue;
        const hit = rayShape(s, origin, dir, best ? best.t : 40);
        if (hit) best = { ...hit, s };
      }
      if (best) hits++;
      check((got === null) === (best === null) && (!got || Math.abs(got.distance - best.t) < 1e-9), `world ray: ${got?.distance} vs ${best?.t}`);
      check(world.raycastAny(origin, dir, 40, mask) === (best !== null), "world raycastAny disagrees");
    }
    console.log(`world rays (${round ? "one batch removed" : "both batches"}): 3000 cast, ${hits} hit, ${shapes.length} shapes`);
  }
}

// --- Distance and the way out, against sampling the querier ---------------------------------
const sub3 = (a, b) => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len3 = (a) => Math.hypot(a.x, a.y, a.z);

/** The point of a triangle nearest p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p, a, b, c) {
  const ab = sub3(b, a), ac = sub3(c, a), ap = sub3(p, a);
  const d1 = dot3(ab, ap), d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub3(p, b), d3 = dot3(ab, bp), d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return madd(a, ab, d1 / (d1 - d3));
  const cp = sub3(p, c), d5 = dot3(ab, cp), d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return madd(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return madd(b, sub3(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const denom = 1 / (va + vb + vc);
  return madd(madd(a, ab, vb * denom), ac, vc * denom);
}

/** How far a point is outside a shape - negative inside - the slow way. */
function signedDistance(shape, p) {
  switch (shape.kind) {
    case "sphere":
      return len3(sub3(p, shape.center)) - shape.radius;
    case "capsule": {
      const ab = sub3(shape.b, shape.a);
      const t = Math.min(1, Math.max(0, dot3(sub3(p, shape.a), ab) / Math.max(dot3(ab, ab), 1e-18)));
      return len3(sub3(p, madd(shape.a, ab, t))) - shape.radius;
    }
    case "box": {
      const q = toBoxFrame(shape, p);
      const dx = Math.abs(q.x) - shape.half.x, dy = Math.abs(q.y) - shape.half.y, dz = Math.abs(q.z) - shape.half.z;
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0);
    }
    case "convex": {
      const inside = Math.max(...shape.planes.map((pl) => dot3(pl.normal, p) - pl.d));
      if (inside < 0) return inside;
      let best = Infinity;
      const t = shape.triangles;
      for (let i = 0; i < t.length; i += 3) best = Math.min(best, len3(sub3(p, closestOnTriangle(p, shape.points[t[i]], shape.points[t[i + 1]], shape.points[t[i + 2]]))));
      return best;
    }
  }
}

function randomQuery(spread) {
  const radius = rand(0.1, 0.8);
  const center = randVec(spread);
  return rng() < 0.3 ? { kind: "sphere", center, radius } : { kind: "capsule", a: center, b: madd(center, randDir(), rand(0, 2)), radius };
}
const samplesOf = (q, n = 400) => (q.kind === "sphere" ? [q.center] : Array.from({ length: n + 1 }, (_, i) => madd(q.a, sub3(q.b, q.a), i / n)));
const moved = (q, d) => (q.kind === "sphere" ? { ...q, center: madd(q.center, d, 1) } : { ...q, a: madd(q.a, d, 1), b: madd(q.b, d, 1) });

{
  let apart = 0, overlapping = 0;
  for (let n = 0; n < 3000; n++) {
    const shape = createShape(randomDesc(0.3), 1);
    const q = randomQuery(n % 3 === 0 ? 1 : 2.5);
    const sep = separate(q, shape);
    const reference = Math.min(...samplesOf(q).map((p) => signedDistance(shape, p))) - q.radius;
    check(Math.abs(len3(sep.normal) - 1) < 1e-6, `${shape.kind}: normal not unit`);
    if (reference > 1e-3) {
      apart++;
      check(Math.abs(sep.distance - reference) < 2e-3, `${shape.kind} vs ${q.kind}: distance ${sep.distance} vs ${reference}`);
      check(Math.abs(signedDistance(shape, sep.point)) < 1e-6, `${shape.kind}: nearest point off the surface`);
    } else if (reference < -1e-3) {
      overlapping++;
      check(sep.distance < 0, `${shape.kind} vs ${q.kind}: says apart (${sep.distance}) when overlapping (${reference})`);
      // Out by the depth it gives: clear. A sphere's way out is exact.
      const out = moved(q, vec3(sep.normal.x * (1e-4 - sep.distance), sep.normal.y * (1e-4 - sep.distance), sep.normal.z * (1e-4 - sep.distance)));
      const after = Math.min(...samplesOf(out).map((p) => signedDistance(shape, p))) - q.radius;
      check(after > -2e-3, `${shape.kind} vs ${q.kind}: still in by ${after} after moving out ${-sep.distance}`);
      if (q.kind === "sphere") check(Math.abs(sep.distance - reference) < 1e-6, `${shape.kind} vs sphere: depth ${sep.distance} vs ${reference}`);
      // Never further than straight out past the whole shape.
      check(-sep.distance <= len3(sub3(shape.bounds.max, shape.bounds.min)) + 2 * q.radius + 2 + 1e-6, `${shape.kind}: way out too long`);
    }
  }
  console.log(`separation: 3000 pairs, ${apart} apart, ${overlapping} overlapping`);
}

// --- Against the ground ----------------------------------------------------------------------
{
  const world = createCollisionWorld();
  const field = randomField();
  field.holes = undefined;
  world.addBatch([field]);
  const shape = world.shape(1);
  const groundGap = (p) => {
    let best = Infinity;
    for (let row = 0; row < field.rows - 1; row++) for (let col = 0; col < field.columns - 1; col++) {
      for (const [a, b, c] of heightfieldTriangles(shape, col, row)) best = Math.min(best, len3(sub3(p, closestOnTriangle(p, a, b, c))));
    }
    const h = heightfieldHeight(shape, p.x, p.z);
    return h !== null && p.y < h ? -best : best;
  };
  let ins = 0;
  for (let n = 0; n < 600; n++) {
    let q = randomQuery(1);
    q = moved(q, vec3(rand(-3, 3), rand(-2.5, 0.5), rand(-3, 3)));
    const samples = samplesOf(q, 40);
    const reference = Math.min(...samples.map(groundGap)) - q.radius;
    const contacts = world.overlap(q);
    if (reference > 2e-3) { check(contacts.length === 0, `ground: contact when ${reference} clear`); continue; }
    if (reference > -2e-3) continue;
    ins++;
    check(contacts.length > 0, `ground: no contact when in by ${-reference}`);
    // Pushed out the way the deepest contacts say, a few times over: clear, and above the ground.
    let out = q;
    let rounds = 0;
    // (This ground is far rougher than any real one - a few rounds more than the motor would need.)
    for (let i = 0; i < 40; i++) {
      const cs = world.overlap(out);
      if (cs.length === 0) break;
      rounds++;
      const deepest = cs.reduce((a, b) => (b.depth > a.depth ? b : a));
      out = moved(out, vec3(deepest.normal.x * (deepest.depth + 1e-4), deepest.normal.y * (deepest.depth + 1e-4), deepest.normal.z * (deepest.depth + 1e-4)));
    }
    const after = Math.min(...samplesOf(out, 40).map(groundGap)) - q.radius;
    check(after > -2e-3, `ground: still in by ${-after} after pushing out ${rounds} times, contacts left ${world.overlap(out).length}`);
  }
  console.log(`ground: 600 queries, ${ins} in the ground`);
}

// --- Sweeps: never through anything, stopping right at the first touch -----------------------
{
  const world = createCollisionWorld();
  const field = randomField();
  field.originX = -12; field.originZ = -10; field.cell = 2; field.heights = field.heights.map((h) => h - 6);
  // Ground is only solid through its top: a hole's sides are open, walled - if at all - by other shapes.
  field.holes = undefined;
  world.addBatch([field, ...Array.from({ length: 60 }, () => randomDesc(8))]);
  let hits = 0, clear = 0, inside = 0;
  let worstKind = "";
  const gapOf = (q) => {
    let gap = Infinity;
    world.forEachSeparation(q, 0.5, ~0, (s, sep) => { if (sep.distance < gap) { gap = sep.distance; worstKind = s.kind; } });
    return gap;
  };
  for (let n = 0; n < 1500; n++) {
    const q = randomQuery(8);
    const delta = madd(vec3(), randDir(), rand(0.5, 12));
    const total = len3(delta);
    const dir = normalize(delta);
    const hit = world.sweep(q, delta);
    if (hit?.startedInside) { inside++; check(gapOf(q) < 0, "sweep: says it starts inside when it is clear"); continue; }
    const reach = hit ? hit.distance : total;
    // Every point along the way it got: clear.
    let worst = Infinity;
    for (let i = 0; i <= 200; i++) worst = Math.min(worst, gapOf(moved(q, madd(vec3(), dir, (reach * i) / 200))));
    let worstAt = "";
    for (let i = 0; i <= 200; i++) { const g = gapOf(moved(q, madd(vec3(), dir, (reach * i) / 200))); if (g <= worst + 1e-12) worstAt = worstKind + " " + JSON.stringify(q) + " " + JSON.stringify(dir) + " at " + (reach * i) / 200; }
    check(worst > -1e-3, `sweep: passes ${-worst} into ${worstAt} before stopping at ${reach}`);
    if (hit) {
      hits++;
      const at = moved(q, madd(vec3(), dir, hit.distance));
      check(gapOf(at) < 2e-3, `sweep: stopped ${gapOf(at)} short of what it hit`);
      check(Math.abs(hit.fraction - hit.distance / total) < 1e-9, "sweep: fraction wrong");
    } else {
      clear++;
    }
  }
  console.log(`sweeps: 1500, ${hits} hit, ${clear} clear, ${inside} started inside`);
}

// --- The motor, walking the sandbox's scenes --------------------------------------------------
{
  const SPEED = 6;
  /** Walks a preset's way for `seconds` (jumping when asked), and reports where it went. */
  function walk(id, seconds, { jumpAt = [], settings = {}, heading } = {}) {
    const preset = PRESETS.find((p) => p.id === id);
    const world = createCollisionWorld();
    world.addBatch(preset.shapes);
    const motor = createCharacterMotor(world, settings, preset.spawn);
    motor.teleport(preset.spawn);
    const dir = heading ?? preset.heading;
    const trace = [];
    let maxY = -Infinity, deepest = 0, groundedFrames = 0;
    const dt = 1 / 60;
    for (let f = 0; f < seconds * 60; f++) {
      const t = f * dt;
      motor.update(dt, { move: vec3(dir.x * SPEED, 0, dir.z * SPEED), jump: jumpAt.some((j) => Math.abs(j - t) < dt / 2) });
      const s = motor.state;
      trace.push({ ...s.feet });
      maxY = Math.max(maxY, s.feet.y);
      if (s.grounded) groundedFrames++;
      for (const c of world.overlap(motor.capsule())) deepest = Math.max(deepest, c.depth);
    }
    return { motor, trace, end: motor.state.feet, maxY, deepest, grounded: groundedFrames / (seconds * 60) };
  }
  const report = (name, ok, detail) => { check(ok, `motor ${name}: ${detail}`); console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(10)} ${detail}`); };
  console.log("motor scenarios:");
  const r = 0.4;

  let w = walk("wall", 3);
  report("wall", w.end.x + r <= 3.8 + 1e-3 && w.deepest < 1e-3, `stopped at x ${(w.end.x + r).toFixed(4)} (wall face 3.8), deepest ${w.deepest.toExponential(1)}`);

  w = walk("stair", 1.6);
  report("stair", Math.abs(w.end.y - 2.4) < 0.05 && w.end.x > 7, `up to y ${w.end.y.toFixed(3)} at x ${w.end.x.toFixed(2)}, grounded ${(w.grounded * 100).toFixed(0)}%`);

  w = walk("ledge", 3);
  report("ledge", w.maxY < 0.05 && w.end.x + r <= 2 + 1e-3, `held at x ${(w.end.x + r).toFixed(3)}, max y ${w.maxY.toFixed(3)}`);
  w = walk("ledge", 0.8, { jumpAt: [0.15] });
  report("ledge+jump", Math.abs(w.end.y - 1) < 0.05, `jumped onto y ${w.end.y.toFixed(3)}`);

  w = walk("steep", 4);
  report("steep", w.maxY < 0.6, `climbed no higher than ${w.maxY.toFixed(3)}`);
  w = walk("gentle", 1.5);
  report("gentle", Math.abs(w.end.y - 2.2) < 0.05, `walked up to y ${w.end.y.toFixed(3)}, grounded ${(w.grounded * 100).toFixed(0)}%`);
  // And back down without leaving the ground.
  {
    const preset = PRESETS.find((p) => p.id === "gentle");
    const world = createCollisionWorld();
    world.addBatch(preset.shapes);
    const motor = createCharacterMotor(world, {}, vec3(11, 2.2, 0));
    motor.teleport(vec3(11, 2.3, 0));
    let air = 0;
    for (let f = 0; f < 150; f++) { motor.update(1 / 60, { move: vec3(-SPEED, 0, 0), jump: false }); if (!motor.state.grounded) air++; }
    report("downhill", air <= 1 && motor.state.feet.y < 0.05, `${air} frames off the ground, ended at y ${motor.state.feet.y.toFixed(3)}`);
  }

  w = walk("ceiling", 2, { jumpAt: [0.2], heading: vec3(0, 0, 0) });
  report("ceiling", w.maxY + 1.8 <= 2.6 + 1e-3 && w.deepest < 1e-3, `head reached ${(w.maxY + 1.8).toFixed(4)} under a ceiling at 2.6`);

  w = walk("wedge", 4);
  const last = w.trace.slice(-60);
  const jitter = Math.max(...last.map((p) => Math.hypot(p.x - last[0].x, p.z - last[0].z)));
  report("wedge", w.deepest < 1e-3 && jitter < 0.01, `came to rest at x ${w.end.x.toFixed(3)}, moving ${jitter.toExponential(1)} over its last second`);

  w = walk("gap", 3);
  report("gap", w.end.x < 4 && w.deepest < 1e-3, `held at x ${w.end.x.toFixed(3)} by a gap of 0.7`);
  w = walk("gap", 3, { settings: { radius: 0.3 } });
  report("gap, thin", w.end.x > 6, `a thinner one got to x ${w.end.x.toFixed(3)}`);

  w = walk("pile", 4);
  report("pile", w.deepest < 1e-3, `ended at (${w.end.x.toFixed(2)}, ${w.end.y.toFixed(2)}, ${w.end.z.toFixed(2)}), deepest ${w.deepest.toExponential(1)}`);

  w = walk("hills", 5);
  report("hills", w.deepest < 1e-3 && w.grounded > 0.95, `grounded ${(w.grounded * 100).toFixed(0)}%, deepest ${w.deepest.toExponential(1)}`);

  // Put down inside a box: pushed out.
  {
    const world = createCollisionWorld();
    world.addBatch(PRESETS.find((p) => p.id === "ledge").shapes);
    const motor = createCharacterMotor(world);
    motor.teleport(vec3(3.9, 0.2, 0.3));
    report("spawn in", world.overlap(motor.capsule()).length === 0, `put at (3.9, 0.2), pushed to (${motor.state.feet.x.toFixed(2)}, ${motor.state.feet.y.toFixed(2)}, ${motor.state.feet.z.toFixed(2)})`);
  }

  // Put down inside a trunk of stacked pieces, each thinner than the capsule is tall - every
  // shortest way out of one leads into the next: still got out, and walks on at no great cost.
  {
    const world = createCollisionWorld();
    const pieces = [{ kind: "box", center: vec3(0, -0.5, 0), half: vec3(20, 0.5, 20) }];
    for (let i = 0; i < 6; i++) pieces.push({ kind: "box", center: vec3(0, 0.45 + i * 0.9, 0), half: vec3(1.5, 0.45, 1.5) });
    world.addBatch(pieces);
    const motor = createCharacterMotor(world);
    motor.teleport(vec3(0.2, 1.2, 0.1));
    const freed = world.overlap(motor.capsule()).length === 0;
    takeCollisionStats();
    for (let i = 0; i < 60; i++) motor.update(1 / 30, { move: vec3(-3, 0, 0), jump: false });
    const overlaps = takeCollisionStats().overlaps;
    report("in a trunk", freed && world.overlap(motor.capsule()).length === 0 && overlaps < 200, `got out to (${motor.state.feet.x.toFixed(2)}, ${motor.state.feet.y.toFixed(2)}, ${motor.state.feet.z.toFixed(2)}), ${overlaps} overlaps over the next 60 steps`);
  }
}

console.log(failures === 0 ? "all good" : `${failures} failures`);
process.exitCode = failures === 0 ? 0 : 1;
