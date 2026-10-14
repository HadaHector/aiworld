// Composes a song and prints its patterns as tracker text, without audio.
// Usage: npm run probe -- scripts/probe/music.mjs [placeSeed] [visitSeed] [patterns]
const { composeSong } = await import("../../src/music/composer.ts");
const { FOREST } = await import("../../src/music/styles.ts");
const { patternText } = await import("../../src/music/format.ts");
const { songNotes, songRows, rowSeconds } = await import("../../src/music/song.ts");

const placeSeed = Number(process.argv[2] ?? 1);
const visitSeed = Number(process.argv[3] ?? 1);
const show = Number(process.argv[4] ?? 2);
const song = composeSong(FOREST, placeSeed, visitSeed);
const shorts = { flute: "fl", guitar: "gt", strings: "st", bass: "bs", frameDrum: "fd", tambourine: "tb", lowDrum: "ld" };
console.log(song.summary);
console.log(`${song.patterns.length} patterns, ${songRows(song)} rows, ${(songRows(song) * rowSeconds(song)).toFixed(0)} s, ${songNotes(song).length} notes`);
for (const pattern of song.patterns.slice(0, show)) console.log("\n" + patternText(song, pattern, shorts));
