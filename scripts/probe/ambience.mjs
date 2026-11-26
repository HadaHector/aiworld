// Checks the ambience's levels for the places the slice needs, that the lair styles compose, and that
// the recordings (rules/ambience.json5) are wired: read from the core pack, their files there, each
// layer playing its recording once loaded - and its synthesized voice when a file is missing.
// Usage: npm run probe -- scripts/probe/ambience.mjs
import { existsSync } from "node:fs";
const { ambienceMix, dayness, PAN_MOST } = await import("../../src/audio/ambienceMix.ts");
const { createAmbience } = await import("../../src/audio/ambience.ts");
const { readAmbienceRecordings } = await import("../../src/audio/ambienceRecordings.ts");
const { resolveFeedback } = await import("../../src/feedback/rules.ts");
const { loadRulesFromDisk, packSourcesFromDisk, readConfigFromDisk } = await import("../diskContent.mjs");
const { composeSong } = await import("../../src/music/composer.ts");
const { STYLES } = await import("../../src/music/styles.ts");
const { songNotes } = await import("../../src/music/song.ts");

const base = { wind: 1, rain: 0, snow: 0, hour: 12, underground: 0, hollow: null, indoors: false, waterDistance: Infinity, life: 1 };
const places = {
  "wood, day": base,
  "wood, night": { ...base, hour: 1 },
  "wood, rain": { ...base, wind: 1.4, rain: 0.8 },
  "wood, gale": { ...base, wind: 3 },
  "by the river": { ...base, waterDistance: 5 },
  "far from the river": { ...base, waterDistance: 30 },
  "indoors, rain": { ...base, rain: 0.8, indoors: true },
  "in a cave": { ...base, underground: 1, hollow: "cave" },
  "in a crypt": { ...base, underground: 1, hollow: "crypt" },
};
const out = {};
for (const [name, state] of Object.entries(places)) out[name] = ambienceMix(state);
const f = (x) => x.toFixed(2);
console.log("place".padEnd(20), "wind rust rain patt watr fday fngt roof outd  birds  owls  hollow drips crypt");
for (const [name, m] of Object.entries(out)) console.log(name.padEnd(20), [m.wind, m.rustle, m.rain, m.patter, m.water, m.forestDay, m.forestNight, m.roofRain, m.outdoors, m.birdsPerSecond, m.owlsPerSecond, m.hollow, m.dripsPerSecond, m.crypt].map(f).join(" "));

let failed = 0;
const check = (ok, what) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
};
check(out["wood, day"].birdsPerSecond > 0.2 && out["wood, day"].wind > 0.05, "the wood by day: birds and a breath of wind");
check(out["wood, night"].birdsPerSecond === 0 && out["wood, night"].owlsPerSecond > 0, "the wood at night: owls, no songbirds");
check(out["wood, rain"].rain > 0.3 && out["wood, rain"].birdsPerSecond < 0.05, "rain: the rain is up and the birds are quiet");
check(out["wood, gale"].wind > out["wood, day"].wind * 2 && out["wood, gale"].birdsPerSecond < out["wood, day"].birdsPerSecond * 0.2, "a gale: loud wind, few birds");
check(out["by the river"].water > 0.3 && out["far from the river"].water < out["by the river"].water / 4 && out["wood, day"].water === 0, "water fades with distance");
check(out["indoors, rain"].outdoorCutHz < 1000 && out["indoors, rain"].birdsPerSecond === 0, "indoors: dulled, no birds");
check(out["in a cave"].outdoors === 0 && out["in a cave"].wind === 0 && out["in a cave"].dripsPerSecond === 0 && out["in a cave"].room === 0 && out["in a cave"].crypt === 0 && out["in a cave"].echo === 1, "a cave (or a mine): no bed, no drips, the effects' reverb");
check(out["in a crypt"].crypt > 0.9 && out["in a crypt"].rain === 0 && out["in a crypt"].dripsPerSecond > 0.1 && out["in a crypt"].echo === 1, "a crypt: the drone, drips, the reverb, no rain");
check(Math.abs(dayness(12) - 1) < 1e-9 && dayness(2) === 0 && dayness(6) > 0 && dayness(6) < 1, "day, night, dawn");
check(out["wood, day"].forestDay > 0.9 && out["wood, day"].forestNight < 0.01 && out["wood, night"].forestNight > 0.9 && out["wood, night"].forestDay < 0.01, "the wood's bed: the day's by day, the night's by night");
check(out["wood, rain"].forestDay < out["wood, day"].forestDay * 0.5 && out["in a cave"].forestDay === 0 && out["in a cave"].forestNight === 0, "the bed hushed by rain, gone underground");
check(out["indoors, rain"].roofRain > 0.3 && out["wood, rain"].roofRain === 0, "rain on the roof: indoors only");
check(out["in a crypt"].room === 1 && out["wood, day"].room === 0 && out["wood, day"].echo === 0, "the room tone in a crypt; no reverb in the open");
{
  const shore = ambienceMix({ ...base, seaDistance: 8 });
  const far = ambienceMix({ ...base, seaDistance: 70 });
  const both = ambienceMix({ ...base, seaDistance: 8, waterDistance: 20 });
  check(shore.surf > 0.9 && far.surf > 0.05 && far.surf < shore.surf / 3 && out["wood, day"].surf === 0, "the sea's surf: full on the shore, faint from 70 m");
  check(shore.water > 0.4 && shore.river === 0 && both.river > 0 && both.river < both.water, "the water layer: the sea's too without surf, a river's alone with it");
}
for (const [name, m] of Object.entries(out)) for (const [k, v] of Object.entries(m)) check(Number.isFinite(v) && (k.endsWith("Pan") ? Math.abs(v) <= 1 : v >= 0), `${name}: ${k} sane`) || 0;
{
  // The water from its side: x is east, z north; the camera's forward is the facing.
  const east = { x: 1, z: 0, focus: 1 };
  const north = { x: 0, z: 1 };
  const facingEast = ambienceMix({ ...base, seaDistance: 20, seaBearing: east, facing: { x: 1, z: 0 } });
  const facingNorth = ambienceMix({ ...base, seaDistance: 20, seaBearing: east, facing: north });
  const facingSouth = ambienceMix({ ...base, seaDistance: 20, seaBearing: east, facing: { x: 0, z: -1 } });
  const facingWest = ambienceMix({ ...base, seaDistance: 20, seaBearing: east, facing: { x: -1, z: 0 } });
  check(Math.abs(facingNorth.surfPan - PAN_MOST) < 1e-9 && Math.abs(facingSouth.surfPan + PAN_MOST) < 1e-9, `the sea to the east: right facing north (${f(facingNorth.surfPan)}), left facing south (${f(facingSouth.surfPan)})`);
  check(Math.abs(facingEast.surfPan) < 1e-9 && facingEast.surfBehind === 0 && Math.abs(facingWest.surfPan) < 1e-9 && facingWest.surfBehind > 0.99, "ahead: centred and clear; behind: centred and dulled");
  const spit = ambienceMix({ ...base, seaDistance: 10, seaBearing: { x: 0, z: 0.01, focus: 0.02 }, facing: north });
  check(Math.abs(spit.surfPan) < 0.05 && spit.surfBehind < 0.05, "the sea all round (a spit): centred");
  const inside = ambienceMix({ ...base, indoors: true, waterDistance: 5, waterBearing: east, facing: north });
  check(inside.riverPan > 0 && inside.riverPan < PAN_MOST * 0.6, "through walls, less sure of the side");
  const both = ambienceMix({ ...base, waterDistance: 5, waterBearing: { x: -1, z: 0, focus: 1 }, seaDistance: 30, seaBearing: east, facing: north });
  check(both.riverPan < 0 && both.waterPan === both.riverPan && both.surfPan > 0, "a river to the west, the sea to the east: each from its side, the water layer the nearer's");
  const none = ambienceMix({ ...base, waterDistance: 5 });
  check(none.riverPan === 0 && none.waterBehind === 0, "with no bearing: centred, as before");
}

// --- the recordings ---
const config = readConfigFromDisk(undefined);
const { sources } = packSourcesFromDisk(config);
const feedback = resolveFeedback(sources, loadRulesFromDisk(undefined));
const recordings = feedback.ambience;
const wanted = { wind: "wind.ogg", rain: "rain.ogg", water: "creek.ogg", surf: "seashore.ogg", forestDay: "forest.ogg", forestNight: "forest_night.ogg" };
for (const [layer, file] of Object.entries(wanted)) {
  const r = recordings.loops[layer];
  check(!!r && r.files.some((p) => p.endsWith(`/${file}`)) && r.gain > 0, `the ${layer} layer plays ${file}`);
  for (const p of r?.files ?? []) check(existsSync(`public/packs/${p}`), `  ${p} is in public/packs`);
}
check(recordings.loops.rain?.covers.includes("patter"), "rain's recording stands in for the synthesized drops");
check(recordings.loops.forestDay?.quiets.birds !== undefined && recordings.loops.forestDay.quiets.birds < 1, "the day's bed turns the synthesized birds down");
check(!recordings.loops.rustle, "the leaves stay synthesized");
{
  const issues = [];
  readAmbienceRecordings({ loops: { thunderstorm: { files: ["a.ogg"] }, wind: { files: ["../x.ogg"], volume: 1 } }, oneShots: { drip: { files: [] } } }, "rules/ambience.json5", "core", issues);
  check(issues.length >= 4, `bad data refused (${issues.length} issues: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")})`);
}

// A stand-in audio context: enough of Web Audio for the graph to be made, and fetch made to fail for
// one file, so the layers' status can be checked without sound.
function fakeContext() {
  const param = (value) => ({ value, setTargetAtTime(v) { this.value = v; }, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; }, exponentialRampToValueAtTime(v) { this.value = v; } });
  const node = (extra = {}) => ({ connect: () => undefined, disconnect: () => undefined, start: () => undefined, stop: () => undefined, ...extra });
  const buffer = (channels, length, sampleRate) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (c) => data[c] };
  };
  const ctx = {
    sampleRate: 4000,
    currentTime: 0,
    createGain: () => node({ gain: param(1) }),
    createBiquadFilter: () => node({ type: "", frequency: param(350), Q: param(1) }),
    createOscillator: () => node({ type: "", frequency: param(440) }),
    createStereoPanner: () => node({ pan: param(0) }),
    createConvolver: () => node({ buffer: null }),
    createBufferSource: () => node({ buffer: null, loop: false, playbackRate: param(1) }),
    createBuffer: buffer,
    decodeAudioData: async () => buffer(2, 4000 * 8, 4000),
  };
  return ctx;
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => (String(url).includes("creek") ? { ok: false, status: 404 } : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
const warn = console.warn;
console.warn = () => undefined;
try {
  const ctx = fakeContext();
  const ambience = createAmbience(ctx, ctx.createGain(), recordings, (p) => `/packs/${p}`);
  const before = Object.fromEntries(ambience.layers().map((l) => [l.id, l.playing]));
  check(before.wind === "synth" && before.forestDay === "silent", "while the recordings load: the synthesized voices, the beds silent");
  await ambience.ready();
  ambience.update(base);
  const after = Object.fromEntries(ambience.layers().map((l) => [l.id, l]));
  check(after.surf.playing === "recorded" && after.wind.playing === "recorded" && after.rain.playing === "recorded" && after.forestDay.playing === "recorded" && after.forestNight.playing === "recorded", "loaded: wind, rain and the wood's beds play their recordings");
  check(after.water.load === "missing" && after.water.playing === "synth", "a file that will not load: its layer keeps its synthesized voice");
  check(after.rustle.playing === "synth" && after.room.playing === "synth" && after.crypt.playing === "synth", "layers with no file: their synthesized voices");
  ambience.setRecorded("wind", false);
  check(ambience.layers().find((l) => l.id === "wind").playing === "synth", "the dev page's switch: back to the synthesized wind");
  ambience.dispose();
} catch (error) {
  check(false, `the ambience with recordings threw: ${error?.stack ?? error}`);
} finally {
  globalThis.fetch = realFetch;
  console.warn = warn;
}

for (const id of ["swamp", "crypt", "lair"]) {
  const style = STYLES.find((s) => s.id === id);
  check(!!style, `style ${id} exists`);
  for (const seed of [1, 2, 3]) {
    const song = composeSong(style, seed, 1);
    check(songNotes(song).length > 100, `${id} seed ${seed} composes ${songNotes(song).length} notes at ${song.bpm ?? "?"}bpm`);
  }
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
