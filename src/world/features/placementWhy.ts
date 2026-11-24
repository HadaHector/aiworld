/**
 * Why a cell holds what it holds (FEATURES.md, *Why a cell is empty*): a plain record kept next to
 * the features, filled in by the placement code as it goes - no terrain is sampled for it, it only
 * writes down what each condition measured on the candidates the placement already tried.
 *
 * A placement tests its conditions in a fixed order on each candidate point and stops at the first
 * that fails, so a check's `failed` counts candidates stopped THERE (the first failing condition),
 * and `reached` those that got that far. `value` is the measured value of the candidate that came
 * closest to passing it (the smallest miss outside [lo, hi]) among those that failed it, or of any
 * that passed it when none failed.
 */

/** What a placement tests its conditions through. */
export interface Trace {
  /** Whether `value` is within [lo, hi] (either may be infinite); records it. */
  test(name: string, value: number, lo: number, hi: number): boolean;
}

/** The trace of a placement nobody is watching. */
export const NO_TRACE: Trace = { test: (_name, value, lo, hi) => value >= lo && value <= hi };

/** One condition of a kind's site, over the candidates tried for a cell. */
export interface CheckRecord {
  name: string;
  /** Candidates that got as far as this condition. */
  reached: number;
  /** Of them, those it stopped. */
  failed: number;
  /** The measured value of the candidate nearest to passing, and the range it had to be in. */
  value: number;
  lo: number;
  hi: number;
}

/** One land cell's roll and what came of it - a plain record, safe to copy or serialise. */
export interface CellPlacement {
  cell: number;
  /** The kind rolled (its id), or "none" - the roll came up empty, or the biome lists nothing. */
  rolled: string;
  /** Candidate points tried (a roadside kind is tried along the roads instead). */
  candidates: number;
  placed: boolean;
  /** What else happened to it: no road could reach it, no road through the cell, and so on. */
  note: string;
  checks: CheckRecord[];
}

const miss = (value: number, lo: number, hi: number): number => (value < lo ? lo - value : value > hi ? value - hi : 0);

/** A cell's trace: collects what each condition measured. */
export class CellTrace implements Trace {
  candidates = 0;
  placed = false;
  note = "";
  private readonly checks = new Map<string, CheckRecord>();

  readonly cell: number;
  readonly rolled: string;

  constructor(cell: number, rolled: string) {
    this.cell = cell;
    this.rolled = rolled;
  }

  /** A new candidate point is being tried. */
  begin(): void {
    this.candidates++;
  }

  test(name: string, value: number, lo: number, hi: number): boolean {
    let check = this.checks.get(name);
    if (!check) {
      check = { name, reached: 0, failed: 0, value, lo, hi };
      this.checks.set(name, check);
    }
    check.reached++;
    const ok = value >= lo && value <= hi;
    if (!ok) {
      // The candidate nearest to passing is the one worth quoting (before any failure, the first passer's value stands).
      if (check.failed === 0 || miss(value, lo, hi) < miss(check.value, check.lo, check.hi)) {
        check.value = value;
        check.lo = lo;
        check.hi = hi;
      }
      check.failed++;
    } else if (check.failed === 0) {
      check.value = value;
      check.lo = lo;
      check.hi = hi;
    }
    return ok;
  }

  record(): CellPlacement {
    return { cell: this.cell, rolled: this.rolled, candidates: this.candidates, placed: this.placed, note: this.note, checks: [...this.checks.values()] };
  }
}

const number = (v: number): string => (!Number.isFinite(v) ? (v > 0 ? "inf" : "-inf") : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

/** A check as text: `cover 0.31 < 0.5`, `grade 0.9 > 0.4`, or `grade 0.2 in 0.1..0.4` for one that passed. */
export function describeCheck(check: CheckRecord): string {
  const { value, lo, hi } = check;
  if (value < lo) return `${check.name} ${number(value)} < ${number(lo)}`;
  if (value > hi) return `${check.name} ${number(value)} > ${number(hi)}`;
  return `${check.name} ${number(value)} in ${number(lo)}..${number(hi)}`;
}

/** The condition that stopped the most candidates - the main reason a cell is empty - or null. */
export function mainReason(placement: CellPlacement): CheckRecord | null {
  let best: CheckRecord | null = null;
  for (const check of placement.checks) if (check.failed > 0 && (!best || check.failed > best.failed)) best = check;
  return best;
}
