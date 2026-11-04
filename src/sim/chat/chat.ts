/**
 * Chat and commands (CHAT.md): the pure parts - cleaning typed text, splitting a command line into
 * words, reading arguments against a command's declared kinds, the registry, and a rate limit. No
 * server, no browser: the server runs commands with these, and the client uses the same parser to
 * complete and to run the commands it owns.
 */
import type { Text } from "../text";

/** Longest line a player may send, after cleaning. */
export const CHAT_MAX_LENGTH = 256;
/** Channels the server knows today; party, whisper and guild join when they have recipients. */
export const CHANNELS = ["say", "system"] as const;
export type Channel = (typeof CHANNELS)[number];
/** How many messages a player may send in a window of seconds. */
export const CHAT_RATE = { messages: 5, seconds: 3 } as const;

const CONTROL = new RegExp("["+String.fromCharCode(0)+"-"+String.fromCharCode(31)+String.fromCharCode(127)+"-"+String.fromCharCode(159)+String.fromCharCode(8232)+String.fromCharCode(8233)+"]", "g");

/** Typed text made safe to relay: control characters and newlines dropped, spaces collapsed, cut to length. */
export function cleanChat(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // (CONTROL: C0 and C1 control characters and the line and paragraph separators)
  return raw.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, CHAT_MAX_LENGTH);
}

/** A line split into words, with "quoted words" kept whole; the quotes themselves are dropped. */
export function splitWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let any = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (ch === " ") {
      if (word || any) words.push(word);
      word = "";
      any = false;
    } else word += ch;
  }
  if (word || any) words.push(word);
  return words;
}

/** What one argument is, which decides how it is read and what completes it. */
export type ArgKind = "int" | "number" | "word" | "text" | "item" | "skill" | "creature" | "zone" | "place" | "discipline" | "weather";

export interface ArgSpec {
  name: string;
  kind: ArgKind;
  optional?: boolean;
  /** For a "text" argument: the kinds of name it completes, and words besides ("all"). */
  names?: ArgKind[];
  extra?: string[];
}

/** A command, as every side sees it. `usage` and `summary` are templates (QUESTS.md, *Text*). */
export interface CommandDef {
  id: string;
  aliases?: string[];
  /** The arguments after the name, e.g. "<item> [count]" - spelled by `args`, this is the readable form. */
  usage: string;
  summary: string;
  /** Needs the server's `devCommands` to be on. */
  dev: boolean;
  /** Who runs it: the server (the effect is its) or the client (the window's, or the world view's). */
  owner: "server" | "client";
  args: ArgSpec[];
}

/** The command registry's lookup: id or alias, case-insensitive. */
export function createRegistry<T extends CommandDef>(): {
  add: (def: T) => void;
  find: (name: string) => T | undefined;
  all: () => T[];
} {
  const byName = new Map<string, T>();
  const list: T[] = [];
  return {
    add(def) {
      for (const name of [def.id, ...(def.aliases ?? [])]) {
        if (byName.has(name.toLowerCase())) throw new Error(`Chat command "${name}" is registered twice`);
        byName.set(name.toLowerCase(), def);
      }
      list.push(def);
    },
    find: (name) => byName.get(name.toLowerCase()),
    all: () => list,
  };
}

/** What names a kind of argument may be: id, display name, and the lists they come from. */
export interface NameBook {
  /** Candidates of one kind: an id and a display name each. */
  names: (kind: ArgKind) => readonly { id: string; name: string }[];
}

/** A named thing found by id, by name, or by the one name that starts with what was typed. */
export function findNamed(list: readonly { id: string; name: string }[], typed: string): { id: string; name: string } | "none" | "many" {
  const t = typed.toLowerCase().replace(/[\s_-]+/g, "");
  const flat = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");
  const exact = list.filter((c) => flat(c.id) === t || flat(c.name) === t);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return "many";
  const starts = list.filter((c) => flat(c.id).startsWith(t) || flat(c.name).startsWith(t));
  if (starts.length === 1) return starts[0];
  return starts.length > 1 ? "many" : "none";
}

/** A parsed argument: the typed word's meaning. */
export type ArgValue = number | string;

export type ParseResult = { ok: true; values: ArgValue[] } | { ok: false; reason: Text };

const bad = (text: string, args: Record<string, string | number> = {}): { ok: false; reason: Text } => ({ ok: false, reason: { text, args } });

/** Reads the words after a command's name against its arguments. */
export function parseArgs(def: CommandDef, words: readonly string[], book: NameBook): ParseResult {
  const values: ArgValue[] = [];
  for (let i = 0; i < def.args.length; i++) {
    const spec = def.args[i];
    const word = spec.kind === "text" ? words.slice(i).join(" ") : words[i];
    if (word === undefined || word === "") {
      if (spec.optional) continue;
      return bad("Missing {name}.", { name: spec.name });
    }
    switch (spec.kind) {
      case "int":
      case "number": {
        const n = Number(word);
        if (!Number.isFinite(n) || (spec.kind === "int" && !Number.isInteger(n))) return bad("{name} must be {kind}, not \"{word}\".", { name: spec.name, kind: spec.kind === "int" ? "a whole number" : "a number", word });
        values.push(n);
        break;
      }
      case "word":
      case "text":
        values.push(word);
        break;
      default: {
        const found = findNamed(book.names(spec.kind), word);
        if (found === "none") return bad("There is no {kind} called \"{word}\".", { kind: spec.kind, word });
        if (found === "many") return bad("More than one {kind} fits \"{word}\".", { kind: spec.kind, word });
        values.push(found.id);
      }
    }
  }
  return { ok: true, values };
}

/** Candidate completions for the last word of a line: command names, or an argument's names. */
export function complete(line: string, commands: readonly CommandDef[], book: NameBook): string[] {
  const body = line.startsWith("/") ? line.slice(1) : line;
  const words = splitWords(body);
  const endsInSpace = /\s$/.test(body);
  if (words.length === 0 || (words.length === 1 && !endsInSpace)) {
    const typed = (words[0] ?? "").toLowerCase();
    return commands.flatMap((c) => [c.id, ...(c.aliases ?? [])]).filter((n) => n.startsWith(typed)).sort();
  }
  const def = commands.find((c) => c.id === words[0].toLowerCase() || c.aliases?.includes(words[0].toLowerCase()));
  if (!def) return [];
  const index = endsInSpace ? words.length - 1 : words.length - 2;
  const spec = def.args[index];
  if (!spec) return [];
  const typed = (endsInSpace ? "" : words[words.length - 1]).toLowerCase().replace(/[\s_-]+/g, "");
  const flat = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");
  if (spec.kind === "text" && spec.names) {
    const from = [...spec.names.flatMap((k) => book.names(k).map((c) => c.id)), ...(spec.extra ?? [])];
    return [...new Set(from)].filter((id) => flat(id).startsWith(typed)).sort();
  }
  if (["int", "number", "word", "text"].includes(spec.kind)) return [];
  return book.names(spec.kind).filter((c) => flat(c.id).startsWith(typed) || flat(c.name).startsWith(typed)).map((c) => c.id).sort();
}

/** A sliding-window rate limit, one per sender. */
export function createRateLimit(): (now: number) => boolean {
  const times: number[] = [];
  return (now) => {
    while (times.length > 0 && now - times[0] > CHAT_RATE.seconds) times.shift();
    if (times.length >= CHAT_RATE.messages) return false;
    times.push(now);
    return true;
  };
}
