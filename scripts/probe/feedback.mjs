// The feedback test (see FEEDBACK.md): the packs' sounds, particle effects, textures, cues and event
// table load and are checked; broken content gives the errors it should; every sound renders every
// take cleanly and every texture draws.
//   npm run probe -- scripts/probe/feedback.mjs
import { ContentError } from "../../src/world/content/contentReader.ts";
import { resolveGameRules } from "../../src/sim/rules/gameRules.ts";
import { resolveCreatureRules } from "../../src/sim/rules/creatureRules.ts";
import { packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { resolveFeedback, resolveRef, matchesPattern } from "../../src/feedback/rules.ts";
import { layerLength, renderSynth } from "../../src/audio/synth.ts";
import { SAMPLE_RATE } from "../../src/audio/dsp.ts";
import { buildParticleAtlas, drawParticleTexture } from "../../src/particles/textures.ts";
import { createCuePlayer } from "../../src/feedback/cues.ts";
import { createParticleSystem, curveAt } from "../../src/particles/system.ts";
import { EVENT_FLAG, EVENT_KIND } from "../../src/sim/skills/events.ts";

let failures = 0;
let checks = 0;
function check(what, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
}
async function section(name, run) {
  try {
    await run();
  } catch (error) {
    failures++;
    console.log(`FAIL ${name} threw:`, error);
  }
}

const CONFIG = "tiny";
const { sources } = packSourcesFromDisk(readConfigFromDisk(CONFIG));

/** The game rules with the creature kinds in, then the feedback - as the page loads them. */
function load(packs) {
  const game = resolveGameRules(packs);
  resolveCreatureRules(packs, game, 1234);
  return { game, feedback: resolveFeedback(packs, game) };
}

const { game, feedback } = load(sources);

// --- rules -----------------------------------------------------------------------------------------
await section("rules", () => {
  console.log(`feedback: ${feedback.sounds.size} sounds, ${feedback.effects.size} particle effects, ${feedback.textures.length} textures, ${feedback.cues.size} cues`);
  check("core has sounds, effects, textures and cues", feedback.sounds.size > 0 && feedback.effects.size > 0 && feedback.textures.length > 0 && feedback.cues.size > 0);
  const fireball = feedback.skillCues[game.skillIndex.get("fireball")];
  check("fireball names its phases' cues", fireball.cast === "fireCast" && fireball.projectile === "fireBolt" && fireball.impact === "fireImpact", JSON.stringify(fireball));
  const wolf = [...game.templates.values()].find((t) => t.id.startsWith("wolf"));
  check("a wolf kind's look carries its feedback", wolf?.look.feedback.weapon === "fang" && wolf?.look.feedback.armor === "fur", JSON.stringify(wolf?.look.feedback));
  check("the dummy's look carries its feedback", game.templates.get("trainingDummy")?.look.feedback.armor === "metal");
  check("the event table has melee hits", feedback.config.events.get("hit")?.[0]?.cue === "meleeHit");
  const meleeHit = feedback.cues.get("meleeHit");
  check("meleeHit's parts", meleeHit?.parts.map((p) => p.kind).join() === "sound,particles,shake,pause", meleeHit?.parts.map((p) => p.kind).join());
});

// --- placeholders and patterns -----------------------------------------------------------------------
await section("placeholders", () => {
  const has = (id) => feedback.sounds.has(id);
  const sound = (values) => resolveRef("hit.{weapon}.{armor}", values, has);
  check("most specific first", sound({ weapon: "blade", armor: "metal" }) === "hit.blade.metal");
  check("drops the armour it has no sound for", sound({ weapon: "blade", armor: "fur" }) === "hit.blade");
  check("falls back to the base", sound({ weapon: "tusk", armor: "fur" }) === "hit");
  check("a missing value stops the id", sound({ armor: "metal" }) === "hit");
  check("a plain id", resolveRef("swing", {}, has) === "swing" && resolveRef("nothing", {}, has) === null);
  check("patterns", matchesPattern("*Grass", "leafyGrass") && matchesPattern("snow*", "snowDrift") && !matchesPattern("*Sand", "sandstone") && matchesPattern("*", "x"));
});

// --- events to cues --------------------------------------------------------------------------------
await section("events to cues", () => {
  // Unit 1 is the player with a sword, 2 a dummy in plate, 3 a wolf going for the player, 4 someone else.
  const traits = { 1: { weapon: "blade", armor: "leather" }, 2: { armor: "metal" }, 3: { weapon: "fang", armor: "fur" }, 4: { weapon: "blade" } };
  const played = [];
  const fakeSfx = { play: (id, options) => (played.push({ id, own: options.own, gain: options.gain }), null) };
  const cues = createCuePlayer(feedback, game, {
    player: () => 1,
    target: () => 2,
    targetOf: (unit) => (unit === 3 ? 1 : 0),
    place: (unit) => ({ x: unit, y: 0, z: 0 }),
    traits: (unit) => traits[unit] ?? {},
  }, () => fakeSfx);
  const skill = (id) => game.skillIndex.get(id);
  const event = (kind, source, target, skillId, flags = 0, name = "") => ({ kind: EVENT_KIND[kind], source, target, skill: skillId === undefined ? -1 : skill(skillId), amount: 10, extra: 0, absorbed: 0, flags, reason: 0, name, time: 0 });
  const run = (...events) => {
    played.length = 0;
    cues.events(events);
    return played.map((p) => p.id).join(",");
  };
  check("a sword on plate", run(event("hit", 1, 2, "autoAttack")) === "hit.blade.metal", run(event("hit", 1, 2, "autoAttack")));
  check("a bite on leather falls back to the fang", run(event("hit", 3, 1, "bite")) === "hit.fang");
  check("a swing", run(event("animation", 1, 0, "autoAttack", 0, "swing")) === "swing");
  check("a melee miss", run(event("miss", 1, 2, "autoAttack")) === "whiff");
  check("a fireball's own impact", run(event("hit", 1, 2, "fireball")) === "impact.fire");
  check("a fireball's release", run(event("castDone", 1, 2, "fireball")) === "fire.release");
  check("an event with no cue plays nothing", run(event("heal", 1, 1, "renew")) === "");
  run(event("animation", 3, 0, "autoAttack", 0, "swing"));
  check("a wolf swinging at the player is the player's fight", played[0]?.own === true);
  run(event("hit", 4, 5, "autoAttack"));
  check("others' fights are quieter", played[0]?.own === false && played[0]?.gain === feedback.config.others.volume, JSON.stringify(played[0]));
  check("a hit on five targets sounds once", run(...[2, 5, 6, 7, 8].map((t) => event("hit", 1, t, "autoAttack", EVENT_FLAG.crit))).split(",").length <= 2);
});

// --- particles -------------------------------------------------------------------------------------
await section("particles", () => {
  const system = createParticleSystem(feedback);
  const near = { x: 0, y: 0, z: 0 };
  const burst = (id) => feedback.effects.get(id).emitters.reduce((n, e) => n + e.bursts.reduce((m, b) => m + b.count, 0), 0);
  // A one-shot's bursts at 0 are out at once, and gone when their lives are.
  const sparks = system.spawn("hit.metal", () => ({ x: 1, y: 1, z: 1 }), { own: true });
  check("a burst is out at once", system.sprites.count === burst("hit.metal"), `${system.sprites.count} of ${burst("hit.metal")}`);
  for (let i = 0; i < 30; i++) system.update(1 / 30, near);
  check("a one-shot is over once its particles are", system.sprites.count === 0 && !sparks.alive && system.effects() === 0);
  // Particles fall under gravity and are shaded by their curves.
  system.spawn("hit", () => ({ x: 0, y: 5, z: 0 }), { own: true });
  const chips = () => [...Array(system.meshes.count).keys()];
  const y0 = chips().reduce((sum, i) => sum + system.meshes.y[i], 0) / system.meshes.count;
  for (let i = 0; i < 6; i++) system.update(1 / 30, near);
  const y1 = chips().reduce((sum, i) => sum + system.meshes.y[i], 0) / Math.max(1, system.meshes.count);
  check("chips fall", y1 < y0, `${y0.toFixed(2)} -> ${y1.toFixed(2)}`);
  check("curves", curveAt([[0, 1], [0.5, 3], [1, 0]], 0.25) === 2 && curveAt([[0, 1], [1, 0]], 2) === 0 && curveAt([[0, 4]], 0.7) === 4);
  system.clear();
  // A looping effect plays until stopped; its local particles follow what it is on.
  const hand = { x: 0, y: 1, z: 0 };
  const fire = system.spawn("fireHands", () => hand, { own: true });
  for (let i = 0; i < 60; i++) system.update(1 / 30, near);
  check("a loop goes on", fire.alive && system.sprites.count > 10, `${system.sprites.count} sprites`);
  const glow = feedback.effects.get("fireHands").emitters.findIndex((e) => e.local);
  const glowIndex = system.emitters.indexOf(feedback.effects.get("fireHands").emitters[glow]);
  hand.x = 10;
  system.update(1 / 30, near);
  let followed = true;
  for (let i = 0; i < system.sprites.count; i++) if (system.sprites.emitter[i] === glowIndex && system.sprites.x[i] < 9) followed = false;
  check("local particles move with their attachment", followed);
  fire.stop();
  for (let i = 0; i < 90; i++) system.update(1 / 30, near);
  check("a stopped loop dies away", !fire.alive && system.sprites.count === 0);
  // Others' fights make fewer; far away makes none.
  system.spawn("hit.metal", () => near, { count: 0.5 });
  check("others' bursts are smaller", system.sprites.count === Math.round(14 * 0.5) + Math.round(1 * 0.5), String(system.sprites.count));
  system.clear();
  system.update(0, { x: 0, y: 0, z: 0 });
  check("effects beyond 60 m are not started", system.spawn("fireBurst", () => ({ x: 100, y: 0, z: 0 })) === null);
  // The budget: others' particles stop at it; the player's own push the oldest of others' out.
  for (let i = 0; i < 400; i++) system.spawn("fireBurst", () => near);
  check("the budget holds", system.sprites.count === system.sprites.capacity, `${system.sprites.count} of ${system.sprites.capacity}`);
  system.spawn("hit.metal", () => near, { own: true });
  let own = 0;
  for (let i = 0; i < system.sprites.count; i++) if (system.sprites.emitter[i] === system.emitters.indexOf(feedback.effects.get("hit.metal").emitters[0])) own++;
  check("the player's own particles get in over budget", own === 14, String(own));
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) system.update(1 / 60, near);
  console.log(`particles: a full pool (${system.sprites.capacity} sprites) steps in ${((performance.now() - t0) / 60).toFixed(2)} ms`);
  // Cues spawn their particle parts, with placeholders filled.
  const spawned = [];
  const fakeParticles = { spawn: (id) => (spawned.push(id), null) };
  const cues = createCuePlayer(feedback, game, { player: () => 1, target: () => 2, targetOf: () => 0, place: () => near, traits: (u) => (u === 2 ? { armor: "metal" } : u === 3 ? { armor: "fur" } : { weapon: "blade" }) }, () => null, () => fakeParticles);
  cues.play("meleeHit", { source: 1, target: 2, skill: null, crit: false, periodic: false });
  cues.play("meleeHit", { source: 1, target: 3, skill: null, crit: false, periodic: false });
  check("a cue's particles by armour", spawned.join() === "hit.metal,hit", spawned.join());
});

// --- broken content --------------------------------------------------------------------------------
await section("broken content", () => {
  const expectErrors = (what, files, ...expected) => {
    const extra = { id: "zzbroken", files: [{ path: "pack.json5", text: `{ name: "Broken", priority: 10 }` }, ...Object.entries(files).map(([path, text]) => ({ path, text }))] };
    try {
      load([...sources, extra]);
      check(what, false, "no error");
    } catch (error) {
      if (!(error instanceof ContentError)) throw error;
      const text = error.issues.map((i) => `${i.file} ${i.path}: ${i.message}`).join("\n");
      const missing = expected.filter((e) => !text.includes(e));
      check(what, missing.length === 0, `expected ${missing.map((m) => `"${m}"`).join(", ")} in:\n${text}`);
    }
  };
  expectErrors("an unknown sound in a cue", { "cues/bad.json5": `{ parts: [{ sound: "nope" }] }` }, `no sound "nope"`);
  expectErrors("an unknown placeholder", { "cues/bad.json5": `{ parts: [{ sound: "hit.{colour}" }] }` }, "unknown placeholder {colour}");
  expectErrors("a placeholder first", { "cues/bad.json5": `{ parts: [{ particles: "{armor}.x" }] }` }, "may not be the first part");
  expectErrors("an unknown particle effect", { "cues/bad.json5": `{ parts: [{ particles: "nope" }] }` }, `no particle effect "nope"`);
  expectErrors("a part with two kinds", { "cues/bad.json5": `{ parts: [{ sound: "hit", shake: 0.2 }] }` }, "needs exactly one of");
  expectErrors("a pause too long", { "cues/bad.json5": `{ parts: [{ pause: 0.5 }] }` }, "must be at most 0.08");
  expectErrors("a shake with a place", { "cues/bad.json5": `{ parts: [{ shake: 0.2, at: "source" }] }` }, "a shake has no place");
  expectErrors("an unknown generator field", { "sounds/bad.json5": `{ layers: [{ synth: { tone: "sine", wobble: 3 } }] }` }, "unknown field");
  expectErrors("two generators", { "sounds/bad.json5": `{ layers: [{ synth: { tone: "sine", noise: "pink" } }] }` }, "exactly one generator");
  expectErrors("a sample layer standing in", { "sounds/bad.json5": `{ layers: [{ sample: "x.wav", standIn: true }] }` }, "only generated layers stand in");
  expectErrors("not a sound file", { "sounds/bad.json5": `{ layers: [{ sample: "x.txt" }] }` }, "expected a sound file");
  expectErrors("far before near", { "sounds/bad.json5": `{ near: 10, far: 5, layers: [{ synth: { tone: "sine" } }] }` }, "must be beyond near");
  expectErrors("an unknown texture", { "particles/bad.json5": `{ emitters: [{ sprite: "nope", burst: 3 }] }` }, `no particle texture "nope"`);
  expectErrors("an emitter that emits nothing", { "particles/bad.json5": `{ emitters: [{ mesh: "shard" }] }` }, "emits nothing");
  expectErrors("an unknown mesh", { "particles/bad.json5": `{ emitters: [{ mesh: "teapot", burst: 1 }] }` }, `"teapot"`);
  expectErrors("a bad colour", { "particles/bad.json5": `{ emitters: [{ mesh: "chip", burst: 1, colour: "red" }] }` }, "expected a colour");
  expectErrors("a curve going back", { "particles/bad.json5": `{ emitters: [{ mesh: "chip", burst: 1, size: [[0.5, 1], [0.2, 2]] }] }` }, "lives must rise");
  expectErrors("a texture not a power of two", { "particleTextures/bad.json5": `{ kind: "dot", size: 48 }` }, "power of two");
  expectErrors("an unknown texture kind", { "particleTextures/bad.json5": `{ kind: "blob" }` }, `"blob"`);
  expectErrors("a skill naming a cue that does not exist", { "skills/bad.json5": `{ target: "self", states: { go: {} }, cues: { impact: "nope" } }` }, `no cue "nope"`);
  expectErrors("a skill naming an unknown phase", { "skills/bad.json5": `{ target: "self", states: { go: {} }, cues: { boom: "fireImpact" } }` }, "unknown phase");
  expectErrors("a look's unknown feedback field", { "entities/bad.json5": `{ look: { feedback: { smell: "wet" } } }` }, "unknown field (expected one of: weapon, armor, family)");
  expectErrors("an unknown event", { "rules/feedback.json5": `{ events: { hitt: [{ cue: "meleeHit" }] } }` }, "unknown event");
  expectErrors("an event naming no cue", { "rules/feedback.json5": `{ events: { hit: [{ cue: "nope" }] } }` }, `no cue "nope"`);
  expectErrors("a dotted id with a bad part", { "sounds/hit..x.json5": `{ layers: [{ synth: { tone: "sine" } }] }` }, "file names");
});

// --- sounds ----------------------------------------------------------------------------------------
await section("sounds", () => {
  let renders = 0;
  let longest = 0;
  const started = performance.now();
  for (const sound of feedback.sounds.values()) {
    const synths = sound.layers.filter((l) => l.synth).map((l) => l.synth);
    if (synths.length === 0) continue;
    for (let take = 0; take < sound.takes; take++) {
      const t0 = performance.now();
      const rendered = renderSynth(synths, 1000 + take, sound.loop);
      longest = Math.max(longest, performance.now() - t0);
      renders++;
      const { data } = rendered;
      let peak = 0;
      let nan = false;
      let step = 0;
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) nan = true;
        peak = Math.max(peak, Math.abs(data[i]));
        if (i > 0) step = Math.max(step, Math.abs(data[i] - data[i - 1]));
      }
      const name = `${sound.id} take ${take}`;
      check(`${name}: no NaN`, !nan);
      check(`${name}: within full scale`, peak <= 1, `peak ${peak}`);
      check(`${name}: not silent`, peak > 0.05, `peak ${peak}`);
      if (sound.loop > 0) {
        const start = Math.round(rendered.loop.start * SAMPLE_RATE);
        const end = Math.round(rendered.loop.end * SAMPLE_RATE);
        const jump = Math.abs(data[start] - data[end - 1]);
        check(`${name}: loop is ${sound.loop} s`, Math.abs((end - start) / SAMPLE_RATE - sound.loop) < 0.01);
        check(`${name}: loop joins without a click`, jump <= step * 1.5, `jump ${jump.toFixed(4)}, largest step ${step.toFixed(4)}`);
      } else {
        const expected = Math.max(...synths.map(layerLength));
        check(`${name}: as long as its layers`, Math.abs(data.length / SAMPLE_RATE - expected) < 0.01, `${data.length / SAMPLE_RATE} s, expected ${expected} s`);
        // A one-shot dies away rather than being cut off.
        let tail = 0;
        for (let i = Math.floor(data.length * 0.97); i < data.length; i++) tail = Math.max(tail, Math.abs(data[i]));
        check(`${name}: dies away`, tail < peak * 0.25 + 0.01, `tail ${tail.toFixed(3)} of peak ${peak.toFixed(3)}`);
      }
    }
  }
  console.log(`sounds: ${renders} takes rendered in ${(performance.now() - started).toFixed(0)} ms, longest ${longest.toFixed(1)} ms`);
  // The same seed gives the same take.
  const swing = feedback.sounds.get("swing").layers.map((l) => l.synth);
  const a = renderSynth(swing, 7).data;
  const b = renderSynth(swing, 7).data;
  const c = renderSynth(swing, 8).data;
  check("a take is the same from the same seed", a.length === b.length && a.every((v, i) => v === b[i]));
  check("takes from other seeds differ", a.some((v, i) => v !== c[i]));
});

// --- textures --------------------------------------------------------------------------------------
await section("textures", () => {
  const started = performance.now();
  for (const def of feedback.textures) {
    for (let variant = 0; variant < def.variants; variant++) {
      const { size, alpha, luminance } = drawParticleTexture(def, variant);
      const name = `${def.id} variant ${variant}`;
      let peak = 0;
      let covered = 0;
      let edge = 0;
      for (let i = 0; i < alpha.length; i++) {
        peak = Math.max(peak, alpha[i]);
        if (alpha[i] > 0.05) covered++;
        const x = i % size;
        const y = Math.floor(i / size);
        if (x === 0 || y === 0 || x === size - 1 || y === size - 1) edge = Math.max(edge, alpha[i]);
      }
      check(`${name}: drawn`, peak > 0.5, `peak alpha ${peak.toFixed(2)}`);
      check(`${name}: not a filled square`, covered < alpha.length * 0.85, `${((covered / alpha.length) * 100).toFixed(0)}% covered`);
      check(`${name}: clear at the edge`, edge === 0, `edge alpha ${edge}`);
      check(`${name}: luminance in range`, luminance.every((v) => v >= 0 && v <= 1));
    }
    if (def.variants > 1) {
      const a = drawParticleTexture(def, 0).alpha;
      const b = drawParticleTexture(def, 1).alpha;
      check(`${def.id}: variants differ`, a.some((v, i) => v !== b[i]));
    }
  }
  const atlas = buildParticleAtlas(feedback.textures);
  console.log(`atlas: ${atlas.size}²`);
  const variants = feedback.textures.reduce((n, t) => n + t.variants, 0);
  check("the atlas places every variant", atlas.rects.flat().length === variants);
  const rects = atlas.rects.flat();
  const overlaps = rects.some((r, i) => rects.some((s, j) => i < j && r.u0 < s.u1 && s.u0 < r.u1 && r.v0 < s.v1 && s.v0 < r.v1));
  check("no two variants overlap in the atlas", !overlaps);
  console.log(`textures: ${variants} variants drawn and packed in ${(performance.now() - started).toFixed(0)} ms`);
});

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
