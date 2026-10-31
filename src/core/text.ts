/**
 * Translatable text (QUESTS.md, *Text*). Every sentence the game makes up - a bark, a quest's offer -
 * is a template written in the packs in English, sent as the template and its arguments, and turned
 * into words by the reader's client: translated (a language's `text/*.json5` maps the English to its
 * own, as gettext does), then filled in. Nothing is ever put together from pieces in code.
 *
 * A template's `{name}` is an argument. `{count, plural, one {# wolf} other {# wolves}}` picks by a
 * number (`#` is the number), and `{sex, select, male {he} female {she} other {they}}` by a word;
 * either may hold arguments of its own.
 */
export type TextArgs = Readonly<Record<string, string | number>>;

/** A template and its arguments: what is stored and sent instead of finished words. */
export interface Text {
  text: string;
  args: TextArgs;
}

/** The languages' translations, by language, from English to that language. */
export type TextTable = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** Reads `text/*.json5` files - `{ language: "hu", strings: { "Good day to you.": "Jó napot!" } }` -
 *  into a table, later packs' strings over earlier ones'. */
export function readTextTable(files: readonly { file: string; data: unknown }[], fail: (file: string, message: string) => void): TextTable {
  const table = new Map<string, Map<string, string>>();
  for (const { file, data } of files) {
    const obj = data as { language?: unknown; strings?: unknown };
    if (!obj || typeof obj.language !== "string" || !obj.strings || typeof obj.strings !== "object") {
      fail(file, "expected { language, strings: { english: translation } }");
      continue;
    }
    const strings = table.get(obj.language) ?? new Map<string, string>();
    for (const [from, to] of Object.entries(obj.strings)) if (typeof to === "string") strings.set(from, to);
    table.set(obj.language, strings);
  }
  return table;
}

/** English's plural categories; a language's rules join here as more come. */
const PLURALS: Record<string, (n: number) => string> = {
  en: (n) => (n === 1 ? "one" : "other"),
};

/** The text a `{` at `start` opens runs to its matching `}`: where that is. */
function closing(template: string, start: number): number {
  let depth = 0;
  for (let i = start; i < template.length; i++) {
    if (template[i] === "{") depth++;
    else if (template[i] === "}" && --depth === 0) return i;
  }
  return template.length;
}

/** `one {...} other {...}`: the cases of a plural or a select, by their names. */
function cases(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf("{", i);
    if (open < 0) break;
    const name = body.slice(i, open).trim();
    const end = closing(body, open);
    out.set(name, body.slice(open + 1, end));
    i = end + 1;
  }
  return out;
}

/** Fills a template's arguments in, with plurals and selects. An argument it does not have stays as written. */
export function fillText(template: string, args: TextArgs, language = "en"): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open < 0) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const end = closing(template, open);
    const inside = template.slice(open + 1, end);
    const [name, kind, ...rest] = inside.split(",");
    const key = name.trim();
    const value = args[key];
    if (kind === undefined) out += value === undefined ? `{${inside}}` : String(value);
    else {
      const body = cases(rest.join(","));
      const pickName = kind.trim() === "plural" ? (PLURALS[language] ?? PLURALS.en)(Number(value)) : String(value);
      const exact = kind.trim() === "plural" ? body.get(`=${Number(value)}`) : undefined;
      const chosen = exact ?? body.get(pickName) ?? body.get("other") ?? "";
      out += fillText(chosen.replace(/#/g, String(value)), args, language);
    }
    i = end + 1;
  }
  return out;
}

/** A template in a language: its translation where the table has one, filled in. */
export function renderText(text: Text, table: TextTable | null = null, language = "en"): string {
  const translated = table?.get(language)?.get(text.text) ?? text.text;
  return fillText(translated, text.args, language);
}
