// A client that fights the training dummy (see ABILITIES.md, *The test*): it walks up to it, targets
// it, attacks, and keeps a simple rotation going - kick its casts, keep a shield and a renew up, a
// totem, a clap, a strike, fireballs - from nothing but the messages a real client gets. Used by
// `npm run server -- --bot --fight` and by the abilities probe, which fights the same fight twice.
import { EVENT_KIND } from "../../src/sim/skills/events.ts";

const RAGE_COSTS = { kick: 10, heroicStrike: 15, thunderClap: 20 };
const MANA_COSTS = { fireball: 35, renew: 20, shield: 30, searingTotem: 25 };

export function createFightClient(rules, end) {
  const state = {
    id: 0,
    seq: 0,
    me: null,
    time: 0,
    dimension: "",
    names: new Map(),
    dummy: null,
    spells: [],
    gcdUntil: 0,
    attacking: false,
    casting: new Map(),
    auras: new Map(),
    resources: new Map(),
    events: [],
  };
  const skill = (id) => rules.skillIndex.get(id);

  /** Reads what the server sent; returns every message, for whoever wants more of it. */
  function receive() {
    const messages = end.receive();
    for (const message of messages) {
      switch (message.type) {
        case "welcome":
          state.id = message.playerId;
          break;
        case "transfer":
          state.dimension = message.dimension;
          state.me = null;
          end.send({ type: "arrived" });
          break;
        case "snapshot":
          state.me = message.entities.find((e) => e.id === state.id) ?? state.me;
          state.time = message.time;
          break;
        case "entitySpawn":
          state.names.set(message.id, message.name);
          if (message.template === "trainingDummy" && !state.dummy) state.dummy = { id: message.id, x: message.x, z: message.z };
          if (message.id === state.id) for (const r of message.resources) state.resources.set(r.resource, r.current);
          break;
        case "entityValues":
          if (message.id === state.id) for (const r of message.resources) state.resources.set(r.resource, r.current);
          break;
        case "entitySpells":
          state.spells = message.spells;
          state.gcdUntil = message.gcdUntil;
          state.attacking = message.attacking;
          break;
        case "entityCast":
          state.casting.set(message.id, message.skill);
          break;
        case "entityAuras":
          state.auras.set(message.id, message.auras.map((a) => a.skill));
          break;
        case "combatEvents":
          state.events.push(...message.events);
          break;
      }
    }
    return messages;
  }

  /** One step of playing: an intent every step, a decision every sixth. */
  function drive(tick) {
    const me = state.me;
    const dummy = state.dummy;
    state.seq = (state.seq + 1) & 0xffff;
    if (!me || !dummy) {
      end.send({ type: "intent", seq: state.seq, moveX: 0, moveZ: 0, run: false, jump: false });
      return;
    }
    const dx = dummy.x - me.x;
    const dz = dummy.z - me.z;
    const distance = Math.hypot(dx, dz);
    // Walk until close, then stand, facing it (a body faces the way it last moved).
    const walk = distance > 2.2;
    end.send({ type: "intent", seq: state.seq, moveX: walk ? dx / distance : 0, moveZ: walk ? dz / distance : 0, run: distance > 8, jump: false });
    if (walk || tick % 6 !== 0) return;
    const rage = state.resources.get(rules.resourceIndex.get("rage")) ?? 0;
    const mana = state.resources.get(rules.resourceIndex.get("mana")) ?? 0;
    const ready = (id) =>
      (state.spells.find((s) => s.skill === skill(id))?.ready ?? Infinity) <= state.time && rage >= (RAGE_COSTS[id] ?? 0) && mana >= (MANA_COSTS[id] ?? 0);
    const cast = (id, target = dummy.id) => end.send({ type: "cast", seq: state.seq, skill: skill(id), target, x: 0, z: 0 });
    if (!state.attacking) {
      end.send({ type: "target", id: dummy.id });
      end.send({ type: "attack", on: true });
    }
    const mine = state.auras.get(state.id) ?? [];
    const onDummy = state.auras.get(dummy.id) ?? [];
    if ((state.casting.get(dummy.id) ?? -1) >= 0 && ready("kick")) return cast("kick");
    if ((state.casting.get(state.id) ?? -1) >= 0 || state.gcdUntil > state.time) return;
    if (!mine.includes(skill("shield")) && !mine.includes(skill("weakenedSoul")) && ready("shield")) return cast("shield", state.id);
    if (!mine.includes(skill("renew")) && ready("renew")) return cast("renew", state.id);
    if (ready("searingTotem")) return cast("searingTotem", 0);
    if (ready("thunderClap") && !onDummy.includes(skill("thunderClapSlow"))) return cast("thunderClap", 0);
    if (ready("heroicStrike")) return cast("heroicStrike");
    if (ready("fireball")) cast("fireball");
  }

  /** The events to print: animations and effects left out. */
  const loggable = (event) => event.kind !== EVENT_KIND.animation && event.kind !== EVENT_KIND.effect;

  return { state, receive, drive, loggable, nameOf: (id) => state.names.get(id) ?? `#${id}` };
}
