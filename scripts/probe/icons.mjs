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
// Both icon packs are optional: the names are only checked when both are there (the generated one is
// built from picked icons, see ICONS.md).
const withPack = ["icons-craftpix", "icons-generated"].every((id) => sources.some((s) => s.id === id));
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
const asked = [...game.skills.map((s) => ["skill " + s.id, s.icon]), ...items.types.map((t) => ["item " + t.id, t.icon]), ...Object.entries(game.quests.itemLooks).flatMap(([type, look]) => look.icons.map((icon) => ["quest item looks of " + type, icon]))].filter(([, icon]) => icon);
check("core assigns icons", asked.length > 30, `only ${asked.length}`);
loadIconSets(withPack ? sources : [], "/");
// Icons still waiting to be generated and picked (ICONS.md; the review is the owner's): torch, bandage,
// iron ingot and spell scroll since 4da050b, and the hardened sword's three forms since the material
// was added (c4bf2d5; not yet in assets_work/comfyUI/icons.json either). A name here that turns up in
// the pack must be struck off (so the list never goes stale); a name missing that is not here fails.
const WAITING = new Set(["item-torch", "item-bandage", "item-iron-ingot", "item-spell-scroll", "item-sword-hardened-short", "item-sword-hardened-long", "item-sword-hardened-great"]);
if (withPack) {
  for (const [who, icon] of asked) check(`${who}: icon ${icon} is in the pack`, hasIcon(icon) || WAITING.has(icon));
  for (const icon of WAITING) check(`${icon} is still waiting (else strike it from WAITING)`, !hasIcon(icon));
}
loadIconSets(coreOnly, "/");
for (const [who, icon] of asked) check(`${who}: with the packs gone, ${icon} is not found`, !hasIcon(icon));

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

console.log(failures === 0 ? `icons: ok (${asked.length} icons asked for, packs ${withPack ? "present" : "incomplete, names not checked"})` : `${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
