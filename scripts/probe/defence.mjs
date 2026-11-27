// The defence model (SLICE.md 3a, B8; ABILITIES.md, *Defence*): the parts in rules/combat.json5 read,
// each part's effective-health multiplier at levels 1, 5 and 10, the curve held whichever part is
// turned off (the derive shares the budget out among the parts that are on), and the parts rolled in
// real blows: dodge, parry, block, armour, resistance, a ward, crowd control avoided.
//   npm run probe -- scripts/probe/defence.mjs
import { resolveGameRules } from "../../src/sim/rules/gameRules.ts";
import { readBalanceRules } from "../../src/sim/rules/balanceRules.ts";
import { DEFENCE_PARTS, defenceFor, defenceMultiplier, defenceValues } from "../../src/sim/rules/defenceRules.ts";
import { createEntity } from "../../src/sim/entity.ts";
import { createSkillSystem } from "../../src/sim/skills/system.ts";
import { COMBAT_EVENT_KINDS, EVENT_FLAG } from "../../src/sim/skills/events.ts";
import { setBase, statValue } from "../../src/sim/stats.ts";
import { describeEvent } from "../../src/sim/skills/combatLog.ts";
import { packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";

let failures = 0;
let checks = 0;
const check = (what, ok, detail = "") => {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const { sources } = packSourcesFromDisk(readConfigFromDisk());
const PROBE = {
  dMelee: `{ tags: ["melee"], states: { s: { enter: [{ do: "damage", amount: 100 }] } } }`,
  dShot: `{ states: { s: { enter: [{ do: "damage", amount: 100 }] } } }`,
  dBolt: `{ type: "spell", tags: ["school.fire"], states: { s: { enter: [{ do: "damage", amount: 100 }] } } }`,
  dStun: `{ states: { s: { length: 2, hold: [{ do: "flag", flags: ["stunned"] }] } } }`,
};
const rules = resolveGameRules([...sources, { id: "zzdefence", files: [{ path: "pack.json5", text: `{ name: "Defence probe", priority: 10 }` }, ...Object.entries(PROBE).map(([id, text]) => ({ path: `skills/${id}.json5`, text }))] }]);
const balance = readBalanceRules(sources);
const d = rules.combat.defence;

// --- the rules ---
check("the core pack's defence: armour, dodge, parry, block, resist and control on; absorb off", d.on.armor && d.on.dodge && d.on.parry && d.on.block && d.on.resist && d.on.control && !d.on.absorb, JSON.stringify(d.on));
check("weapons meet the physical parts, spells resistance, over-time blows none", rules.combat.rolls.find((r) => r.id === "default").defence === "physical" && rules.combat.rolls.find((r) => r.id === "spell").defence === "spell" && rules.combat.rolls.find((r) => r.id === "noCrit").defence === "none");
check("armour's constants are the balance curves' (rules/balance.json5 armourFormula)", d.armor.base === balance.armourFormula.base && d.armor.perLevel === balance.armourFormula.perLevel);
for (const id of ["dodge", "parry", "blockChance", "blockValue", "ward", "controlAvoid", "fireResist", "holyResist"]) check(`the stat ${id} exists`, rules.statIndex.has(id));

// --- the multipliers: each part's at levels 1, 5 and 10, for the player's curve and a normal creature ---
const off = (part) => ({ ...d, on: { ...d.on, [part]: false } });
const only = (part) => ({ ...d, on: Object.fromEntries(DEFENCE_PARTS.map((p) => [p, p === part])) });
const fmt = (x) => x.toFixed(3);
const table = (label, targetAt, healthAt) => {
  console.log(`\n${label}: effective-health multiplier by part (physical in all / spells in all)`);
  console.log("level  target  " + DEFENCE_PARTS.map((p) => p.padEnd(7)).join(" ") + " physical spell");
  for (const level of [1, 5, 10]) {
    const T = targetAt(level);
    const health = healthAt(level);
    const stats = defenceFor(d, level, T, { health });
    const r = defenceMultiplier(d, (id) => stats[id] ?? 0, level, { health });
    console.log(`${String(level).padEnd(6)} ${fmt(T)}   ` + DEFENCE_PARTS.map((p) => fmt(r.parts[p]).padEnd(7)).join(" ") + ` ${fmt(r.physical)}    ${fmt(r.spell)}`);
    console.log(`       stats: ${Object.entries(stats).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")}`);
  }
};
const playerT = (level) => 1 / (1 - balance.curve("playerMitigation", level));
const normalT = () => 1 / (1 - balance.roles.get("normal").mitigation);
table("the player's curve (playerMitigation)", playerT, (l) => balance.curve("playerHealth", l));
table("a normal creature (role mitigation 0.2)", normalT, (l) => balance.creatureBaseline({ role: "normal", scale: { health: 1, damage: 1, armour: 1, money: 1, xp: 1 } }, l).health);

// --- the curve held, whichever part is off ---
for (const [label, rulesOf] of [["all the parts on", () => d], ...DEFENCE_PARTS.map((p) => [`${p} off`, () => off(p)]), ["armour alone", () => only("armor")], ["dodge alone", () => only("dodge")]]) {
  const r = rulesOf();
  let worst = 0;
  let spellWorst = 0;
  for (let level = 1; level <= 10; level++) {
    for (const T of [playerT(level), normalT(), 1 / (1 - 0.35)]) {
      const health = balance.curve("playerHealth", level);
      const stats = defenceFor(r, level, T, { health });
      const m = defenceMultiplier(r, (id) => stats[id] ?? 0, level, { health });
      // (A part alone reaches only as far as its cap: dodge's 30% is 1.43.)
      const reach = label === "dodge alone" ? Math.min(T, 1 / (1 - r.cap.dodge)) : T;
      worst = Math.max(worst, Math.abs(m.physical / reach - 1));
      if (r.on.resist) spellWorst = Math.max(spellWorst, Math.abs(m.spell / T ** r.spellBudget - 1));
    }
  }
  check(`${label}: the physical product is on the curve at levels 1-10${label === "dodge alone" ? " (to its cap)" : ""}`, worst < 1e-6, `off by ${(worst * 100).toFixed(4)}%`);
  if (r.on.resist) check(`${label}: spells meet the curve to the spell budget's power`, spellWorst < 1e-6, `off by ${(spellWorst * 100).toFixed(4)}%`);
}
{
  // With resistance off, spells meet only what absorb and control give: as before the model, about unmitigated.
  const r = off("resist");
  const stats = defenceFor(r, 5, playerT(5), { health: 300 });
  const m = defenceMultiplier(r, (id) => stats[id] ?? 0, 5, { health: 300 });
  check("resistance off: spells nearly unmitigated (control's share only)", m.spell >= 1 && m.spell < 1.02, fmt(m.spell));
}
{
  // Armour only: the model is the old formula, the same armour for the same share.
  const r = only("armor");
  const stats = defenceFor(r, 5, 1 / 0.8);
  check("armour alone: the old armour for 20% at level 5", near(stats.armor, (0.2 * (400 + 85 * 5)) / 0.8, 1e-9), String(stats.armor));
}
{
  // A shield is gear: its block is on top of the curve (the tank's side of the axis).
  const health = 175;
  const r = defenceMultiplier(d, (id) => ({ blockChance: 10, blockValue: 6 })[id] ?? 0, 1, { health });
  check("a wooden shield (10%, 6) at level 1: a few percent more effective health", r.parts.block > 1.02 && r.parts.block < 1.06, fmt(r.parts.block));
}

// --- the parts in real blows ---
function makeWorld(seed = 11) {
  const entities = new Map();
  let time = 0;
  let nextId = 1;
  const world = { seed, time: () => time, tick: () => 0, entity: (id) => entities.get(id), entitiesIn: () => entities.values(), lineOfSight: () => true, spawn: () => null, despawn: (e) => entities.delete(e.id), push: () => undefined };
  const system = createSkillSystem(rules, world);
  const make = (template, x, z) => {
    const e = createEntity(rules, rules.templates.get(template), nextId++, { dimension: "d", x, y: 0, z, facing: 0 });
    entities.set(e.id, e);
    system.adopt(e);
    return e;
  };
  return { system, make, drain: () => system.drainEvents().map((e) => e.event), advance: (s) => (time += s) };
}
const S = (id) => rules.skillIndex.get(id);
const setStat = (e, id, v) => setBase(e.stats, rules.statIndex.get(id), v);
const kindOf = (e) => COMBAT_EVENT_KINDS[e.kind];
{
  const w = makeWorld();
  const a = w.make("player", 0, 0);
  const dummy = w.make("trainingDummy", 0, 2);
  const want = { dodge: 15, parry: 10, blockChance: 30, blockValue: 20, armor: 500, fireResist: 300, controlAvoid: 40 };
  for (const [id, v] of Object.entries(want)) setStat(dummy, id, v);
  for (const id of ["agility", "defenceSkill"]) if (rules.statIndex.has(id)) setStat(dummy, id, 0);
  const v = defenceValues(d, (id) => (rules.statIndex.has(id) ? statValue(dummy.stats, rules.statIndex.get(id)) : 0), statValue(a.stats, rules.statIndex.get("level")));
  const N = 6000;
  const fire = (skill) => {
    for (let i = 0; i < N; i++) {
      w.system.apply(S(skill), a, dummy);
      dummy.resources.current[rules.health] = dummy.resources.max[rules.health];
    }
    return w.drain();
  };
  const melee = fire("dMelee");
  const count = (list, kind) => list.filter((e) => kindOf(e) === kind).length;
  const swings = melee.filter((e) => ["hit", "dodge", "parry"].includes(kindOf(e))).length;
  check(`melee: dodged about ${(v.dodge * 100).toFixed(0)}% of the blows that would land`, near(count(melee, "dodge") / swings, v.dodge, 0.12), `${count(melee, "dodge")} of ${swings}`);
  check(`melee: parried about ${(v.parry * 100).toFixed(0)}%`, near(count(melee, "parry") / swings, v.parry, 0.12), `${count(melee, "parry")} of ${swings}`);
  const hits = melee.filter((e) => kindOf(e) === "hit");
  const blocked = hits.filter((e) => e.flags & EVENT_FLAG.blocked);
  check(`melee: blocked about ${(v.block * 100).toFixed(0)}% of the hits, ${v.blockValue} each`, near(blocked.length / hits.length, v.block, 0.1) && blocked.every((e) => near(e.blocked, 20, 1e-9)), `${blocked.length} of ${hits.length}`);
  const clean = hits.find((e) => !(e.flags & (EVENT_FLAG.blocked | EVENT_FLAG.crit)));
  check(`melee: armour stops ${(v.armor * 100).toFixed(1)}% of a clean hit`, !!clean && near(clean.amount, 100 * (1 - v.armor), 1e-6), String(clean?.amount));
  const shot = fire("dShot");
  check("a blow that is not melee is dodged but never parried", count(shot, "parry") === 0 && count(shot, "dodge") > 0);
  const bolts = fire("dBolt").filter((e) => kindOf(e) === "hit");
  const plain = bolts.find((e) => !(e.flags & EVENT_FLAG.crit));
  check(`a fire spell: never dodged, ${(v.resist("fire") * 100).toFixed(1)}% resisted`, !!plain && (plain.flags & EVENT_FLAG.resisted) !== 0 && near(plain.resisted, 100 * v.resist("fire"), 1e-6) && near(plain.amount, 100 * (1 - v.resist("fire")), 1e-6), JSON.stringify(plain));
  const nameOf = (id) => (id === a.id ? "Probe" : "Dummy");
  const line = (kind) => describeEvent(rules, melee.find((e) => kindOf(e) === kind) ?? shot[0], nameOf);
  console.log(`\nthe combat log: "${line("dodge")}", "${line("parry")}", "${describeEvent(rules, blocked[0], nameOf)}", "${describeEvent(rules, plain, nameOf)}"`);
  check("the combat log says dodges, parries, blocks and resists", /dodges/.test(line("dodge")) && /parries/.test(line("parry")) && /blocked/.test(describeEvent(rules, blocked[0], nameOf)) && /resisted/.test(describeEvent(rules, plain, nameOf)));

  // Stunned: no dodge, no parry, no block.
  setStat(dummy, "controlAvoid", 0);
  w.system.apply(S("dStun"), a, dummy);
  w.drain();
  const stunnedHits = fire("dMelee");
  check("stunned: nothing dodged, parried or blocked", count(stunnedHits, "dodge") + count(stunnedHits, "parry") === 0 && stunnedHits.filter((e) => e.flags & EVENT_FLAG.blocked).length === 0, `${count(stunnedHits, "dodge")} dodged`);
}
{
  // Crowd control avoided: a hostile stun does not take about controlAvoid% of the time.
  const w = makeWorld(5);
  const a = w.make("player", 0, 0);
  const dummy = w.make("trainingDummy", 0, 2);
  setStat(dummy, "controlAvoid", 40);
  let avoided = 0;
  const n = 1500;
  for (let i = 0; i < n; i++) {
    const m = w.system.apply(S("dStun"), a, dummy);
    const events = w.drain();
    if (events.some((e) => kindOf(e) === "resisted")) avoided++;
    if (m && !m.ended) w.system.remove?.(m);
    for (const magic of [...dummy.combat.magics]) if (magic.skill.index === S("dStun")) w.system.end?.(magic) ?? magic;
    dummy.combat.flags.fill?.(0);
  }
  check("a stun shaken off about 40% of the time", near(avoided / n, 0.4, 0.15), `${avoided} of ${n}`);
}
{
  // A ward (absorb, off in core): turned on, it takes damage first and is whole again out of combat.
  const w = makeWorld(3);
  const was = d.on.absorb;
  d.on.absorb = true;
  try {
    const a = w.make("player", 0, 0);
    const dummy = w.make("trainingDummy", 0, 2);
    for (const id of ["dodge", "parry", "blockChance", "armor", "agility", "defenceSkill"]) if (rules.statIndex.has(id)) setStat(dummy, id, 0);
    setStat(dummy, "ward", 150);
    const absorbedOf = () => w.drain().filter((e) => kindOf(e) === "hit").reduce((s, e) => s + e.absorbed, 0);
    for (let i = 0; i < 4; i++) w.system.apply(S("dShot"), a, dummy);
    const first = absorbedOf();
    check("a ward of 150 takes 150 of the first blows", near(first, 150, 1e-9), String(first));
    w.advance(rules.combat.combatTimeout + 1);
    for (let i = 0; i < 4; i++) w.system.apply(S("dShot"), a, dummy);
    check("out of combat, the ward is whole again", near(absorbedOf(), 150, 1e-9));
  } finally {
    d.on.absorb = was;
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
