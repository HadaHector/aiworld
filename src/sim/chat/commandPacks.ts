/**
 * Commands in the packs (CHAT.md, *Commands*): `commands/<id>.json5` says how a command reads - its
 * usage, summary, aliases, whether it is a developer's - over what code registered under that id; or,
 * with `run`, makes a command of its own from others: each line is a command line, `$1`.. filled
 * from the arguments. A pack alone can only compose the commands that exist; a mod adds code.
 *
 *   { usage: "<item> [count]", summary: "Puts an item in your bag.", aliases: ["item"], dev: true }
 *   { summary: "Heals and gives a kit.", dev: true, args: [{ name: "item", kind: "item" }], run: ["heal", "give $1"] }
 */
import { Reader, type ContentIssue } from "../../world/content/contentReader";
import type { ArgKind, ArgSpec } from "./chat";

export interface CommandPackDef {
  id: string;
  file: string;
  usage?: string;
  summary?: string;
  aliases?: string[];
  dev?: boolean;
  args?: ArgSpec[];
  /** Command lines to run, for a command made in a pack. */
  run?: string[];
}

const KINDS: readonly ArgKind[] = ["int", "number", "word", "text", "item", "skill", "creature", "zone", "place", "discipline", "weather"];

export function readCommandPacks(entries: readonly { id: string; file: string; data: unknown }[], issues: ContentIssue[]): CommandPackDef[] {
  return entries.map((entry) => {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["usage", "summary", "aliases", "dev", "args", "run"]);
    return {
      id: entry.id,
      file: entry.file,
      usage: reader.optionalString(obj, "usage", "") ?? undefined,
      summary: reader.optionalString(obj, "summary", "") ?? undefined,
      aliases: obj.aliases === undefined ? undefined : reader.stringList(obj, "aliases", ""),
      dev: obj.dev === undefined ? undefined : reader.boolean(obj, "dev", "", false),
      args: obj.args === undefined
        ? undefined
        : reader.array(obj, "args", "").map((value, i) => {
            const path = `args[${i}]`;
            const raw = reader.object(value, path);
            reader.onlyKeys(raw, path, ["name", "kind", "optional"]);
            return { name: reader.string(raw, "name", path), kind: reader.oneOf(raw, "kind", path, KINDS), optional: reader.boolean(raw, "optional", path, false) };
          }),
      run: obj.run === undefined ? undefined : reader.stringList(obj, "run", ""),
    };
  });
}
