// The icons test (see public/packs/icons-craftpix/README.md): the icon pack loads beside core
// without upsetting the content readers, every icon name core uses is in it, and the game's rules
// and screens' data read the same with the pack removed.
//   npm run probe -- scripts/probe/icons.mjs
import { loadRulesFromDisk, packSourcesFromDisk, readConfigFromDisk, loadItemRulesFromDisk } from "../diskContent.mjs";
import { resolveContent } from "../../src/world/content/resolveContent.ts";
import { hasIcon, itemIcon, loadIconSets, skillIcon } from "../../src/ui/icons.ts";

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
};

const config = readConfigFromDisk("tiny");
const { sources } = packSourcesFromDisk(config);
const withPack = sources.some((s) => s.id === "icons-craftpix");
const coreOnly = sources.filter((s) => s.id === "core");

// The world's own resolver ignores icons/ in a pack, with the pack or without it.
for (const [what, set] of [["all packs", sources], ["core alone", coreOnly]]) {
  try {
    resolveContent(set, config, null);
  } catch (error) {
    check(`content resolves from ${what}`, false, String(error?.issues?.[0]?.message ?? error));
  }
}

// The rules carry the `icon` of each skill and item type; every name core asks for is in the pack.
const game = loadRulesFromDisk("tiny");
const items = loadItemRulesFromDisk("tiny", game, 1234);
const asked = [...game.skills.map((s) => ["skill " + s.id, s.icon]), ...items.types.map((t) => ["item " + t.id, t.icon])].filter(([, icon]) => icon);
check("core assigns icons", asked.length > 30, `only ${asked.length}`);
loadIconSets(withPack ? sources : [], "/");
if (withPack) for (const [who, icon] of asked) check(`${who}: icon ${icon} is in the pack`, hasIcon(icon));
loadIconSets(coreOnly, "/");
for (const [who, icon] of asked) check(`${who}: with the pack gone, ${icon} is not found`, !hasIcon(icon));

// Placeholders: every skill and item type gets a glyph and a colour with no art at all.
for (const s of game.skills) {
  const spec = skillIcon(s);
  check(`skill ${s.id} has a placeholder`, !!spec.glyph && !!spec.color);
}
for (const t of items.types) {
  const spec = itemIcon(t, "#fff");
  check(`item ${t.id} has a placeholder`, !!spec.glyph);
}
check("a missing type has a placeholder", itemIcon(undefined, "#f0f").glyph === "misc");

console.log(failures === 0 ? `icons: ok (${asked.length} icons asked for, pack ${withPack ? "present" : "absent"})` : `${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
