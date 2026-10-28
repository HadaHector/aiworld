/**
 * A formula tree (ENTITIES.md, *Formulas*) as text a player can read - `45 + 5 × victim level` -
 * for the rule book and tooltips (PROGRESSION.md). Pure: it reads the tree as written, so it works
 * for any formula in any pack. `names` may rename a name (`own` → "level"); otherwise dots and
 * camel case become spaces.
 */
export function formulaText(tree: unknown, names: Readonly<Record<string, string>> = {}): string {
  return text(tree, names, 0);
}

/** Binding strength: a part binding more loosely than where it sits is put in brackets. */
const PRECEDENCE: Record<string, number> = { if: 1, or: 2, and: 3, not: 4, gt: 5, lt: 5, ge: 5, le: 5, eq: 5, add: 6, sub: 6, mul: 7, div: 7, neg: 8, pow: 9 };
const COMPARE: Record<string, string> = { gt: ">", lt: "<", ge: "≥", le: "≤", eq: "=" };

export function nameText(name: string, names: Readonly<Record<string, string>> = {}): string {
  if (names[name] !== undefined) return names[name];
  return name
    .replace(/^var\./, "")
    .replace(/^disc\./, "")
    .replace(/\./g, " ")
    .replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)
    .replace(/\bxp\b/g, "XP");
}

function numberText(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

function text(node: unknown, names: Readonly<Record<string, string>>, outer: number): string {
  if (typeof node === "number") return node < 0 && outer > 0 ? `(${numberText(node)})` : numberText(node);
  if (typeof node === "string") return nameText(node, names);
  if (typeof node !== "object" || node === null || Array.isArray(node)) return "?";
  const [op] = Object.keys(node);
  const raw = (node as Record<string, unknown>)[op];
  const args = Array.isArray(raw) ? raw : [raw];
  const p = PRECEDENCE[op] ?? 10;
  const sub = (i: number, at = p) => text(args[i], names, at);
  let out: string;
  switch (op) {
    case "add":
      out = args.map((a, i) => (i > 0 && typeof a === "object" && a !== null && "neg" in a ? `− ${text((a as { neg: unknown }).neg, names, p + 1)}` : (i > 0 ? "+ " : "") + text(a, names, p))).join(" ");
      break;
    case "sub":
      out = `${sub(0)} − ${sub(1, p + 1)}`;
      break;
    case "mul":
      out = args.map((_, i) => sub(i)).join(" × ");
      break;
    case "div":
      out = `${sub(0)} / ${sub(1, p + 1)}`;
      break;
    case "pow":
      out = `${sub(0, p + 1)}^${sub(1, p + 1)}`;
      break;
    case "neg":
      out = `−${sub(0, p + 1)}`;
      break;
    case "min":
      return `the lower of ${args.map((_, i) => sub(i, 0)).join(", ")}`;
    case "max":
      return `the higher of ${args.map((_, i) => sub(i, 0)).join(", ")}`;
    case "clamp":
      return `${sub(0, 0)}, kept between ${sub(1, 0)} and ${sub(2, 0)}`;
    case "if":
      out = `if ${sub(0, p + 1)} then ${sub(1, p + 1)}, else ${sub(2, p)}`;
      break;
    case "and":
      out = args.map((_, i) => sub(i)).join(" and ");
      break;
    case "or":
      out = args.map((_, i) => sub(i)).join(" or ");
      break;
    case "not":
      out = `not ${sub(0, p + 1)}`;
      break;
    case "abs":
      return `|${sub(0, 0)}|`;
    case "sqrt":
      return `√(${sub(0, 0)})`;
    case "floor":
    case "ceil":
    case "round": {
      const inner = sub(0, 0);
      const how = op === "floor" ? "rounded down" : op === "ceil" ? "rounded up" : "rounded";
      return inner.includes(" ") ? `(${inner}) ${how}` : `${inner} ${how}`;
    }
    default:
      if (COMPARE[op]) {
        out = `${sub(0, p + 1)} ${COMPARE[op]} ${sub(1, p + 1)}`;
        break;
      }
      return "?";
  }
  return p < outer ? `(${out})` : out;
}
