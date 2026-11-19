/**
 * The chat commands the client owns (CHAT.md): those whose effect is the window's or the world view's
 * - /help, /clear, and the developer's /time, /weather and /reveal - and the router that sends
 * everything else to the server. The same parser as the server's (sim/chat/chat.ts) reads them.
 */
import { complete, createRegistry, parseArgs, splitWords, type ArgValue, type CommandDef, type NameBook } from "../sim/chat/chat";
import type { Text, TextArgs } from "../sim/text";

export interface ClientCommand extends CommandDef {
  owner: "client";
  run: (values: ArgValue[]) => void;
}

/** What the client's commands act on. */
export interface ChatCommandHost {
  /** A line of the window's, as a template (translated by the caller). */
  system: (text: string, args?: TextArgs) => void;
  /** Words as written, no translation (the echo of what was typed). */
  plain: (line: string) => void;
  clear: () => void;
  send: (channel: string, text: string) => void;
  /** Whether the server allows developer commands (it listed some). */
  devCommands: () => boolean;
  /** Commands the server runs, as it listed them. */
  serverCommands: () => readonly CommandDef[];
  names: NameBook["names"];
  setTime: (hour: number) => boolean;
  /** Holds every zone at one weather, or lets go (null); false when there is no such weather. */
  setWeather: (id: string | null) => boolean;
  /** Forgets the map's kept tiles so they are drawn again. */
  clearMapTiles: () => Promise<void>;
  /** Translates a template of the packs' (usage and summary lines). */
  translate: (text: string) => string;
}

const dev = { dev: true, owner: "client" as const };

export function createChatCommands(host: ChatCommandHost): {
  submit: (line: string) => void;
  complete: (line: string) => string[];
  all: () => CommandDef[];
} {
  const registry = createRegistry<ClientCommand>();
  const add = (def: Omit<ClientCommand, "owner" | "dev"> & { dev?: boolean }): void => registry.add({ owner: "client", ...def, dev: def.dev ?? false });
  const available = (): CommandDef[] => [...host.serverCommands(), ...registry.all().filter((c) => !c.dev || host.devCommands())].sort((a, b) => a.id.localeCompare(b.id));

  add({
    id: "help",
    aliases: ["?", "commands"],
    usage: "[command]",
    summary: "Lists the commands, or tells how to use one.",
    args: [{ name: "command", kind: "word", optional: true }],
    run([which]) {
      const list = available();
      if (which !== undefined) {
        const name = String(which).replace(/^\//, "").toLowerCase();
        const def = list.find((c) => c.id === name || c.aliases?.includes(name));
        if (!def) return host.system('There is no command called "{name}".', { name });
        host.system("/{name}{usage}", { name: def.id, usage: def.usage ? ` ${host.translate(def.usage)}` : "" });
        host.system("{summary}", { summary: host.translate(def.summary) });
        if (def.aliases?.length) host.system("Also: {aliases}.", { aliases: def.aliases.map((a) => `/${a}`).join(", ") });
        return;
      }
      host.system("Commands (type /help <command> for more; Tab completes):");
      for (const def of list) host.system("/{name}{usage} - {summary}", { name: def.id, usage: def.usage ? ` ${host.translate(def.usage)}` : "", summary: host.translate(def.summary) });
    },
  });
  add({ id: "clear", usage: "", summary: "Empties the chat window.", args: [], run: () => host.clear() });
  add({
    id: "clearmap",
    usage: "",
    summary: "Forgets the map's kept tiles, so the minimap and world map are drawn again.",
    args: [],
    run: () => void host.clearMapTiles().then(() => host.system("The map's tiles are cleared; they are being drawn again.")),
  });
  add({
    id: "time",
    usage: "<hour 0-24>",
    summary: "Sets the time of day.",
    ...dev,
    args: [{ name: "hour", kind: "number" }],
    run([hour]) {
      const h = Number(hour);
      if (h < 0 || h > 24) return host.system("The hour must be between 0 and 24.");
      host.setTime(h);
      host.system("It is now {hour}:00.", { hour: Math.floor(h) });
    },
  });
  add({
    id: "weather",
    usage: "<weather | off>",
    summary: "Holds the weather everywhere, or lets it go its own way (off).",
    ...dev,
    args: [{ name: "weather", kind: "weather" }],
    run([id]) {
      if (String(id).toLowerCase() === "off") {
        host.setWeather(null);
        return host.system("The weather goes its own way.");
      }
      const found = host.names("weather").find((w) => w.id.toLowerCase() === String(id).toLowerCase() || w.name.toLowerCase() === String(id).toLowerCase());
      if (!found || !host.setWeather(found.id)) return host.system('There is no weather called "{name}". Try: {names}.', { name: String(id), names: host.names("weather").map((w) => w.id).join(", ") });
      host.system("The weather is held at {weather}.", { weather: found.name });
    },
  });
  add({
    id: "reveal",
    usage: "",
    summary: "Uncovers the whole map.",
    ...dev,
    args: [],
    run: () => host.system("The map has no fog to lift."),
  });

  const book: NameBook = {
    names(kind) {
      if (kind === "weather") return host.names("weather");
      return host.names(kind);
    },
  };

  return {
    all: available,
    complete: (line) => (line.startsWith("/") ? complete(line, available(), book) : []),
    submit(line) {
      if (!line.startsWith("/")) return host.send("say", line);
      const words = splitWords(line.slice(1));
      const name = (words[0] ?? "").toLowerCase();
      if (!name) return;
      host.plain(line);
      const def = registry.find(name);
      if (!def) return host.send("command", line.slice(1));
      if (def.dev && !host.devCommands()) return host.system("Developer commands are off on this server.");
      const parsed = parseArgs(def, words.slice(1), book);
      if (!parsed.ok) {
        host.system(parsed.reason.text, parsed.reason.args);
        return host.system("Usage: /{name} {usage}", { name: def.id, usage: def.usage });
      }
      def.run(parsed.values);
    },
  };
}

export type { Text };
