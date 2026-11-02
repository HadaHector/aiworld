// The map's tiles (MAP.md): built headless for a small world over its starting village and checked -
// their size, the same bytes twice, distinct cache keys, water where the sampler has water - and
// timed. Writes the tiles as one PNG to look at when given a folder.
//   npm run probe -- scripts/probe/mapTiles.mjs [outDir] [config]
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { loadContentFromDisk } from "../diskContent.mjs";
import { createWorldData } from "../../src/world/worldData.ts";
import { chooseStarts } from "../../src/world/settlements/starts.ts";
import { createMaterialBlender } from "../../src/world/materials/materialBlend.ts";
import { createBushScatter, createRockScatter, createTreeCover, createTreeScatter, samplerGround } from "../../src/world/foliage/treeScatter.ts";
import { SEA_LEVEL } from "../../src/world/cells/areaField.ts";
import { buildMapTile, mapTileAt, mapTileKey, MAP_TILE_PIXELS, MAP_TILE_METRES, MAP_METRES_PER_PIXEL } from "../../src/map/tiles.ts";

const [outDir = "", config = "tiny"] = process.argv.slice(2);
const SEED = 1338;

let failures = 0;
let checks = 0;
function check(what, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
}
const log = console.log;
const quiet = (run) => {
  console.log = (...args) => (String(args[0]).startsWith("[") ? undefined : log(...args));
  try {
    return run();
  } finally {
    console.log = log;
  }
};

/** Stand-in average colours (the game's come from the baked textures, which a probe does not bake):
 *  a grass material's first grass colour, else a grey from its id - enough to tell materials apart. */
function probeColors(defs) {
  return defs.map((def) => {
    const grass = def.grass?.[0]?.color;
    if (grass) return grass;
    let h = 0;
    for (const ch of def.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const v = 0.35 + (h % 100) / 250;
    return [v, v * 0.95, v * 0.85];
  });
}

const content = quiet(() => loadContentFromDisk(config).content);
const world = quiet(() => createWorldData(SEED, content));
const [start] = chooseStarts(world, content.dimension);
const blender = createMaterialBlender(SEED, content, world.areaBiomes);
const ground = {
  sampleTerrain: world.sampleTerrain,
  buildMaterialBlend: blender.buildMaterialBlend,
  groundColors: probeColors(blender.materialDefs),
  treeCover: createTreeCover(SEED, content),
};
const things = {
  groups: world.buildingGroups,
  buildingColors: Object.fromEntries(content.buildingMaterials.map((m) => [m.id, probeColors([m])[0]])),
  scatterTrees: createTreeScatter(SEED, content),
  scatterBushes: createBushScatter(SEED, content, world.sampleTerrain),
  scatterRocks: createRockScatter(SEED, content, world.sampleTerrain),
  treeGround: samplerGround(world.sampleTerrain),
  treeKinds: content.treeKinds,
  treeColors: {},
  seed: SEED,
  cut: 8,
  treeCut: process.env.TREECUT ? Number(process.env.TREECUT) : undefined,
  near: process.env.FAR !== "1",
};

// A 3 x 3 block of tiles round the start: the village and its edges.
// AT=x,z centres the tiles elsewhere instead (a wood, a coast) to look at.
const at = process.env.AT?.split(",").map(Number);
const centre = at ? mapTileAt(at[0], at[1]) : mapTileAt(start.x, start.z);
const tiles = [];
const started = performance.now();
for (let dz = -1; dz <= 1; dz++) {
  for (let dx = -1; dx <= 1; dx++) {
    const tx = centre.tx + dx;
    const tz = centre.tz + dz;
    const t = performance.now();
    tiles.push({ tx, tz, pixels: buildMapTile(ground, tx, tz, things), ms: performance.now() - t });
  }
}
const totalMs = performance.now() - started;
log(`${config} seed ${SEED}: start "${start.id}" at ${Math.round(start.x)}, ${Math.round(start.z)}; ${tiles.length} tiles in ${Math.round(totalMs)} ms (${Math.round(totalMs / tiles.length)} ms each, slowest ${Math.round(Math.max(...tiles.map((t) => t.ms)))}, ${MAP_TILE_METRES} m at ${MAP_METRES_PER_PIXEL} m/px, ${things.near ? "near" : "far"} models)`);
{
  const t = performance.now();
  const bare = buildMapTile(ground, centre.tx, centre.tz);
  const groundMs = performance.now() - t;
  let changed = 0;
  for (let i = 0; i < bare.length; i += 4) if (bare[i] !== tiles[4].pixels[i] || bare[i + 1] !== tiles[4].pixels[i + 1]) changed++;
  log(`the village tile: ground alone ${Math.round(groundMs)} ms; things changed ${((changed / (bare.length / 4)) * 100).toFixed(1)}% of its pixels`);
  if (!at) check("buildings and trees drawn over the village", changed > bare.length / 4 / 20, `${changed} pixels`);
}

for (const tile of tiles) check(`tile ${tile.tx},${tile.tz} size`, tile.pixels.length === MAP_TILE_PIXELS * MAP_TILE_PIXELS * 4, String(tile.pixels.length));
const again = buildMapTile(ground, centre.tx, centre.tz, things);
check("the same bytes twice", Buffer.from(again).equals(Buffer.from(tiles[4].pixels)));
const keys = new Set(tiles.map((t) => mapTileKey("w", "mainland", t.tx, t.tz)));
check("distinct keys", keys.size === tiles.length);
check("keys differ by dimension", mapTileKey("w", "a", 0, 0) !== mapTileKey("w", "b", 0, 0));
check("negative tiles", mapTileAt(-0.01, -64.01).tx === -1 && mapTileAt(-0.01, -64.01).tz === -2);
check("every pixel opaque", tiles.every((t) => t.pixels.every((v, i) => i % 4 !== 3 || v === 255)));

// Water: find a sea point somewhere and check its tile's pixel is water-blue (blue over red).
let sea = null;
for (let r = 200; r < 40000 && !sea; r *= 1.3) {
  for (let a = 0; a < 16 && !sea; a++) {
    const x = start.x + Math.cos(a) * r;
    const z = start.z + Math.sin(a) * r;
    const s = world.sampleTerrain(x, z);
    if (!s.isLand || s.height < SEA_LEVEL - 3) sea = { x, z };
  }
}
check("found water to test", !!sea);
if (sea) {
  const { tx, tz } = mapTileAt(sea.x, sea.z);
  const px = buildMapTile(ground, tx, tz);
  const col = Math.floor((sea.x - tx * MAP_TILE_METRES) / MAP_METRES_PER_PIXEL);
  const row = Math.floor((sea.z - tz * MAP_TILE_METRES) / MAP_METRES_PER_PIXEL);
  const o = (row * MAP_TILE_PIXELS + col) * 4;
  check("water drawn as water", px[o + 2] > px[o] + 20, `${px[o]},${px[o + 1]},${px[o + 2]}`);
}

if (outDir) {
  const n = MAP_TILE_PIXELS * 3;
  const rgba = new Uint8Array(n * n * 4);
  tiles.forEach((tile, k) => {
    const ox = (k % 3) * MAP_TILE_PIXELS;
    const oy = Math.floor(k / 3) * MAP_TILE_PIXELS;
    for (let y = 0; y < MAP_TILE_PIXELS; y++) rgba.set(tile.pixels.subarray(y * MAP_TILE_PIXELS * 4, (y + 1) * MAP_TILE_PIXELS * 4), ((oy + y) * n + ox) * 4);
  });
  const path = `${outDir}/mapTiles-${config}${process.env.TREECUT ? `-trees${process.env.TREECUT}` : ""}.png`;
  writePng(path, rgba, n);
  log(`wrote ${path}`);
}

log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);

function writePng(path, rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    let crc = ~0;
    for (const b of td) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const c = Buffer.alloc(4);
    c.writeUInt32BE(~crc >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
