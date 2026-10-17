// The abilities test (see ABILITIES.md, *The test*): skill rules, magics, stacking, flags,
// attributes, casting, rolls, threat, and a fight on the tiny world, fought twice.
//   npm run probe -- scripts/probe/abilities.mjs
import { ContentError } from "../../src/world/content/contentReader.ts";
import { resolveGameRules } from "../../src/sim/rules/gameRules.ts";
import { loadRulesFromDisk, packSourcesFromDisk } from "../diskContent.mjs";
import { readConfigFromDisk } from "../diskContent.mjs";
import { createEntity, stepResources } from "../../src/sim/entity.ts";
import { createSkillSystem } from "../../src/sim/skills/system.ts";
import { COMBAT_EVENT_KINDS, EVENT_FLAG, REASONS } from "../../src/sim/skills/events.ts";
import { addModifier, removeSource, statValue } from "../../src/sim/stats.ts";
import { restore } from "../../src/sim/resources.ts";
import { loadContentFromDisk } from "../diskContent.mjs";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";
import { createWorldData, WORLD_SEED } from "../../src/world/worldData.ts";
import { describeEvent } from "../../src/sim/skills/combatLog.ts";
import { createFightClient } from "../server/fightBot.mjs";

let failures = 0;
let checks = 0;
function check(what, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
}
function section(name, run) {
  try {
    run();
  } catch (error) {
    failures++;
    console.log(`FAIL ${name} threw:`, error);
  }
}

const rules = loadRulesFromDisk("tiny");
const skill = (id) => rules.skills[rules.skillIndex.get(id)];

// --- rules: core's skills load, and broken ones say what is wrong ---
section("rules", () => {
  check("core skills load", rules.skills.length >= 15, `${rules.skills.length}`);
  check("combat rules: three roll sets", rules.combat.rolls.length === 3);
  check("the player knows nine spells", rules.templates.get("player").spells.length === 9);
  check("the dummy is hostile, keeps threat, does not die", (() => {
    const d = rules.templates.get("trainingDummy");
    return d.hostility === "hostile" && d.threat && !d.mortal;
  })());

  const fireball = skill("fireball");
  check("fireball: three states, starting at cast", fireball.states.length === 3 && fireball.start === 0);
  check("fireball: travel commits", fireball.states[1].commit && fireball.states[1].length.kind === "travel");
  check("fireball: a cast bar that moving breaks", fireball.states[0].bar === "cast" && fireball.states[0].breakOnMove);
  check("burn: a stacking group of its own, three stacks", skill("burn").stacking.group === "burn" && skill("burn").stacking.max.constant === 3);
  check("shield: absorb held, ends when used up", skill("shield").states[0].hold[0].kind === "absorb" && skill("shield").states[0].on[0].event === "absorbedOut");
  check("charge: off the GCD", skill("charge").gcd === "none");
  check("autoAttack: passive, off the GCD", skill("autoAttack").passive && skill("autoAttack").gcd === "none");

  // An attribute read in an expression is in the scope: fireball's cast length reads fireCastTime.
  const len = fireball.states[0].length.length;
  const values = new Float64Array(fireball.scope.size);
  values[fireball.scope.caster + rules.statIndex.get("fireCastTime")] = 0.8;
  check("fireball's cast time reads caster.fireCastTime", Math.abs(len.run(values) - 2) < 1e-12, `${len.run(values)}`);

  // Broken skills, one problem each.
  const { sources } = packSourcesFromDisk(readConfigFromDisk("tiny"));
  const broken = (id, text) => {
    const extra = { id: "zzbroken", files: [{ path: "pack.json5", text: `{ name: "Broken", priority: 10 }` }, { path: `skills/${id}.json5`, text }] };
    try {
      resolveGameRules([...sources, extra]);
      return [];
    } catch (error) {
      if (!(error instanceof ContentError)) throw error;
      return error.issues.filter((i) => i.file.startsWith("zzbroken"));
    }
  };
  const says = (what, issues, pattern) => check(what, issues.some((i) => pattern.test(`${i.path}: ${i.message}`)), JSON.stringify(issues));
  says("an unknown action", broken("a", `{ states: { s: { enter: [{ do: "explode" }] } } }`), /no action "explode"/);
  says("an unknown state", broken("b", `{ states: { s: { next: "nowhere" } } }`), /no state "nowhere"/);
  says("an unknown group", broken("c", `{ states: { s: { enter: [{ do: "damage", group: "them", amount: 1 }] } } }`), /no group "them"/);
  says("an unknown attribute", broken("d", `{ states: { s: { length: "caster.luck" } } }`), /no "caster.luck"/);
  says("an unknown skill cast", broken("e", `{ states: { s: { enter: [{ do: "cast", skill: "nope" }] } } }`), /no skill "nope"/);
  says("a var the cast skill does not have", broken("f", `{ states: { s: { enter: [{ do: "cast", skill: "burn", vars: { heat: 1 } }] } } }`), /no var "heat"/);
  says("a held kind outside hold", broken("g", `{ states: { s: { enter: [{ do: "flag", flags: ["stunned"] }] } } }`), /hold/);
  says("an instant kind in hold", broken("h", `{ states: { s: { hold: [{ do: "damage", amount: 1 }] } } }`), /cannot be held/);
  says("an unknown flag", broken("i", `{ states: { s: { hold: [{ do: "flag", flags: ["confused"] }] } } }`), /no flag "confused"/);
  says("tick without period", broken("j", `{ states: { s: { tick: [{ do: "end" }] } } }`), /no `period`/);
  says("an unknown event", broken("k", `{ states: { s: { on: { sneezed: "end" } } } }`), /no event "sneezed"/);
  says("a bar on a skill hosted on its target", broken("l", `{ hostOn: "target", states: { s: { bar: "cast" } } }`), /bar belongs/);
  says("an unknown roll set", broken("m", `{ states: { s: { enter: [{ do: "damage", amount: 1, roll: "lucky" }] } } }`), /no roll set "lucky"/);
  says("an unknown summon template", broken("n", `{ states: { s: { enter: [{ do: "summon", template: "dragon" }] } } }`), /no template "dragon"/);
  says("a typo in a field", broken("o", `{ states: { s: { lenght: 3 } } }`), /unknown field/);
});

// --- a stand-in world: entities in one dimension, a clock, sight that can be switched off ---
const PROBE_SKILLS = {
  tStack: `{ vars: { v: 1 }, stacking: { group: "g", per: "host", max: 3 }, states: { s: { length: 10, hold: [{ do: "modifier", stat: "strength", kind: "flat", value: "var.v", perStack: true }] } } }`,
  tExtend: `{ stacking: { duration: "extend", extendCap: 15 }, states: { s: { length: 10 } } }`,
  tLonger: `{ vars: { len: 10 }, stacking: { duration: "longer" }, states: { s: { length: "var.len" } } }`,
  tKeep: `{ vars: { v: 1 }, stacking: { add: "keep" }, states: { s: { length: 10 } } }`,
  tReplace: `{ stacking: { add: "replace" }, states: { s: { length: 10 } } }`,
  tSeparate: `{ stacking: { add: "separate", max: 2 }, states: { s: { length: 10 } } }`,
  tPerCaster: `{ stacking: { per: "caster", max: 1 }, states: { s: { length: 10 } } }`,
  tRankLow: `{ vars: { v: 1 }, stacking: { group: "rank", per: "host", value: "stronger" }, states: { s: { length: 10 } } }`,
  tRankHigh: `{ vars: { v: 5 }, stacking: { group: "rank", per: "host", value: "stronger" }, states: { s: { length: 10 } } }`,
  tStun: `{ states: { s: { length: 2, hold: [{ do: "flag", flags: ["stunned"] }] } } }`,
  tImmune: `{ states: { s: { length: 5, hold: [{ do: "flag", flags: ["immune.stunned"] }] } } }`,
  tHit: `{ vars: { amount: 100 }, states: { s: { enter: [{ do: "damage", amount: "var.amount", roll: "none" }] } } }`,
  tRoll: `{ states: { s: { enter: [{ do: "damage", amount: 10 }] } } }`,
  tTicks: `{ states: { s: { length: 6, period: 2, tick: [{ do: "damage", amount: 1, roll: "none" }] } } }`,
  tProc: `{ passive: true, states: { ready: { on: { hitTaken: "proc" } }, proc: { length: 3, enter: [{ do: "resource", resource: "rage", amount: 7 }], next: "ready" } } }`,
  tCone: `{ areas: { a: { shape: "cone", radius: 10, angle: 90 } }, groups: { g: { from: "area:a", filter: { self: false } } }, states: { s: { enter: [{ do: "damage", group: "g", amount: 1, roll: "none" }] } } }`,
  tRect: `{ areas: { a: { shape: "rect", length: 10, width: 4 } }, groups: { g: { from: "area:a", filter: { self: false } } }, states: { s: { enter: [{ do: "damage", group: "g", amount: 1, roll: "none" }] } } }`,
  tRing: `{ areas: { a: { shape: "ring", radius: 10, inner: 6 } }, groups: { g: { from: "area:a", filter: { self: false } } }, states: { s: { enter: [{ do: "damage", group: "g", amount: 1, roll: "none" }] } } }`,
  tChain: `{ groups: { g: { from: "target", chain: { jumps: 2, radius: 4, filter: { relation: "ally", self: false } } } }, states: { s: { enter: [{ do: "heal", group: "g", amount: 1, roll: "none" }] } } }`,
  tLowest: `{ areas: { a: { shape: "circle", radius: 30 } }, groups: { g: { from: "area:a", filter: { relation: "ally" }, sort: "lowestHealth", max: 1 } }, states: { s: { enter: [{ do: "heal", group: "g", amount: 1, roll: "none" }] } } }`,
  tKnock: `{ states: { s: { enter: [{ do: "move", kind: "knockback", distance: 5, speed: 10, height: 1 }] } } }`,
  tDispel: `{ states: { s: { enter: [{ do: "remove", dispel: "magic", count: 1 }] } } }`,
  tUnstack: `{ states: { s: { enter: [{ do: "stacks", skill: "sunder", amount: -2 }] } } }`,
  tWatch: `{ states: { s: { on: { hostDied: "mourn" } }, mourn: { enter: [{ do: "resource", group: "caster", resource: "rage", amount: 9 }] } } }`,
};
const { sources: tinySources } = packSourcesFromDisk(readConfigFromDisk("tiny"));
const probeRules = resolveGameRules([
  ...tinySources,
  { id: "zzprobe", files: [{ path: "pack.json5", text: `{ name: "Probe", priority: 10 }` }, ...Object.entries(PROBE_SKILLS).map(([id, text]) => ({ path: `skills/${id}.json5`, text }))] },
]);

function makeWorld(rules, seed = 7) {
  const entities = new Map();
  let time = 0;
  let tick = 0;
  let nextId = 1;
  let sight = true;
  const world = {
    seed,
    time: () => time,
    tick: () => tick,
    entity: (id) => entities.get(id),
    entitiesIn: () => entities.values(),
    lineOfSight: () => sight,
    spawn: (dimension, template, x, z, facing) => make(template, x, z, facing),
    despawn: (e) => entities.delete(e.id),
    push: (e, m) => {
      if (m.to) {
        e.x = m.to.x;
        e.z = m.to.z;
      } else if (m.stopAt) {
        e.x = m.stopAt.x - Math.sign(m.vx) * Math.min(Math.abs(m.stopAt.x - e.x), m.stopAt.within);
        e.z = m.stopAt.z - Math.sign(m.vz) * Math.min(Math.abs(m.stopAt.z - e.z), m.stopAt.within);
      } else {
        e.x += m.vx * m.duration;
        e.z += m.vz * m.duration;
      }
    },
  };
  const system = createSkillSystem(rules, world);
  function make(template, x, z, facing = 0) {
    const e = createEntity(rules, rules.templates.get(template), nextId++, { dimension: "d", x, y: 0, z, facing });
    entities.set(e.id, e);
    system.adopt(e);
    return e;
  }
  const events = [];
  function run(seconds, dt = 1 / 30) {
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      time += dt;
      tick++;
      system.step([{ id: "d", entities }]);
      stepResources(entities.values(), dt);
      events.push(...system.drainEvents().map((e) => e.event));
    }
  }
  const drain = () => {
    events.push(...system.drainEvents().map((e) => e.event));
    return events.splice(0, events.length);
  };
  return { world, system, make, run, drain, entities, setSight: (on) => (sight = on), now: () => time };
}

const kindOf = (e) => COMBAT_EVENT_KINDS[e.kind];
const reasonOf = (e) => REASONS[e.reason];
const S = (rules, id) => rules.skillIndex.get(id);
const statOf = (rules, e, id) => statValue(e.stats, rules.statIndex.get(id));
const res = (rules, e, id) => e.resources.current[rules.resourceIndex.get(id)];
const magicsOf = (e, rules, id) => e.combat.magics.filter((m) => m.skill.index === S(rules, id));

// --- magics: states, lengths, ticks, events ---
section("magics", () => {
  const w = makeWorld(probeRules);
  const a = w.make("player", 0, 0);
  const b = w.make("player", 0, 2);
  const m = w.system.apply(S(probeRules, "tTicks"), a, b);
  check("a magic starts on its host", magicsOf(b, probeRules, "tTicks").length === 1 && m.state === 0);
  w.drain();
  w.run(6.05);
  const hits = w.drain().filter((e) => kindOf(e) === "hit");
  check("a 6 s state with a 2 s period ticks three times", hits.length === 3, `${hits.length}`);
  check("ticks are periodic", hits.every((h) => h.flags & EVENT_FLAG.periodic));
  check("it ends when its length runs out", m.ended && magicsOf(b, probeRules, "tTicks").length === 0);

  // A passive answering a combat trigger: hitTaken → proc (rage), back to ready after 3 s.
  w.system.grant(b, S(probeRules, "tProc"), 1, "debug");
  const rage0 = res(probeRules, b, "rage");
  const topUp = () => (b.resources.current[probeRules.health] = b.resources.max[probeRules.health]);
  w.system.apply(S(probeRules, "tHit"), a, b);
  topUp();
  check("a trigger moves a passive on: rage from the proc", res(probeRules, b, "rage") === rage0 + 7, `${res(probeRules, b, "rage")}`);
  w.system.apply(S(probeRules, "tHit"), a, b);
  topUp();
  check("in its internal cooldown it does not proc again", res(probeRules, b, "rage") === rage0 + 7);
  w.run(3.1);
  w.system.apply(S(probeRules, "tHit"), a, b);
  check("after it, it does", res(probeRules, b, "rage") === rage0 + 14, `${rage0} → ${res(probeRules, b, "rage")}`);
  w.system.revoke(b, "debug");
  check("revoking ends the passive", !b.combat.magics.some((x) => x.skill.passive && x.skill.id === "tProc"));
  // Items' hooks (ITEMS.md, *Abilities*): equip gives a spell from the slot's source, unequip takes it.
  w.system.items.equip(b, null, "tProc", "item:trinket");
  check("equip: the item's passive runs", b.combat.spells.some((sp) => sp.source === "item:trinket" && sp.passive && !sp.passive.ended));
  w.system.items.unequip(b, "item:trinket");
  check("unequip: gone, and its passive ended", !b.combat.spells.some((sp) => sp.source === "item:trinket") && !b.combat.magics.some((x) => x.skill.id === "tProc"));
  check("use: an item's skill cast once, not kept", w.system.items.use(b, null, "renew") && !b.combat.spells.some((sp) => sp.skill === S(probeRules, "renew") && sp.source === ""));
});

// --- stacking ---
section("stacking", () => {
  const w = makeWorld(probeRules);
  const a = w.make("player", 0, 0);
  const c = w.make("player", 2, 0);
  const b = w.make("player", 0, 2);
  const str0 = statOf(probeRules, b, "strength");
  const stack = w.system.apply(S(probeRules, "tStack"), a, b);
  check("one stack: +1 strength", statOf(probeRules, b, "strength") === str0 + 1);
  w.run(4);
  w.system.apply(S(probeRules, "tStack"), c, b);
  check("per host: one magic, two stacks", magicsOf(b, probeRules, "tStack").length === 1 && stack.stacks === 2);
  check("perStack modifiers follow the count", statOf(probeRules, b, "strength") === str0 + 2);
  check("restart: length starts again", Math.abs(stack.stateEnds - w.now() - 10) < 1e-6);
  check("per host: the newest caster owns it", stack.caster === c.id);
  w.system.apply(S(probeRules, "tStack"), a, b);
  w.system.apply(S(probeRules, "tStack"), a, b);
  check("max 3 stacks", stack.stacks === 3 && statOf(probeRules, b, "strength") === str0 + 3);
  w.run(10.1);
  check("held modifiers go with it", stack.ended && statOf(probeRules, b, "strength") === str0);

  const ext = w.system.apply(S(probeRules, "tExtend"), a, b);
  w.run(2);
  w.system.apply(S(probeRules, "tExtend"), a, b);
  check("extend: adds the length, capped", Math.abs(ext.stateEnds - w.now() - 15) < 1e-6, `${ext.stateEnds - w.now()}`);

  const longer = w.system.apply(S(probeRules, "tLonger"), a, b);
  w.run(1);
  const left = longer.stateEnds - w.now();
  check("longer: a shorter application leaves it", left > 8.9);

  const keep = w.system.apply(S(probeRules, "tKeep"), a, b);
  check("keep: the second is dropped", w.system.apply(S(probeRules, "tKeep"), a, b) === null && !keep.ended);

  const rep = w.system.apply(S(probeRules, "tReplace"), a, b);
  const rep2 = w.system.apply(S(probeRules, "tReplace"), a, b);
  check("replace: the old ends, the new runs", rep.ended && rep2 && !rep2.ended);

  const s1 = w.system.apply(S(probeRules, "tSeparate"), a, b);
  w.system.apply(S(probeRules, "tSeparate"), a, b);
  w.system.apply(S(probeRules, "tSeparate"), a, b);
  check("separate: side by side up to max, the oldest going", magicsOf(b, probeRules, "tSeparate").length === 2 && s1.ended);

  w.system.apply(S(probeRules, "tPerCaster"), a, b);
  w.system.apply(S(probeRules, "tPerCaster"), c, b);
  check("per caster: one each", magicsOf(b, probeRules, "tPerCaster").length === 2);

  const low = w.system.apply(S(probeRules, "tRankLow"), a, b);
  w.system.apply(S(probeRules, "tRankHigh"), a, b);
  check("two skills sharing a group meet: one magic", b.combat.magics.filter((m) => m.skill.stacking.group === "rank").length === 1);
  check("stronger: the higher rank's values win", low.vars[0] === 5);
  w.system.apply(S(probeRules, "tRankLow"), a, b);
  check("stronger: a lower rank does not replace them", low.vars[0] === 5);

  // vars are fixed when applied; caster attributes are read live.
  const d = makeWorld(rules);
  const p = d.make("player", 0, 0);
  const dummy = d.make("trainingDummy", 0, 3);
  d.system.revoke(dummy, "template");
  const fb = rules.skills[S(rules, "fireball")];
  const castAt = (unit) => d.system.cast(unit, fb.index, dummy.id);
  castAt(p);
  d.run(3.5);
  const burn = magicsOf(dummy, rules, "burn")[0];
  const perTick = burn?.vars[0];
  addModifier(p.stats, { stat: rules.statIndex.get("intellect"), kind: rules.kindIndex.get("flat"), value: 100, source: "probe" });
  check("burn's perTick was fixed when applied", burn && burn.vars[0] === perTick);
  check("burn's length read caster.dotDuration (1)", burn && Math.abs(burn.stateEnds - burn.stateStart - 8) < 1e-6);
  removeSource(p.stats, "probe");
});

// --- flags and attributes ---
section("flags", () => {
  const w = makeWorld(probeRules);
  const a = w.make("player", 0, 0);
  const dummy = w.make("trainingDummy", 0, 6, Math.PI);
  w.system.revoke(dummy, "template");
  const fireball = S(probeRules, "fireball");
  check("a fireball starts", w.system.cast(a, fireball, dummy.id).ok);
  check("its cast shows on the caster", a.combat.casting?.skill.index === fireball);
  w.drain();
  w.system.apply(S(probeRules, "tStun"), dummy, a);
  check("a stun interrupts the cast", a.combat.casting === null && w.drain().some((e) => kindOf(e) === "interrupted"));
  check("stunned: nothing can be cast", !w.system.cast(a, S(probeRules, "renew"), a.id).ok);
  w.system.apply(S(probeRules, "tStun"), dummy, a);
  w.run(1);
  check("two stuns: counted", a.combat.flags.counts[0] === 2);
  w.run(1.1);
  check("both gone after their lengths", a.combat.flags.counts[0] === 0 && a.combat.flags.bits === 0);
  w.system.apply(S(probeRules, "tImmune"), dummy, a);
  w.drain();
  w.system.apply(S(probeRules, "tStun"), dummy, a);
  check("immune: the stun is resisted", a.combat.flags.counts[0] === 0 && w.drain().some((e) => kindOf(e) === "resisted"));

  // Attributes in expressions: fireCastTime shortens the cast, stunDuration and stunTaken the stun.
  const flat = probeRules.kindIndex.get("flat");
  const w2 = makeWorld(probeRules);
  const p = w2.make("player", 0, 0);
  const d2 = w2.make("trainingDummy", 0, 6, Math.PI);
  w2.system.revoke(d2, "template");
  addModifier(p.stats, { stat: probeRules.statIndex.get("fireCastTime"), kind: flat, value: -0.2, source: "talent" });
  w2.system.cast(p, fireball, d2.id);
  check("fireCastTime 0.8: a 2 s cast", Math.abs(p.combat.casting.stateEnds - w2.now() - 2) < 1e-9, `${p.combat.casting?.stateEnds - w2.now()}`);
  addModifier(p.stats, { stat: probeRules.statIndex.get("stunDuration"), kind: flat, value: 1, source: "talent" });
  addModifier(d2.stats, { stat: probeRules.statIndex.get("stunTaken"), kind: flat, value: -0.5, source: "resilience" });
  const cs = w2.system.apply(S(probeRules, "chargeStun"), p, d2);
  check("stun length = 1 × stunDuration 2 × stunTaken 0.5", Math.abs(cs.stateEnds - cs.stateStart - 1) < 1e-9, `${cs.stateEnds - cs.stateStart}`);
  addModifier(p.stats, { stat: probeRules.statIndex.get("dotDuration"), kind: flat, value: 0.5, source: "talent" });
  w2.run(4);
  const burn = magicsOf(d2, probeRules, "burn")[0];
  check("dotDuration 1.5: a 12 s burn", burn && Math.abs(burn.stateEnds - burn.stateStart - 12) < 1e-9);
});

// --- absorbs ---
section("absorbs", () => {
  const w = makeWorld(probeRules);
  const a = w.make("player", 0, 0);
  const dummy = w.make("trainingDummy", 0, 5, Math.PI);
  w.system.revoke(dummy, "template");
  const shield = S(probeRules, "shield");
  check("shield on self", w.system.cast(a, shield, 0).ok && magicsOf(a, probeRules, "shield").length === 1);
  check("weakened soul with it", magicsOf(a, probeRules, "weakenedSoul").length === 1);
  const absorb = a.combat.absorbs[0]?.remaining;
  check("absorb = 40 + 2 × intellect", absorb === 40 + 2 * statOf(probeRules, a, "intellect"), `${absorb}`);
  const h0 = res(probeRules, a, "health");
  w.drain();
  w.system.apply(S(probeRules, "tHit"), dummy, a);
  const hit = w.drain().find((e) => kindOf(e) === "hit");
  check("the hit is absorbed first", hit && hit.absorbed === absorb && hit.amount === 100 - absorb, JSON.stringify(hit));
  check("health takes the rest", res(probeRules, a, "health") === h0 - (100 - absorb));
  check("used up: the shield ends", magicsOf(a, probeRules, "shield").length === 0 && a.combat.absorbs.length === 0);
  w.run(4.1);
  const again = w.system.cast(a, shield, 0);
  check("weakened soul blocks a second shield", !again.ok && again.reason === "blocked", JSON.stringify(again));
});

// --- casting: GCD, queue, cooldowns, costs, range, facing, sight, moving, interrupts ---
section("casting", () => {
  const w = makeWorld(probeRules);
  const p = w.make("player", 0, 0);
  const dummy = w.make("trainingDummy", 0, 3, Math.PI);
  w.system.revoke(dummy, "template");
  const renew = S(probeRules, "renew");
  const mana0 = res(probeRules, p, "mana");
  check("renew: instant", w.system.cast(p, renew, 0).ok);
  check("its cost is paid", res(probeRules, p, "mana") === mana0 - 20);
  const second = w.system.cast(p, renew, 0);
  check("on the GCD: refused", !second.ok && second.reason === "gcd");
  w.run(1.2);
  const queued = w.system.cast(p, renew, 0, { queue: true });
  check("within the queue window: queued", !queued.ok && queued.queued && p.combat.queued);
  w.drain();
  w.run(0.4);
  check("the queued cast fires when the GCD ends", w.drain().some((e) => kindOf(e) === "castDone" && e.skill === renew));
  check("renew from the same caster restarts rather than stacks", magicsOf(p, probeRules, "renew").length === 1);

  // Rage, a cooldown, range and facing.
  restore(p.resources, probeRules.resourceIndex.get("rage"), 100);
  w.run(1.6);
  const hs = S(probeRules, "heroicStrike");
  check("heroic strike lands", w.system.cast(p, hs, dummy.id).ok);
  check("it sunders", magicsOf(dummy, probeRules, "sunder").length === 1);
  w.run(1.6);
  check("on its 3 s cooldown", w.system.cast(p, hs, dummy.id).reason === "cooldown");
  w.run(1.5);
  dummy.z = 30;
  check("out of reach", w.system.cast(p, hs, dummy.id).reason === "range");
  dummy.z = -3;
  check("behind: facing", w.system.cast(p, hs, dummy.id).reason === "facing");
  dummy.z = 20;
  w.setSight(false);
  check("no sight: refused", w.system.cast(p, S(probeRules, "fireball"), dummy.id).reason === "sight");
  w.setSight(true);
  const charge = S(probeRules, "charge");
  check("charge: from afar", w.system.cast(p, charge, dummy.id).ok);
  w.run(1);
  check("charge: arrived beside it", Math.abs(p.z - 20) < 2, `${p.z}`);
  check("charge: the dummy is stunned", (dummy.combat.flags.bits & 1) !== 0);

  // Moving breaks a cast; a channel or an instant would not.
  w.run(1.6);
  const fireball = S(probeRules, "fireball");
  const manaBefore = res(probeRules, p, "mana");
  check("fireball starts", w.system.cast(p, fireball, dummy.id).ok);
  p.combat.moved = true;
  w.drain();
  w.run(0.1);
  check("moving stops it", p.combat.casting === null && w.drain().some((e) => kindOf(e) === "castStopped" && reasonOf(e) === "moved"));
  check("and nothing was paid: it never committed", res(probeRules, p, "mana") >= manaBefore);

  // The dummy's bolt and a kick: interrupted, locked out of its school.
  const bolt = S(probeRules, "dummyBolt");
  p.x = 0;
  p.z = 0;
  dummy.z = 3;
  w.run(2);
  check("the dummy casts at the player", w.system.cast(dummy, bolt, p.id, { transient: { level: 1 } }).ok && dummy.combat.casting);
  restore(p.resources, probeRules.resourceIndex.get("rage"), 100);
  w.drain();
  check("kick", w.system.cast(p, S(probeRules, "kick"), dummy.id).ok);
  const ev = w.drain();
  check("the bolt is interrupted", dummy.combat.casting === null && ev.some((e) => kindOf(e) === "interrupted"));
  check("arcane is locked out", w.system.cast(dummy, bolt, p.id, { transient: { level: 1 } }).reason === "locked");
  w.run(4.1);
  check("and free again after 4 s", w.system.cast(dummy, bolt, p.id, { transient: { level: 1 } }).ok);
});

// --- rolls: rates, and the same seed giving the same rolls ---
section("rolls", () => {
  const roll = (seed) => {
    const w = makeWorld(probeRules, seed);
    const p = w.make("player", 0, 0);
    const dummy = w.make("trainingDummy", 0, 3, Math.PI);
    w.system.revoke(dummy, "template");
    const out = [];
    for (let i = 0; i < 10000; i++) {
      w.system.apply(S(probeRules, "tRoll"), p, dummy);
      dummy.resources.current[probeRules.health] = dummy.resources.max[probeRules.health];
      for (const e of w.drain()) if (kindOf(e) === "hit" || kindOf(e) === "miss") out.push(e);
      if (i % 100 === 0) w.run(1 / 30);
    }
    return out;
  };
  const a = roll(7);
  const misses = a.filter((e) => kindOf(e) === "miss").length / a.length;
  const crits = a.filter((e) => e.flags & EVENT_FLAG.crit).length / a.length;
  // Level 1 against level 10: hit 0.95 - 0.09 = 0.86; crit 0.05 + 10 / 2000 = 0.055 of all rolls that hit.
  check("miss rate near 14%", Math.abs(misses - 0.14) < 0.015, `${misses}`);
  check("crit rate near 0.86 × 5.5%", Math.abs(crits - 0.86 * 0.055) < 0.01, `${crits}`);
  const b = roll(7);
  check("same seed, same rolls", a.length === b.length && a.every((e, i) => e.kind === b[i].kind && e.amount === b[i].amount && e.flags === b[i].flags));
  const c = roll(8);
  check("another seed, other rolls", c.some((e, i) => e.kind !== a[i]?.kind || e.amount !== a[i]?.amount));
});

// --- areas, groups, movement, removal ---
section("areas", () => {
  const w = makeWorld(probeRules);
  const caster = w.make("player", 0, 0, 0); // facing +z
  const ahead = w.make("player", 0, 5);
  const side = w.make("player", 5, 0);
  const behind = w.make("player", 0, -5);
  const far = w.make("player", 0, 8);
  const hitBy = (skill) => {
    w.drain();
    w.system.apply(S(probeRules, skill), caster, caster);
    return new Set(w.drain().filter((e) => kindOf(e) === "hit").map((e) => e.target));
  };
  const cone = hitBy("tCone");
  check("a cone: ahead in, side and behind out", cone.has(ahead.id) && cone.has(far.id) && !cone.has(side.id) && !cone.has(behind.id), [...cone].join());
  const rect = hitBy("tRect");
  check("a rect: along the facing only", rect.has(ahead.id) && rect.has(far.id) && !rect.has(side.id) && !rect.has(behind.id), [...rect].join());
  const ring = hitBy("tRing");
  check("a ring: between its radii", ring.has(far.id) && !ring.has(ahead.id), [...ring].join());

  // A chain: from the target to the nearest allies within 4 m, two jumps, never twice.
  const w2 = makeWorld(probeRules);
  const c = w2.make("player", 0, 0);
  const t1 = w2.make("player", 10, 0);
  const t2 = w2.make("player", 13, 0);
  const t3 = w2.make("player", 16, 0);
  w2.make("player", 30, 0);
  w2.drain();
  const healTimes = { ...Object.fromEntries([t1, t2, t3].map((t) => [t.id, 0])) };
  const m = w2.system.apply(S(probeRules, "tChain"), c, t1);
  const heals = w2.drain().filter((e) => kindOf(e) === "heal").map((e) => e.target);
  for (const id of heals) if (id in healTimes) healTimes[id]++;
  check("a chain: three links, each once", heals.length === 3 && Object.values(healTimes).every((n) => n === 1), heals.join());
  check("a chain magic ends after its instant state", m === null || m.ended);

  // Lowest health first.
  const hurt = w2.entities.get(t2.id);
  hurt.resources.current[probeRules.health] = 10;
  w2.drain();
  w2.system.apply(S(probeRules, "tLowest"), c, c);
  const lowest = w2.drain().find((e) => kindOf(e) === "heal");
  check("sort lowestHealth: the most hurt ally", lowest?.target === t2.id);

  // Knockback: away from the caster.
  const k = w2.make("player", 0, 3);
  w2.system.apply(S(probeRules, "tKnock"), c, k);
  check("a knockback pushes away from the caster", k.z > 7, `${k.z}`);

  // Dispel: one magic-type aura off; stacks taken off; a magic hearing its host die.
  const dummy = w2.make("trainingDummy", 0, -3, 0);
  w2.system.revoke(dummy, "template");
  w2.system.cast(c, S(probeRules, "renew"), t3.id);
  check("renew on the ally", magicsOf(t3, probeRules, "renew").length === 1);
  w2.system.apply(S(probeRules, "tDispel"), c, t3);
  check("dispel magic removes it", magicsOf(t3, probeRules, "renew").length === 0);
  for (let i = 0; i < 4; i++) w2.system.apply(S(probeRules, "sunder"), c, dummy);
  const sunder = magicsOf(dummy, probeRules, "sunder")[0];
  w2.system.apply(S(probeRules, "tUnstack"), c, dummy);
  check("stacks: 4 sunders less 2", sunder.stacks === 2);
  w2.system.apply(S(probeRules, "tUnstack"), c, dummy);
  check("stacks gone: it ends", sunder.ended);
  const rage0 = res(probeRules, c, "rage");
  w2.system.apply(S(probeRules, "tWatch"), c, t3);
  w2.system.kill(t3);
  check("hostDied moves a magic on", res(probeRules, c, "rage") === Math.min(100, rage0 + 9));
  check("the dead are flagged dead", (t3.combat.flags.bits & (1 << 7)) !== 0 && t3.combat.dead);
  check("the dead cannot cast", w2.system.cast(t3, S(probeRules, "renew"), 0).reason === "dead");
  w2.system.revive(t3);
  check("revived: full health, not dead", !t3.combat.dead && t3.combat.flags.bits === 0 && res(probeRules, t3, "health") === t3.resources.max[probeRules.health]);
});

// --- threat ---
section("threat", () => {
  const w = makeWorld(probeRules);
  const p = w.make("player", 0, 0);
  const q = w.make("player", 2, 0);
  const dummy = w.make("trainingDummy", 0, 3, Math.PI);
  w.system.revoke(dummy, "template");
  const hit = S(probeRules, "tHit");
  w.system.apply(hit, p, dummy);
  const table = dummy.combat.threat;
  check("damage puts the dealer on the table", table.has(p.id) && table.get(p.id).amount > 0);
  p.resources.current[probeRules.health] -= 50;
  w.system.cast(q, S(probeRules, "renew"), p.id);
  w.run(3.05);
  check("healing someone on the table puts the healer on it", table.has(q.id) && table.get(q.id).amount > 0);
  check("both are in combat", p.inCombat && q.inCombat && dummy.inCombat);
  w.system.cast(q, S(probeRules, "searingTotem"), 0);
  const totem = [...w.entities.values()].find((e) => e.template.id === "searingTotem");
  check("a summon is made, owned by its caster", totem && totem.combat.owner === q.id && q.combat.summons.includes(totem.id));
  w.run(2.1);
  check("the summon has its own row", table.has(totem.id) && table.get(totem.id).amount > 0);
  check("the owner's row is not its pet's", table.get(q.id).amount < table.get(totem.id).amount + table.get(q.id).amount);
  w.run(19);
  check("the totem goes after 20 s, and off the table", !w.entities.has(totem.id) && !table.has(totem.id));
  w.run(7);
  check("idle rows are forgotten", table.size === 0, `${[...table.keys()]}`);
  w.run(5.1);
  check("and everyone leaves combat", !p.inCombat && !q.inCombat && !dummy.inCombat);
});

// --- a fight: a real server on the tiny world, a client playing a rotation on the dummy for 60 s
// of server time, fought twice - the two combat logs must be the same ---
async function fightOnce() {
  const configName = "tiny";
  const fightRules = loadRulesFromDisk(configName);
  const { content, packs } = loadContentFromDisk(configName);
  const server = createServer({
    seed: WORLD_SEED,
    config: configName,
    packs,
    dimensions: content.dimensions,
    rules: fightRules,
    loadDimension: (definition, seed) => ({ world: createWorldData(seed, definition.start ? content : loadContentFromDisk(configName, definition.id).content) }),
  });
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "fighter", dimension: "" });
  const fighter = createFightClient(fightRules, channel.client);
  const all = [];
  for (let step = 0; step < 60 * 30 + 60; step++) {
    if (step < 5) await new Promise((resolve) => setTimeout(resolve, 0)); // let the dimension load
    fighter.receive();
    all.push(...fighter.state.events.splice(0));
    fighter.drive(server.tick);
    server.step(1 / 30);
  }
  fighter.receive();
  all.push(...fighter.state.events.splice(0));
  const log = all.filter(fighter.loggable).map((e) => `[${e.time.toFixed(2)}] ${describeEvent(fightRules, e, fighter.nameOf)}`);
  const dummy = server.debug.entity(fighter.state.dummy?.id ?? -1);
  return { log, events: all, rules: fightRules, dummy, me: server.debug.entity(fighter.state.id) };
}

await (async () => {
  try {
    const first = await fightOnce();
    const second = await fightOnce();
    const kinds = (run, kind) => run.events.filter((e) => COMBAT_EVENT_KINDS[e.kind] === kind);
    const r = first.rules;
    console.log(`fight: ${first.log.length} log lines; the first ten:`);
    for (const line of first.log.slice(0, 10)) console.log(`  ${line}`);
    check("the fight has hits, heals, casts and auras", ["hit", "heal", "castDone", "auraOn"].every((k) => kinds(first, k).length > 0));
    check("auto-attack swings, with an animation each", kinds(first, "animation").some((e) => e.name === "swing" && e.skill === r.skillIndex.get("autoAttack")));
    check("the dummy casts its bolt", kinds(first, "castStart").some((e) => e.skill === r.skillIndex.get("dummyBolt")));
    check("the fighter kicks it", kinds(first, "interrupted").length > 0);
    check("the shield soaks a bolt", kinds(first, "hit").some((e) => e.absorbed > 0 && e.skill === r.skillIndex.get("dummyBolt")));
    check("the totem fights", kinds(first, "hit").some((e) => e.skill === r.skillIndex.get("totemBolt")));
    check("burns stack on the dummy", kinds(first, "auraStacks").some((e) => e.skill === r.skillIndex.get("burn")));
    check("the dummy never dies", !kinds(first, "death").length && first.dummy && !first.dummy.combat.dead);
    check("the dummy keeps a threat table with the fighter on it", first.dummy?.combat.threat.has(first.me.id));
    check("sunder is on the dummy at the end", first.dummy?.combat.magics.some((m) => m.skill.id === "sunder"));
    check("the fighter is in combat", first.me?.inCombat);
    check("both fights' logs are the same", first.log.length === second.log.length && first.log.every((line, i) => line === second.log[i]), first.log.find((l, i) => l !== second.log[i]));
    check("and every event, field by field", JSON.stringify(first.events) === JSON.stringify(second.events));
  } catch (error) {
    failures++;
    console.log("FAIL fight threw:", error);
  }
})();

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
