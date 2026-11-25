// Cave mouths in the vale across seeds (E6, DUNGEONS.md *Entrances*): how many caves a world has (a few), and
// for each that its lair lays out whole (boss, not minimal), its foot is level and its floor not under the ground.
//   npm run probe -- scripts/probe/caveMouths.mjs [seeds=6] [config=vale]
import { loadContentFromDisk, packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { resolveDungeons } from "../../src/world/dungeons/dungeonDefs.ts";
import { wholeLayout } from "../../src/sim/dungeons.ts";
import { createWorldData } from "../../src/world/worldData.ts";
import { dimensionSeed } from "../../src/world/content/dimensions.ts";

const SEEDS = Number(process.argv[2] ?? 6), CONFIG = process.argv[3] ?? "vale";
const dungeons = resolveDungeons(packSourcesFromDisk(readConfigFromDisk(CONFIG)).sources);
const { content } = loadContentFromDisk(CONFIG);
let failures = 0, total = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  const world = createWorldData(seed, content);
  const ground = { heightAt: (x, z) => world.heightAt(x, z), builtAt: (x, z) => world.buildingAt(x, world.heightAt(x, z) + 0.5, z) !== undefined };
  const ms = world.caveMouths;
  total += ms.length;
  const notes = [];
  for (const m of ms) {
    const s = { x: m.x, y: m.y, z: m.z, facing: m.facing, mouth: true };
    let layout;
    try { ({ layout } = wholeLayout(dungeons, m.style ?? "cave", "lair", seed, s, ground)); } catch (e) { failures++; notes.push(`FAIL ${m.style ?? "cave"} at ${m.x.toFixed(0)}, ${m.z.toFixed(0)}: ${e.message}`); continue; }
    const level = Math.max(...[-1, 0, 1].map((k) => Math.abs(world.heightAt(m.x + m.uz * 11 * k, m.z - m.ux * 11 * k) - m.y)));
    const buried = world.heightAt(m.x - m.ux * 4, m.z - m.uz * 4) - m.y;
    const ok = !layout.minimal && layout.boss > 0 && level < 1.5 && buried < 1.5;
    if (!ok) { failures++; notes.push(`FAIL at ${m.x.toFixed(0)}, ${m.z.toFixed(0)}: minimal ${layout.minimal}, boss ${layout.boss}, foot off level ${level.toFixed(2)}, ground ahead ${buried.toFixed(2)} over the floor`); }
  }
  console.log(`seed ${seed}: ${ms.length} mouths (${ms.filter((m) => m.style === "mine").length} mines), ${world.features.length} other features; ${notes.join("; ") || "all lay out whole"}`);
}
console.log(`${total} caves in ${SEEDS} worlds (${(total / SEEDS).toFixed(1)} each), ${failures} failures`);
process.exitCode = failures ? 1 : 0;
// A mine's yard: a road to it, its portal and rails.
{
  let mines = 0, bad = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const world = createWorldData(seed, content);
    for (const f of world.features.filter((f) => f.kind.id === "mine")) {
      mines++;
      const layout = world.compoundLayouts.find((l) => l.featureId === f.id);
      const road = layout?.entrances.length > 0;
      const portal = layout?.props.some((p) => p.prop.id === "timberSet");
      const rails = layout?.walls.some((w) => w.prop.id === "railTrack");
      if (!road || !portal || !rails || layout.droppedRequired) { bad++; console.log(`FAIL mine seed ${seed} at ${f.x.toFixed(0)}, ${f.z.toFixed(0)}: road ${road}, portal ${portal}, rails ${rails}, dropped required ${layout?.droppedRequired}`); }
    }
  }
  console.log(`${mines} mines in ${SEEDS} worlds, ${bad} without road, portal or rails`);
  if (bad) process.exitCode = 1;
}
