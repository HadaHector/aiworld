import { formulaText } from "./formulaText";

/**
 * An item's `requires` formula read for a player (ITEMS.md, *Requirements*): one line for each thing
 * it asks - "Sword skill ≥ 10" - with whether the character has it. Pure of the game: the caller
 * says what each name is worth. The rule itself is still the formula the server runs.
 */
export interface RequirementLine {
  text: string;
  met: boolean;
}

type Value = (name: string) => number | undefined;

const COMPARE: Record<string, (a: number, b: number) => boolean> = {
  ge: (a, b) => a >= b,
  gt: (a, b) => a > b,
  le: (a, b) => a <= b,
  lt: (a, b) => a < b,
  eq: (a, b) => a === b,
};

/** A formula's value, or undefined where it reads a name nobody knows or an operation not handled here. */
function evaluate(node: unknown, value: Value): number | undefined {
  if (typeof node === "number") return node;
  if (typeof node === "string") return value(node);
  if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
  const [op] = Object.keys(node);
  const raw = (node as Record<string, unknown>)[op];
  const args = (Array.isArray(raw) ? raw : [raw]).map((a) => evaluate(a, value));
  if (args.some((a) => a === undefined)) return undefined;
  const n = args as number[];
  switch (op) {
    case "add":
      return n.reduce((a, b) => a + b, 0);
    case "sub":
      return n[0] - n[1];
    case "mul":
      return n.reduce((a, b) => a * b, 1);
    case "div":
      return n[1] === 0 ? 0 : n[0] / n[1];
    case "neg":
      return -n[0];
    case "min":
      return Math.min(...n);
    case "max":
      return Math.max(...n);
    case "and":
      return n.every((a) => a !== 0) ? 1 : 0;
    case "or":
      return n.some((a) => a !== 0) ? 1 : 0;
    case "not":
      return n[0] === 0 ? 1 : 0;
    default:
      return COMPARE[op] ? (COMPARE[op](n[0], n[1]) ? 1 : 0) : undefined;
  }
}

/** The tree with known names put in as numbers and sums of numbers added up: `itemLevel − 8` at item level 12 is 4. */
function fold(node: unknown, known: Readonly<Record<string, number>>): unknown {
  if (typeof node === "string") return node in known ? known[node] : node;
  if (typeof node !== "object" || node === null || Array.isArray(node)) return node;
  const [op] = Object.keys(node);
  const raw = (node as Record<string, unknown>)[op];
  const args = (Array.isArray(raw) ? raw : [raw]).map((a) => fold(a, known));
  const folded = { [op]: Array.isArray(raw) ? args : args[0] };
  if (args.every((a) => typeof a === "number")) {
    const v = evaluate(folded, () => undefined);
    if (v !== undefined) return v;
  }
  return folded;
}

/** The parts a requirement asks all of: the clauses of its top-level `and`s. */
function clauses(node: unknown): unknown[] {
  if (typeof node === "object" && node !== null && !Array.isArray(node) && "and" in node && Array.isArray((node as { and: unknown }).and)) return (node as { and: unknown[] }).and.flatMap(clauses);
  return [node];
}

/**
 * The lines of a requirement, for an item with these `known` values (its `itemLevel`), against what the
 * character has (`value`). A clause anyone meets - level at least 0 - is left out; one that cannot be
 * worked out is shown as met rather than blaming the player for it.
 */
export function requirementLines(source: unknown, known: Readonly<Record<string, number>>, value: Value, names: Readonly<Record<string, string>> = {}): RequirementLine[] {
  const lines: RequirementLine[] = [];
  for (const clause of clauses(fold(source, known))) {
    if (evaluate(clause, () => 0) === 1 && typeof clause === "object") continue;
    const met = evaluate(clause, value);
    lines.push({ text: formulaText(clause, names), met: met === undefined || met !== 0 });
  }
  return lines;
}
