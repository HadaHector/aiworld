/**
 * The control flags (see ABILITIES.md, *States on a unit*): what changes how the engine drives a
 * unit. Unlike tags, these are known to the engine by name, because the motor, the casting checks
 * and auto-attack obey them. Each has an immunity, `immune.<flag>`, that keeps it from being set.
 */
export const CONTROL_FLAGS = ["stunned", "rooted", "silenced", "pacified", "disarmed", "immune", "stealthed", "dead"] as const;
export type ControlFlag = (typeof CONTROL_FLAGS)[number];

/** Every flag a `flag` action can set: the control flags, then their immunities, by bit. */
export const FLAG_NAMES: readonly string[] = [...CONTROL_FLAGS, ...CONTROL_FLAGS.map((f) => `immune.${f}`)];
export const FLAG_INDEX: ReadonlyMap<string, number> = new Map(FLAG_NAMES.map((name, i) => [name, i]));

export const FLAG = Object.fromEntries(CONTROL_FLAGS.map((f, i) => [f, i])) as Record<ControlFlag, number>;
/** The bit of a flag's immunity. */
export const immunityOf = (flag: number): number => flag + CONTROL_FLAGS.length;

/** Counts per flag on one entity, so overlapping sources each hold their own. */
export interface FlagBlock {
  counts: Uint16Array;
  /** One bit per flag held: what is replicated. */
  bits: number;
}

export function createFlagBlock(): FlagBlock {
  return { counts: new Uint16Array(FLAG_NAMES.length), bits: 0 };
}

export const hasFlag = (block: FlagBlock | undefined, flag: number): boolean => block !== undefined && (block.bits & (1 << flag)) !== 0;

/** Raises a flag's count. False, and nothing changes, when the unit is immune to it. */
export function raiseFlag(block: FlagBlock, flag: number): boolean {
  if (flag < CONTROL_FLAGS.length && hasFlag(block, immunityOf(flag))) return false;
  block.counts[flag]++;
  block.bits |= 1 << flag;
  return true;
}

export function lowerFlag(block: FlagBlock, flag: number): void {
  if (block.counts[flag] === 0) return;
  if (--block.counts[flag] === 0) block.bits &= ~(1 << flag);
}

/** What the flags held forbid (ABILITIES.md's table). */
export function canMove(block: FlagBlock | undefined): boolean {
  return !hasFlag(block, FLAG.stunned) && !hasFlag(block, FLAG.rooted) && !hasFlag(block, FLAG.dead);
}

export function canTurn(block: FlagBlock | undefined): boolean {
  return !hasFlag(block, FLAG.stunned) && !hasFlag(block, FLAG.dead);
}

/** Whether a unit may start a skill of this engine type, needing a weapon or not. */
export function canStart(block: FlagBlock | undefined, type: "spell" | "physical" | "none", weapon: boolean): boolean {
  if (hasFlag(block, FLAG.stunned) || hasFlag(block, FLAG.dead)) return false;
  if (type === "spell" && hasFlag(block, FLAG.silenced)) return false;
  if (type === "physical" && hasFlag(block, FLAG.pacified)) return false;
  if (weapon && hasFlag(block, FLAG.disarmed)) return false;
  return true;
}
