// Checks the ambience's levels for the places the slice needs, and that the lair styles compose.
// Usage: npm run probe -- scripts/probe/ambience.mjs
const { ambienceMix, dayness } = await import("../../src/audio/ambienceMix.ts");
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
console.log("place".padEnd(20), "wind rust rain patt watr outd  birds  owls  hollow drips crypt");
for (const [name, m] of Object.entries(out)) console.log(name.padEnd(20), [m.wind, m.rustle, m.rain, m.patter, m.water, m.outdoors, m.birdsPerSecond, m.owlsPerSecond, m.hollow, m.dripsPerSecond, m.crypt].map(f).join(" "));

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
check(out["in a cave"].outdoors === 0 && out["in a cave"].wind === 0 && out["in a cave"].dripsPerSecond > 0.2 && out["in a cave"].crypt === 0, "a cave: outdoors gone, drips, no drone");
check(out["in a crypt"].crypt > 0.9 && out["in a crypt"].rain === 0, "a crypt: the drone, no rain");
check(Math.abs(dayness(12) - 1) < 1e-9 && dayness(2) === 0 && dayness(6) > 0 && dayness(6) < 1, "day, night, dawn");
for (const [name, m] of Object.entries(out)) for (const [k, v] of Object.entries(m)) check(Number.isFinite(v) && v >= 0, `${name}: ${k} sane`) || 0;

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
