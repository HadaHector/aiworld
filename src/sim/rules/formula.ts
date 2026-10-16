import { isObject, joinPath, describe, type Reader } from "../../world/content/contentReader";

/**
 * A formula from a pack file, compiled: reads its names' values out of an array by index. What a
 * stat's `formula`, a modifier kind's `apply` and a resource's rates are (see ENTITIES.md, *Formulas*).
 */
export type Formula = (values: ArrayLike<number>) => number;

/** A formula as compiled, with the indices of the names it reads - what a stat depends on. */
export interface CompiledFormula {
  run: Formula;
  reads: number[];
  /** Whether it is a plain number, and which: lets a caller skip running it. */
  constant: number | null;
}

/** How many arguments an operation takes: a fixed number, or at least one. */
const OPERATIONS: Record<string, number | "many"> = {
  add: "many",
  mul: "many",
  min: "many",
  max: "many",
  and: "many",
  or: "many",
  sub: 2,
  div: 2,
  pow: 2,
  gt: 2,
  lt: 2,
  ge: 2,
  le: 2,
  eq: 2,
  clamp: 3,
  if: 3,
  neg: 1,
  abs: 1,
  sqrt: 1,
  floor: 1,
  ceil: 1,
  round: 1,
  not: 1,
};

/** The largest whole power `pow` takes, either way. */
const MAX_POWER = 16;

const finite = (x: number): number => (Number.isFinite(x) ? x : 0);

/** a to a whole power by repeated multiplication - bit for bit the same in every engine, which
 *  `Math.pow` is not required to be. */
function power(a: number, n: number): number {
  let result = 1;
  for (let i = 0; i < Math.abs(n); i++) result *= a;
  return n < 0 ? (result === 0 ? 0 : 1 / result) : result;
}

/**
 * Reads and compiles a formula tree: a number, a name (looked up in `names`, which gives its index),
 * or an object with one key - an operation - over a list of formulas (or one formula, for the
 * one-argument operations). Every problem is reported on the reader at its path; a broken formula
 * compiles to 0 so reading carries on.
 */
export function compileFormula(value: unknown, path: string, reader: Reader, names: ReadonlyMap<string, number>): CompiledFormula {
  const reads = new Set<number>();
  const zero: Formula = () => 0;

  function build(node: unknown, at: string): Formula {
    if (typeof node === "number") {
      if (!Number.isFinite(node)) reader.fail(at, "expected a finite number");
      const n = finite(node);
      return () => n;
    }
    if (typeof node === "string") {
      const index = names.get(node);
      if (index === undefined) {
        reader.fail(at, `no "${node}" here (known: ${[...names.keys()].join(", ") || "none"})`);
        return zero;
      }
      reads.add(index);
      return (v) => v[index];
    }
    if (!isObject(node)) {
      reader.fail(at, `expected a number, a name or an operation, got ${describe(node)}`);
      return zero;
    }
    const keys = Object.keys(node);
    if (keys.length !== 1) {
      reader.fail(at, `an operation is an object with exactly one key, got ${keys.length ? keys.join(", ") : "none"}`);
      return zero;
    }
    const op = keys[0];
    const arity = OPERATIONS[op];
    const opAt = joinPath(at, op);
    if (arity === undefined) {
      reader.fail(at, `unknown operation "${op}" (known: ${Object.keys(OPERATIONS).join(", ")})`);
      return zero;
    }
    const raw = node[op];
    let args: Formula[];
    if (arity === 1) {
      args = [build(raw, opAt)];
    } else {
      if (!Array.isArray(raw)) {
        reader.fail(opAt, `expected a list of ${arity === "many" ? "one or more" : arity} formulas`);
        return zero;
      }
      if (arity === "many" ? raw.length < 1 : raw.length !== arity) {
        reader.fail(opAt, `expected ${arity === "many" ? "one or more" : arity} formulas, got ${raw.length}`);
        return zero;
      }
      args = raw.map((arg, i) => build(arg, joinPath(opAt, i)));
    }
    const [a, b, c] = args;
    switch (op) {
      case "add":
        return (v) => {
          let sum = 0;
          for (const f of args) sum += f(v);
          return sum;
        };
      case "mul":
        return (v) => {
          let product = 1;
          for (const f of args) product *= f(v);
          return product;
        };
      case "min":
        return (v) => args.reduce((m, f) => Math.min(m, f(v)), Infinity);
      case "max":
        return (v) => args.reduce((m, f) => Math.max(m, f(v)), -Infinity);
      case "and":
        return (v) => (args.every((f) => f(v) !== 0) ? 1 : 0);
      case "or":
        return (v) => (args.some((f) => f(v) !== 0) ? 1 : 0);
      case "sub":
        return (v) => a(v) - b(v);
      case "div":
        return (v) => {
          const d = b(v);
          return d === 0 ? 0 : a(v) / d;
        };
      case "pow": {
        const exponent = (raw as unknown[])[1];
        if (typeof exponent !== "number" || !Number.isInteger(exponent) || Math.abs(exponent) > MAX_POWER) {
          reader.fail(joinPath(opAt, 1), `the power must be a whole number from -${MAX_POWER} to ${MAX_POWER}, written as a number`);
          return zero;
        }
        return (v) => power(a(v), exponent);
      }
      case "gt":
        return (v) => (a(v) > b(v) ? 1 : 0);
      case "lt":
        return (v) => (a(v) < b(v) ? 1 : 0);
      case "ge":
        return (v) => (a(v) >= b(v) ? 1 : 0);
      case "le":
        return (v) => (a(v) <= b(v) ? 1 : 0);
      case "eq":
        return (v) => (a(v) === b(v) ? 1 : 0);
      case "clamp":
        return (v) => Math.min(Math.max(a(v), b(v)), c(v));
      case "if":
        return (v) => (a(v) !== 0 ? b(v) : c(v));
      case "neg":
        return (v) => -a(v);
      case "abs":
        return (v) => Math.abs(a(v));
      case "sqrt":
        return (v) => {
          const x = a(v);
          return x > 0 ? Math.sqrt(x) : 0;
        };
      case "floor":
        return (v) => Math.floor(a(v));
      case "ceil":
        return (v) => Math.ceil(a(v));
      case "round":
        return (v) => Math.round(a(v));
      case "not":
        return (v) => (a(v) === 0 ? 1 : 0);
    }
    return zero;
  }

  const inner = build(value, path);
  return {
    run: (values) => finite(inner(values)),
    reads: [...reads].sort((x, y) => x - y),
    constant: typeof value === "number" && Number.isFinite(value) ? value : null,
  };
}
