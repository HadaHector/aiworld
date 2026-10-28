// A client that hunts creatures (see CREATURES.md, *The test*): it walks out until it sees one, runs
// to the nearest living creature, fights it with a simple rotation, loots the corpse, and goes on to
// the next - from nothing but the messages a real client gets. Used by `npm run server -- --bot
// --hunt` and by the creatures probe.
import { EVENT_KIND } from "../../src/sim/skills/events.ts";
import { FLAG } from "../../src/sim/skills/flags.ts";

const RAGE_COSTS = { kick: 10, heroicStrike: 15, thunderClap: 20 };
const MANA_COSTS = { renew: 20, shield: 30 };
/** Seconds the bot heads one way while it sees nothing to hunt, before it turns. */
const ROAM_LEG = 40;

export function createHuntClient(rules, creatures, end, progression = null) {
  const state = {
    id: 0,
    seq: 0,
    time: 0,
    dimension: "",
    /** Everything in view: template, name, where, dead, lootable, health. */
    entities: new Map(),
    spells: [],
    gcdUntil: 0,
    attacking: false,
    casting: new Map(),
    auras: new Map(),
    resources: new Map(),
    events: [],
    prey: 0,
    maxHealth: 1,
    resting: false,
    /** The unit it last told the server to target. */
    targeted: 0,
    looting: 0,
    lootSince: 0,
    lootOpen: 0,
    /** Ids it has looted or given up on. */
    done: new Set(),
    kills: 0,
    loots: [],
    deaths: 0,
    roam: { angle: 0, until: 0 },
    log: [],
  };
  const skill = (id) => rules.skillIndex.get(id);
  const isCreature = (template) => creatures.kinds.has(template);
  const me = () => state.entities.get(state.id);

  function receive() {
    const messages = end.receive();
    for (const message of messages) {
      switch (message.type) {
        case "welcome":
          state.id = message.playerId;
          break;
        case "transfer":
          state.dimension = message.dimension;
          state.entities.clear();
          end.send({ type: "arrived" });
          break;
        case "snapshot":
          state.time = message.time;
          for (const m of message.entities) {
            const e = state.entities.get(m.id);
            if (e) Object.assign(e, { x: m.x, y: m.y, z: m.z, facing: m.facing });
          }
          break;
        case "entitySpawn":
          state.entities.set(message.id, { id: message.id, template: message.template, name: message.name, x: message.x, y: message.y, z: message.z, dead: false, lootable: false, health: 1 });
          if (message.id === state.id) for (const r of message.resources) state.resources.set(r.resource, r.current);
          if (message.id === state.id) for (const r of message.resources) if (r.resource === rules.health) state.maxHealth = r.max;
          break;
        case "entityDespawn":
          state.entities.delete(message.id);
          break;
        case "entityValues":
          if (message.id === state.id) for (const r of message.resources) state.resources.set(r.resource, r.current);
          if (message.id === state.id) for (const r of message.resources) if (r.resource === rules.health) state.maxHealth = r.max;
          for (const r of message.resources) if (r.resource === rules.health && state.entities.has(message.id)) state.entities.get(message.id).health = r.max > 0 ? r.current / r.max : 0;
          break;
        case "entityFlags": {
          const e = state.entities.get(message.id);
          if (e) e.dead = (message.flags & (1 << FLAG.dead)) !== 0;
          break;
        }
        case "entityLootable": {
          const e = state.entities.get(message.id);
          if (e) e.lootable = message.lootable;
          break;
        }
        case "entitySpells":
          state.spells = message.spells;
          state.gcdUntil = message.gcdUntil;
          state.attacking = message.attacking;
          break;
        case "entityCast":
          state.casting.set(message.id, message.skill);
          break;
        case "entityTarget": {
          const e = state.entities.get(message.id);
          if (e) e.target = message.target;
          break;
        }
        case "entityAuras":
          state.auras.set(message.id, message.auras.map((a) => a.skill));
          break;
        case "combatEvents":
          state.events.push(...message.events);
          for (const event of message.events) {
            if (event.kind === EVENT_KIND.death && event.target !== state.id && state.entities.has(event.target) && isCreature(state.entities.get(event.target).template)) state.kills++;
            if (event.kind === EVENT_KIND.death && event.target === state.id) state.deaths++;
          }
          break;
        case "progressEvents":
          // XP and level-ups (PROGRESSION.md), as lines of its log.
          for (const e of message.events) {
            const d = progression?.disciplines[e.discipline]?.name ?? `discipline ${e.discipline}`;
            if (e.kind === "xp" && e.source !== "hitDealt" && e.source !== "hitTaken" && e.source !== "cast") state.log.push(`+${Math.round(e.amount)} ${d} XP (${e.source})`);
            if (e.kind === "levelUp") state.log.push(`${d} is now level ${e.level}`);
            if (e.kind === "learned") state.log.push(`learned ${rules.skills[e.skill]?.name ?? e.skill} (${e.source})`);
          }
          break;
        case "loot":
          state.lootOpen = message.entity;
          if (message.entity && (message.items.some(Boolean) || message.money.some((n) => n > 0))) {
            state.loots.push({ from: state.entities.get(message.entity)?.name ?? `#${message.entity}`, items: message.items.filter(Boolean).map((i) => `${i.type}${i.count > 1 ? ` x${i.count}` : ""}`), money: message.money[0] ?? 0 });
          }
          break;
      }
    }
    return messages;
  }

  const distanceTo = (e) => {
    const m = me();
    return m ? Math.hypot(e.x - m.x, e.z - m.z) : Infinity;
  };

  function move(towardX, towardZ, run) {
    const m = me();
    state.seq = (state.seq + 1) & 0xffff;
    if (!m || towardX === null) return end.send({ type: "intent", seq: state.seq, moveX: 0, moveZ: 0, run: false, jump: false });
    const dx = towardX - m.x;
    const dz = towardZ - m.z;
    const d = Math.hypot(dx, dz) || 1;
    end.send({ type: "intent", seq: state.seq, moveX: dx / d, moveZ: dz / d, run, jump: false });
  }
  const stand = () => move(null, null, false);

  /** One step of playing: an intent every step, a decision every sixth. */
  function drive(tick) {
    const m = me();
    if (!m) return stand();
    if (m.dead) {
      stand();
      if (tick % 30 === 0) end.send({ type: "respawn" });
      state.prey = 0;
      return;
    }
    // Whoever is on us comes first; else the prey we picked; else the nearest living creature.
    const living = [...state.entities.values()].filter((e) => isCreature(e.template) && !e.dead && !state.done.has(e.id));
    const attacker = living.find((e) => e.target === state.id);
    let prey = state.entities.get(state.prey);
    if (!prey || prey.dead) {
      if (prey?.dead && prey.lootable && !state.done.has(prey.id)) state.looting = prey.id;
      prey = attacker ?? living.sort((a, b) => distanceTo(a) - distanceTo(b))[0];
      state.prey = prey?.id ?? 0;
      if (prey) state.log.push(`hunting ${prey.name} (#${prey.id}) ${distanceTo(prey).toFixed(0)} m off`);
    }

    // Loot what we killed before going on, if nothing is on us.
    let corpse = state.entities.get(state.looting);
    if (corpse && state.lootSince === 0) state.lootSince = state.time;
    // A corpse it cannot get to or open in a while is left.
    if (corpse && state.time - state.lootSince > 10) {
      state.log.push(`gave up looting ${corpse.name} (#${corpse.id})`);
      state.done.add(corpse.id);
      state.looting = 0;
      corpse = undefined;
    }
    if (!corpse) state.lootSince = 0;
    if (corpse && corpse.lootable && (!prey || distanceTo(prey) > 25)) {
      if (distanceTo(corpse) > 2.5) return move(corpse.x, corpse.z, true);
      stand();
      if (tick % 6 === 0) {
        if (state.lootOpen !== corpse.id) end.send({ type: "lootOpen", entity: corpse.id });
        else end.send({ type: "lootTake", slot: 0xffff });
      }
      return;
    }
    if (corpse && !corpse.lootable) {
      state.done.add(corpse.id);
      state.looting = 0;
      state.lootSince = 0;
    }

    // Low with nothing on it: rest until nearly full.
    const share = (state.resources.get(rules.health) ?? 0) / Math.max(1, state.maxHealth);
    if (!attacker && (share < 0.6 || (state.resting && share < 0.95))) {
      if (!state.resting) state.log.push(`resting at ${Math.round(share * 100)}% health`);
      state.resting = true;
      return stand();
    }
    state.resting = false;
    if (!prey) {
      // Nothing in view: head out one way, turning now and then.
      if (state.time >= state.roam.until) state.roam = { angle: (state.roam.angle + 2.4) % (Math.PI * 2), until: state.time + ROAM_LEG };
      return move(m.x + Math.sin(state.roam.angle) * 50, m.z + Math.cos(state.roam.angle) * 50, true);
    }
    const distance = distanceTo(prey);
    // A body faces the way it last moved: in reach but not facing the prey, a step toward it.
    const off = Math.abs(((Math.atan2(prey.x - m.x, prey.z - m.z) - (m.facing ?? 0) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const walk = distance > 2.4 || (off > 1 && distance > 0.3);
    if (walk) move(prey.x, prey.z, distance > 2.4);
    else stand();
    if (tick % 6 !== 0 || distance > 30) return;
    if (!state.attacking || state.targeted !== prey.id) {
      state.targeted = prey.id;
      end.send({ type: "target", id: prey.id });
      end.send({ type: "attack", on: true });
    }
    const rage = state.resources.get(rules.resourceIndex.get("rage")) ?? 0;
    const mana = state.resources.get(rules.resourceIndex.get("mana")) ?? 0;
    const ready = (id) => (state.spells.find((s) => s.skill === skill(id))?.ready ?? Infinity) <= state.time && rage >= (RAGE_COSTS[id] ?? 0) && mana >= (MANA_COSTS[id] ?? 0);
    const cast = (id, target = prey.id) => end.send({ type: "cast", seq: state.seq, skill: skill(id), target, x: 0, z: 0 });
    const mine = state.auras.get(state.id) ?? [];
    if ((state.casting.get(prey.id) ?? -1) >= 0 && distance < 4 && ready("kick")) return cast("kick");
    if ((state.casting.get(state.id) ?? -1) >= 0 || state.gcdUntil > state.time) return;
    if (distance > 8 && distance < 25 && ready("charge")) return cast("charge");
    if (!mine.includes(skill("shield")) && !mine.includes(skill("weakenedSoul")) && ready("shield")) return cast("shield", state.id);
    if (!mine.includes(skill("renew")) && ready("renew")) return cast("renew", state.id);
    if (distance < 4 && ready("thunderClap")) return cast("thunderClap", 0);
    if (distance < 4 && ready("heroicStrike")) return cast("heroicStrike");
  }

  const loggable = (event) => event.kind !== EVENT_KIND.animation && event.kind !== EVENT_KIND.effect;

  return { state, receive, drive, loggable, nameOf: (id) => state.entities.get(id)?.name ?? `#${id}` };
}
