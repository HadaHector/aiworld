/**
 * The commands the server owns (CHAT.md): the player's own (/say, /world) and the developer's
 * (/give, /level, /tp ...). Each is a `CommandDef` (what everyone sees of it) and a `run` (what only the
 * server has). A host - the server, a mod - may `add` more. Replies are templates, never finished words.
 */
import type { Entity } from "../entity";
import type { Dimension } from "../dimension";
import type { GameRules } from "../rules/gameRules";
import type { ItemRules } from "../rules/itemRules";
import type { ProgressionSystem } from "../progression/system";
import type { SkillSystem } from "../skills/system";
import type { CreatureSystem } from "../creatures/system";
import { restore } from "../resources";
import { createRegistry, type ArgKind, type ArgSpec, type ArgValue, type CommandDef, type NameBook } from "./chat";
import type { TextArgs } from "../text";
import type { CommandPackDef } from "./commandPacks";

export interface ServerCommand extends CommandDef {
  owner: "server";
  run: (ctx: CommandContext, values: ArgValue[]) => void;
}

/** What a command may do, as the server lends it. */
export interface CommandHost {
  seed: number;
  config: string;
  packs: readonly string[];
  rules: GameRules;
  itemRules: ItemRules | null;
  /** Puts items in the bag; how many did not fit. */
  give: (entity: Entity, type: number, count: number) => number;
  progression: ProgressionSystem | null;
  skills: SkillSystem;
  creatures: CreatureSystem | null;
  dimension: (entity: Entity) => Dimension | undefined;
  /** Puts the entity on the ground at a point in its dimension. */
  teleport: (entity: Entity, x: number, z: number) => void;
  /** Says a line to those who hear a player at this point. */
  say: (entity: Entity, text: string) => void;
}

export interface CommandContext {
  entity: Entity;
  host: CommandHost;
  /** Runs another command line as this player (for commands made of others). */
  exec: (line: string) => void;
  reply: (text: string, args?: TextArgs) => void;
}

const arg = (name: string, kind: ArgKind, optional = false, names?: ArgKind[], extra?: string[]): ArgSpec => ({ name, kind, optional, names, extra });

/** The places and zones a dimension offers /tp, by name. */
function placesOf(dimension: Dimension | undefined): { id: string; name: string; x: number; z: number }[] {
  if (!dimension) return [];
  return dimension.world.settlements.map((s) => ({ id: s.name, name: s.name, x: s.x, z: s.z }));
}
function zonesOf(dimension: Dimension | undefined): { id: string; name: string; x: number; z: number }[] {
  if (!dimension) return [];
  const out: { id: string; name: string; x: number; z: number }[] = [];
  for (const [id, name] of dimension.world.areaNames) {
    const b = dimension.world.areaBounds.get(id);
    if (b) out.push({ id: name, name, x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 });
  }
  return out;
}

/** The names a sender's commands can mention, by kind. */
export function nameBook(host: CommandHost, entity: Entity): NameBook {
  return {
    names(kind) {
      switch (kind) {
        case "item":
          return host.itemRules?.types.map((t) => ({ id: t.id, name: t.name })) ?? [];
        case "skill":
          return host.rules.skills.map((s) => ({ id: s.id, name: s.name }));
        case "creature":
          return host.creatures ? host.creatures.debug.kindIds().map((id) => ({ id, name: host.rules.templates.get(id)?.name ?? id })) : [];
        case "discipline":
          return host.progression?.rules.disciplines.map((d) => ({ id: d.id, name: d.name })) ?? [];
        case "zone":
          return zonesOf(host.dimension(entity));
        case "place":
          return placesOf(host.dimension(entity));
        default:
          return [];
      }
    },
  };
}

function define(def: Omit<CommandDef, "owner" | "args"> & { args: ArgSpec[]; run: ServerCommand["run"] }): ServerCommand {
  return { ...def, owner: "server" };
}

/** Default discipline: the character's own level discipline. */
function levelDiscipline(host: CommandHost, value: ArgValue | undefined): number {
  const p = host.progression;
  if (!p) return -1;
  if (typeof value === "string") return p.rules.disciplines.findIndex((d) => d.id === value);
  return p.rules.config.level;
}

const num = (v: ArgValue | undefined, fallback = 0): number => (typeof v === "number" ? v : fallback);

/** The server's commands: the core ones, how the packs say they read, and the commands the packs make. */
export function createServerCommands(packs: readonly CommandPackDef[] = []): ReturnType<typeof createRegistry<ServerCommand>> {
  const registry = createRegistry<ServerCommand>();
  const core: ServerCommand[] = [];
  const add = (def: Parameters<typeof define>[0]): void => void core.push(define(def));

  add({
    id: "say",
    aliases: ["s"],
    usage: "<text>",
    summary: "Says something to those nearby.",
    dev: false,
    args: [arg("text", "text")],
    run: ({ entity, host }, [text]) => host.say(entity, String(text)),
  });

  add({
    id: "world",
    usage: "",
    summary: "Tells how this world was made: seed, config, packs, and where you stand.",
    dev: false,
    args: [],
    run({ entity, host, reply }) {
      const dimension = host.dimension(entity);
      reply("Seed {seed}, config {config}, packs {packs}.", { seed: host.seed, config: host.config, packs: host.packs.join(", ") || "-" });
      if (!dimension) return;
      const sample = dimension.world.sampleTerrain(entity.x, entity.z);
      const zone = host.creatures?.debug.zoneAt(dimension.id, entity.x, entity.z);
      reply("Dimension {dimension}, world seed {worldSeed}, {areas} zones, {settlements} settlements.", { dimension: dimension.id, worldSeed: dimension.world.seed, areas: dimension.world.areaNames.size, settlements: dimension.world.settlements.length });
      reply("You are at {x}, {z}, height {y}: zone {zone}, biome {biome}.", {
        x: Math.round(entity.x),
        z: Math.round(entity.z),
        y: Math.round(entity.y),
        zone: dimension.world.areaNames.get(sample.primaryAreaId) ?? "?",
        biome: sample.primaryBiome.name,
      });
      if (zone) reply("Creatures here are level {low} to {high}.", { low: zone.levels[0], high: zone.levels[1] });
    },
  });

  add({
    id: "give",
    aliases: ["item"],
    usage: "<item> [count]",
    summary: "Puts an item in your bag.",
    dev: true,
    args: [arg("item", "item"), arg("count", "int", true)],
    run({ entity, host, reply }, [item, count]) {
      const index = host.itemRules?.typeIndex.get(String(item));
      if (index === undefined) return reply("There are no items here.");
      const n = Math.max(1, Math.min(9999, num(count, 1)));
      const left = host.give(entity, index, n);
      const name = host.itemRules!.types[index].name;
      if (left >= n) reply("Your bag is full.");
      else reply("Given {count} {item}.", { count: n - left, item: name });
    },
  });

  add({
    id: "level",
    usage: "<level> [discipline]",
    summary: "Sets a discipline's level (your character's by default).",
    dev: true,
    args: [arg("level", "int"), arg("discipline", "discipline", true)],
    run({ entity, host, reply }, [level, discipline]) {
      const index = levelDiscipline(host, discipline);
      if (index < 0 || !host.progression) return reply("Nothing here has levels.");
      const to = Math.max(1, Math.min(1000, num(level, 1)));
      host.progression.debugLevel(entity, index, to);
      reply("{discipline} is now level {level}.", { discipline: host.progression.rules.disciplines[index].name, level: to });
    },
  });

  add({
    id: "xp",
    usage: "<amount> [discipline]",
    summary: "Adds experience to a discipline (your character's by default).",
    dev: true,
    args: [arg("amount", "number"), arg("discipline", "discipline", true)],
    run({ entity, host, reply }, [amount, discipline]) {
      const index = levelDiscipline(host, discipline);
      if (index < 0 || !host.progression) return reply("Nothing here has levels.");
      host.progression.debugXp(entity, index, num(amount));
      reply("Added {amount} XP to {discipline}.", { amount: num(amount), discipline: host.progression.rules.disciplines[index].name });
    },
  });

  add({
    id: "heal",
    usage: "",
    summary: "Fills every resource and brings you back if you are dead.",
    dev: true,
    args: [],
    run({ entity, host, reply }) {
      if (entity.combat?.dead) host.skills.revive(entity);
      if (entity.resources) for (let i = 0; i < host.rules.resources.length; i++) restore(entity.resources, i, 1e9);
      reply("You are restored.");
    },
  });

  add({
    id: "emote",
    usage: "<animation>",
    summary: "Plays an animation on you for everyone near: /emote wave. /wave, /bow, /sit and the rest are made of it.",
    aliases: ["e"],
    dev: false,
    args: [arg("animation", "word")],
    run({ entity, host }, [name]) {
      host.skills.animate(entity, String(name));
    },
  });

  add({
    id: "kill",
    usage: "",
    summary: "Kills your target, or you if nothing is targeted.",
    dev: true,
    args: [],
    run({ entity, host, reply }) {
      const id = entity.combat?.target ?? 0;
      const target = (id && host.dimension(entity)?.entities.get(id)) || entity;
      host.skills.kill(target);
      reply("{name} is dead.", { name: target.name });
    },
  });

  add({
    id: "revive",
    usage: "",
    summary: "Brings your target, or you, back to life.",
    dev: true,
    args: [],
    run({ entity, host, reply }) {
      const id = entity.combat?.target ?? 0;
      const target = (id && host.dimension(entity)?.entities.get(id)) || entity;
      host.skills.revive(target);
      reply("{name} is alive.", { name: target.name });
    },
  });

  add({
    id: "tp",
    aliases: ["goto"],
    usage: "<x> <z> | <zone or place>",
    summary: "Takes you to coordinates, a zone's middle or a named place.",
    dev: true,
    // The forms differ in kind, so it reads its own words (see `words`).
    args: [arg("where", "text", false, ["place", "zone"])],
    run({ entity, host, reply }, [where]) {
      const dimension = host.dimension(entity);
      if (!dimension) return reply("You are not in a world.");
      const words = String(where).split(/[\s,]+/).filter(Boolean);
      let x: number;
      let z: number;
      let label = "";
      if (words.length === 2 && words.every((w) => Number.isFinite(Number(w)))) {
        x = Number(words[0]);
        z = Number(words[1]);
        label = `${Math.round(x)}, ${Math.round(z)}`;
      } else {
        const typed = String(where);
        const flat = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");
        const candidates = [...placesOf(dimension), ...zonesOf(dimension)];
        const exact = candidates.filter((c) => flat(c.name) === flat(typed));
        const starts = exact.length ? exact : candidates.filter((c) => flat(c.name).startsWith(flat(typed)));
        if (starts.length === 0) return reply('There is no place or zone called "{name}".', { name: typed });
        if (new Set(starts.map((c) => c.name)).size > 1) return reply('More than one place fits "{name}": {names}.', { name: typed, names: [...new Set(starts.map((c) => c.name))].slice(0, 6).join(", ") });
        x = starts[0].x;
        z = starts[0].z;
        label = starts[0].name;
      }
      host.teleport(entity, x, z);
      reply("Taken to {where}.", { where: label });
    },
  });

  add({
    id: "spawn",
    usage: "<creature> [count] [level]",
    summary: "Makes creatures beside you.",
    dev: true,
    args: [arg("creature", "creature"), arg("count", "int", true), arg("level", "int", true)],
    run({ entity, host, reply }, [kind, count, level]) {
      const system = host.creatures;
      const dimension = host.dimension(entity);
      if (!system || !dimension) return reply("No creatures live here.");
      const n = Math.max(1, Math.min(20, num(count, 1)));
      let made = 0;
      for (let i = 0; i < n; i++) {
        const angle = entity.facing + (i - (n - 1) / 2) * 0.5;
        const x = entity.x + Math.sin(angle) * 5;
        const z = entity.z + Math.cos(angle) * 5;
        if (system.debug.spawn(dimension.id, String(kind), x, z, level === undefined ? undefined : num(level))) made++;
      }
      reply("Made {count} {kind}.", { count: made, kind: host.rules.templates.get(String(kind))?.name ?? String(kind) });
    },
  });

  add({
    id: "learn",
    usage: "<skill | all>",
    summary: "Teaches you a skill, or every skill you could ever learn.",
    dev: true,
    args: [arg("skill", "text", false, ["skill"], ["all"])],
    run({ entity, host, reply }, [skill]) {
      if (!host.progression) return reply("Nothing here can be learned.");
      if (String(skill).toLowerCase() === "all") {
        host.progression.learnAll(entity);
        return reply("You know everything you could.");
      }
      const typed = String(skill).toLowerCase().replace(/[\s_-]+/g, "");
      const flat = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");
      const exact = host.rules.skills.filter((s) => flat(s.id) === typed || flat(s.name) === typed);
      const found = exact.length ? exact : host.rules.skills.filter((s) => flat(s.id).startsWith(typed) || flat(s.name).startsWith(typed));
      if (found.length === 0) return reply('There is no skill called "{name}".', { name: String(skill) });
      if (found.length > 1) return reply('More than one skill fits "{name}": {names}.', { name: String(skill), names: found.slice(0, 6).map((s) => s.name).join(", ") });
      host.progression.debugLearn(entity, found[0].index);
      reply("You learn {skill}.", { skill: found[0].name });
    },
  });

  for (const def of packs) {
    const code = core.find((c) => c.id === def.id);
    if (code) {
      // How it reads is the pack's to say; what it does is the code's.
      if (def.usage !== undefined) code.usage = def.usage;
      if (def.summary !== undefined) code.summary = def.summary;
      if (def.aliases !== undefined) code.aliases = def.aliases;
      if (def.dev !== undefined) code.dev = def.dev;
      continue;
    }
    if (!def.run) throw new Error(`${def.file}: there is no command "${def.id}" in code, and no \`run\` to make one`);
    const lines = def.run;
    core.push({
      id: def.id,
      aliases: def.aliases,
      usage: def.usage ?? "",
      summary: def.summary ?? "",
      dev: def.dev ?? true,
      owner: "server",
      args: def.args ?? [],
      run(ctx, values) {
        for (const line of lines) ctx.exec(line.replace(/\$(\d)/g, (_, n: string) => (values[Number(n) - 1] === undefined ? "" : /\s/.test(String(values[Number(n) - 1])) ? `"${values[Number(n) - 1]}"` : String(values[Number(n) - 1]))));
      },
    });
  }
  for (const def of core) registry.add(def);
  return registry;
}
