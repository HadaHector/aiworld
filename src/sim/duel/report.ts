import { defenceMultiplier, type StatReader } from "../rules/defenceRules";
import { statValue } from "../stats";
import { createArena, type DuelRules } from "./arena";
import { runDuel, type DuelResult } from "./duel";

/**
 * The duel tool's reports (B7, DUEL.md): each class against a dummy and against same-level creatures
 * by role, measured against the curves in rules/balance.json5 - dps, time to kill, time to die, the
 * fight's cost in health, resource use, time out of range - and placed on the tank / glass-cannon
 * axis. And a suggestion, never written into the content: one damage scale per class and level band.
 */

/** The player's combat role by class (`dpsRoles` in balance.json5), else by the template's distance. */
const COMBAT_ROLE: Record<string, string> = { warrior: "melee", ranger: "ranged", mage: "caster", priest: "hybrid" };

export function combatRole(rules: DuelRules, classId: string): string {
  if (COMBAT_ROLE[classId]) return COMBAT_ROLE[classId];
  const distance = rules.classes.find((c) => c.id === classId)?.distance;
  return distance === "closes" ? "melee" : "ranged";
}

/** One of each species with a role, the first variant: what "same-level creatures by role" fight. */
export function representatives(rules: DuelRules): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const kind of rules.creatures.kinds.values()) {
    const role = kind.balance?.role;
    if (!role || seen.has(`${role}/${kind.species}`)) continue;
    seen.add(`${role}/${kind.species}`);
    out.set(role, [...(out.get(role) ?? []), kind.id]);
  }
  return out;
}

export interface DummyReport {
  dps: number;
  /** What the curve asks, after a normal enemy's armour: playerDps x the combat role's factor x (1 - mitigation). */
  target: number;
  /** Resource spent a second, by resource. */
  spentPerSecond: Record<string, number>;
  casts: Record<string, number>;
}

export interface RoleReport {
  role: string;
  kinds: string[];
  fights: number;
  won: number;
  /** Means over the kinds: seconds to kill (fights won), seconds the foe would take to kill the
   *  character at the rate it dealt damage, share of health lost, seconds out of range. */
  ttk: number;
  ttd: number;
  lost: number;
  outOfRange: number;
  /** The role's targets: ttk, ttd, and the cost ttk/ttd. */
  targetTtk: number;
  targetTtd: number;
  targetLost: number;
}

export interface ClassReport {
  classId: string;
  level: number;
  combatRole: string;
  health: number;
  /** The health curve: playerHealth. */
  targetHealth: number;
  /** Effective health (health x physical defence against a same-level attacker) over the curve's
   *  (playerHealth / (1 - playerMitigation)). */
  ehRatio: number;
  dpsRatio: number;
  /** dps x effective health over the curve's: 1 is on the power budget. */
  power: number;
  /** 0 tank, 1 glass cannon: where dps and effective health split the budget. */
  axis: number;
  /** The class template's axis. */
  targetAxis: number | null;
  dummy: DummyReport;
  roles: RoleReport[];
}

/** Axis from the two ratios: even ratios are 0.5; a factor 4 of dps over effective health is 1. */
export function axisOf(dpsRatio: number, ehRatio: number): number {
  return Math.min(1, Math.max(0, 0.5 + Math.log(dpsRatio / ehRatio) / (2 * Math.log(4))));
}

export interface ReportOptions {
  /** Creature kinds to fight; by default the representatives of every role. */
  kinds?: string[];
  /** Seconds of the dummy fight (60). */
  dummySeconds?: number;
  seed?: number;
}

export function classReport(rules: DuelRules, classId: string, level: number, options: ReportOptions = {}): ClassReport {
  const balance = rules.creatures.balance;
  if (!balance) throw new Error("the packs have no balance curves (rules/balance.json5)");
  const role = combatRole(rules, classId);
  const normal = balance.roles.get("normal")!;
  const dpsFactor = balance.dpsRoles.get(role) ?? 1;

  // The character alone: health and effective health against a same-level blow.
  const arena = createArena(rules, options.seed ?? 1);
  const me = arena.character(classId, level, 0);
  const health = me.resources!.max[rules.game.health];
  const get: StatReader = (id) => {
    const index = rules.game.statIndex.get(id);
    return index === undefined ? 0 : statValue(me.stats!, index);
  };
  const defence = defenceMultiplier(rules.game.combat.defence, get, level, { health });
  const targetHealth = balance.curve("playerHealth", level);
  const ehRatio = (health * defence.physical) / (targetHealth / (1 - balance.curve("playerMitigation", level)));

  const d = runDuel(rules, { classId, level, foe: "dummy", limit: options.dummySeconds ?? 60, seed: options.seed });
  const dummy: DummyReport = {
    dps: d.player.dealt / d.seconds,
    target: balance.curve("playerDps", level) * dpsFactor * (1 - normal.mitigation),
    spentPerSecond: Object.fromEntries(Object.entries(d.player.spent).map(([k, v]) => [k, v / d.seconds])),
    casts: d.player.casts,
  };
  const dpsRatio = dummy.dps / dummy.target;

  const byRole = new Map<string, DuelResult[]>();
  const kinds = options.kinds ?? [...representatives(rules).values()].flat();
  for (const kind of kinds) {
    const r = runDuel(rules, { classId, level, foe: kind, seed: options.seed });
    byRole.set(r.foeRole, [...(byRole.get(r.foeRole) ?? []), r]);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const roles: RoleReport[] = [...byRole].map(([id, fights]) => {
    const def = balance.roles.get(id);
    const won = fights.filter((f) => f.winner === "player");
    return {
      role: id,
      kinds: fights.map((f) => f.foeKind),
      fights: fights.length,
      won: won.length,
      ttk: mean(won.map((f) => f.seconds)),
      ttd: mean(fights.map((f) => (f.player.taken > 0 ? (f.player.maxHealth * f.seconds) / f.player.taken : Infinity))),
      lost: mean(fights.map((f) => 1 - f.player.endHealth / f.player.maxHealth)),
      outOfRange: mean(fights.map((f) => f.outOfRange)),
      targetTtk: def?.ttk ?? NaN,
      targetTtd: def?.ttd ?? NaN,
      targetLost: def && def.ttd > 0 ? def.ttk / def.ttd : 0,
    };
  });

  return {
    classId,
    level,
    combatRole: role,
    health,
    targetHealth,
    ehRatio,
    dpsRatio,
    power: dpsRatio * ehRatio,
    axis: axisOf(dpsRatio, ehRatio),
    targetAxis: rules.classes.find((c) => c.id === classId)?.axis ?? null,
    dummy,
    roles,
  };
}

/** Level bands for the suggested scales: each measured level stands for its band. */
export const BANDS: readonly { from: number; to: number; at: number }[] = [
  { from: 1, to: 4, at: 1 },
  { from: 5, to: 8, at: 5 },
  { from: 9, to: 10, at: 10 },
];

/**
 * The suggestion (never written into the packs by the tool): per class and level band, the factor on
 * its damage that puts its dummy dps on the curve, and the factor on its health that puts its
 * effective health on the curve. The owner decides what goes in.
 */
export function suggestScales(reports: readonly ClassReport[]): Record<string, { band: string; damage: number; health: number }[]> {
  const out: Record<string, { band: string; damage: number; health: number }[]> = {};
  for (const r of reports) {
    const band = BANDS.find((b) => b.at === r.level) ?? { from: r.level, to: r.level, at: r.level };
    (out[r.classId] ??= []).push({ band: `${band.from}-${band.to}`, damage: round(1 / r.dpsRatio), health: round(1 / r.ehRatio) });
  }
  return out;
}

const round = (x: number) => Math.round(x * 100) / 100;

const f = (x: number, digits = 1) => (Number.isFinite(x) ? x.toFixed(digits) : "-");
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-");

/** The summary table: a line per class and level. */
export function summaryTable(reports: readonly ClassReport[]): string[] {
  const roleIds = [...new Set(reports.flatMap((r) => r.roles.map((x) => x.role)))];
  const head = ["class", "lvl", "hp/curve", "dummy dps/curve", "dps", "EH", "power", "axis (want)", ...roleIds.map((id) => `${id} ttk·ttd·lost (want)`)];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of reports) {
    const cells = [
      r.classId,
      String(r.level),
      `${Math.round(r.health)}/${Math.round(r.targetHealth)}`,
      `${f(r.dummy.dps)}/${f(r.dummy.target)}`,
      pct(r.dpsRatio),
      pct(r.ehRatio),
      pct(r.power),
      `${f(r.axis, 2)} (${r.targetAxis ?? "-"})`,
      ...roleIds.map((id) => {
        const x = r.roles.find((y) => y.role === id);
        if (!x) return "-";
        const lostWins = x.won < x.fights ? ` ${x.won}/${x.fights} won` : "";
        return `${f(x.ttk)}·${f(x.ttd, 0)}·${pct(x.lost)} (${f(x.targetTtk, 0)}·${f(x.targetTtd, 0)}·${pct(x.targetLost)})${lostWins}`;
      }),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines;
}

/** One duel written out. */
export function duelLines(r: DuelResult): string[] {
  const spent = Object.entries(r.player.spent).map(([k, v]) => `${k} ${f(v, 0)}`).join(", ") || "none";
  const casts = Object.entries(r.player.casts).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  const verdict = r.winner === "player" ? `won in ${f(r.seconds)} s` : r.winner === "foe" ? `died after ${f(r.seconds)} s` : `${f(r.seconds)} s, no one died`;
  return [
    `${r.classId} ${r.level} vs ${r.foeKind}${r.foeRole ? ` (${r.foeRole})` : ""} ${r.foeLevel}: ${verdict}`,
    `  dealt ${f(r.player.dealt, 0)} (${f(r.player.dealt / r.seconds)} a second), took ${f(r.player.taken, 0)}, healed ${f(r.player.healed, 0)}; health ${f(r.player.endHealth, 0)}/${f(r.player.maxHealth, 0)}`,
    `  foe: dealt ${f(r.enemy.dealt, 0)} (${f(r.enemy.dealt / r.seconds)} a second), health ${r.foeKind === "dummy" ? "-" : `${f(r.enemy.endHealth, 0)}/${f(r.enemy.maxHealth, 0)}`}`,
    `  spent ${spent}; casts ${casts}; out of range ${f(r.outOfRange)} s, moving ${f(r.moving)} s`,
    `  foe's casts ${Object.entries(r.enemy.casts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
  ];
}
