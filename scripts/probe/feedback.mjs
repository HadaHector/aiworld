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
  const variants = feedback.textures.reduce((n, t) => n + t.variants, 0);
  check("the atlas places every variant", atlas.rects.flat().length === variants);
  const rects = atlas.rects.flat();
  const overlaps = rects.some((r, i) => rects.some((s, j) => i < j && r.u0 < s.u1 && s.u0 < r.u1 && r.v0 < s.v1 && s.v0 < r.v1));
  check("no two variants overlap in the atlas", !overlaps);
  console.log(`textures: ${variants} variants drawn and packed in ${(performance.now() - started).toFixed(0)} ms`);
});

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
