import type { RawObject, Reader } from "../../world/content/contentReader";
import type { CompiledFormula } from "../rules/formula";
import type { Entity } from "../entity";
import type { Magic, Sys } from "./types";

/**
 * The action registry (see ABILITIES.md, *Actions*): every kind of action a skill's states can run,
 * by name. Core's kinds are registered here with the same `registerAction` scripts will use later,
 * so a new kind needs no change to the engine. A kind reads and checks its fields at load (`check`),
 * and - from the magics' step on - runs (`run`) and, if held, is undone (`undo`).
 */

/** One action as read from a skill: its kind, the group it acts on, and what its kind made of it. */
export interface Action {
  kind: string;
  /** Index into the skill's groups; the host's by default. */
  group: number;
  data: unknown;
}

/** What a kind's `check` is given: the reader, and ways to resolve what the action names. Each
 *  reports a problem on the reader at its path and returns something harmless. */
export interface CheckContext {
  reader: Reader;
  /** Compiles an expression in the skill's scope (ABILITIES.md, *Attributes in expressions*). */
  expr(value: unknown, path: string): CompiledFormula;
  /** `obj[key]` as an expression, or a constant when it is left out. */
  optionalExpr(obj: RawObject, key: string, path: string, fallback: number): CompiledFormula;
  /** A nested list of actions (`if`'s `then`). */
  actions(value: unknown, path: string): Action[];
  skill(id: unknown, path: string): number;
  /** A var of another skill, by name: what a `cast` action's `vars` set. */
  skillVar(skill: number, name: string, path: string): number;
  state(id: unknown, path: string): number;
  /** One of this skill's own vars. */
  ownVar(id: unknown, path: string): number;
  stat(id: unknown, path: string): number;
  modifierKind(id: unknown, path: string): number;
  resource(id: unknown, path: string): number;
  flag(id: unknown, path: string): number;
  area(id: unknown, path: string): number;
  group(id: unknown, path: string): number;
  /** A roll set of `rules/combat.json5`, or "none" (-1). */
  roll(id: unknown, path: string): number;
  /** A template that can be made, checked once templates are read. */
  template(id: unknown, path: string): string;
}

export interface ActionKind<T = unknown> {
  /** Fields besides `do` and `group`. */
  keys: readonly string[];
  /** Applied on entering a state's `hold` and undone on leaving it; only held kinds may be held. */
  held?: boolean;
  check(obj: RawObject, path: string, ctx: CheckContext): T;
  /** Runs it on its group's members (an empty list for a group nobody is in). */
  run?(sys: Sys, magic: Magic, data: T, targets: Entity[]): void;
  /** A held kind: applies it to one target, returning what `undo` needs. */
  apply?(sys: Sys, magic: Magic, data: T, target: Entity): unknown;
  undo?(sys: Sys, magic: Magic, data: T, target: Entity, record: unknown): void;
}

/** Gives a registered kind its effect: core's runs live in runs.ts, beside the magics they need. */
export function attachRun<T>(kind: string, effect: Pick<ActionKind<T>, "run" | "apply" | "undo">): void {
  const definition = registry.get(kind) as ActionKind<T> | undefined;
  if (!definition) throw new Error(`no action kind "${kind}" to attach to`);
  Object.assign(definition, effect);
}

const registry = new Map<string, ActionKind>();

export function registerAction<T>(kind: string, definition: ActionKind<T>): void {
  if (registry.has(kind)) throw new Error(`action kind "${kind}" is registered twice`);
  registry.set(kind, definition as ActionKind);
}

export const actionKind = (kind: string): ActionKind | undefined => registry.get(kind);
export const actionKinds = (): string[] => [...registry.keys()].sort();

// --- core's kinds: what each reads (their effects come with the magics) ---

export interface DamageData { amount: CompiledFormula; roll: number | null; threat: CompiledFormula }
export interface HealData { amount: CompiledFormula; roll: number | null; threat: CompiledFormula }
export interface ResourceData { resource: number; amount: CompiledFormula }
export interface ModifierData { stat: number; kind: number; value: CompiledFormula; perStack: boolean }
export interface FlagData { flags: number[] }
export interface AbsorbData { amount: CompiledFormula; tags: string[] }
export interface CastData { skill: number; level: CompiledFormula | null; vars: { index: number; value: CompiledFormula }[]; mode: "apply" | "cast"; by: "caster" | "host" }
export interface StacksData { skill: number; stackGroup: string; amount: CompiledFormula }
export interface RemoveData { skill: number; tag: string; dispel: string; count: CompiledFormula }
export interface InterruptData { lockout: CompiledFormula }
export type MoveKind = "dash" | "leap" | "knockback" | "pull" | "teleport";
export interface MoveData { kind: MoveKind; speed: CompiledFormula; distance: CompiledFormula; height: CompiledFormula; toTarget: boolean }
export interface SummonData { template: string; count: CompiledFormula; duration: CompiledFormula; at: number }
export interface ThreatData { amount: CompiledFormula; taunt: boolean }
export interface NameData { name: string }
export interface GotoData { state: number }
export interface SetData { variable: number; value: CompiledFormula }
export interface IfData { when: CompiledFormula | null; has: number; then: Action[]; otherwise: Action[] }
export interface ChanceData { p: CompiledFormula; then: Action[]; otherwise: Action[] }

const optionalRoll = (obj: RawObject, path: string, ctx: CheckContext): number | null => (obj.roll === undefined ? null : ctx.roll(obj.roll, `${path}.roll`));

registerAction<DamageData>("damage", {
  keys: ["amount", "roll", "threat"],
  check: (obj, path, ctx) => ({ amount: ctx.expr(obj.amount, `${path}.amount`), roll: optionalRoll(obj, path, ctx), threat: ctx.optionalExpr(obj, "threat", path, 1) }),
});

registerAction<HealData>("heal", {
  keys: ["amount", "roll", "threat"],
  check: (obj, path, ctx) => ({ amount: ctx.expr(obj.amount, `${path}.amount`), roll: optionalRoll(obj, path, ctx), threat: ctx.optionalExpr(obj, "threat", path, 1) }),
});

registerAction<ResourceData>("resource", {
  keys: ["resource", "amount"],
  check: (obj, path, ctx) => ({ resource: ctx.resource(obj.resource, `${path}.resource`), amount: ctx.expr(obj.amount, `${path}.amount`) }),
});

registerAction<ModifierData>("modifier", {
  keys: ["stat", "kind", "value", "perStack"],
  held: true,
  check: (obj, path, ctx) => ({
    stat: ctx.stat(obj.stat, `${path}.stat`),
    kind: ctx.modifierKind(obj.kind, `${path}.kind`),
    value: ctx.expr(obj.value, `${path}.value`),
    perStack: ctx.reader.boolean(obj, "perStack", path, false),
  }),
});

registerAction<FlagData>("flag", {
  keys: ["flags"],
  held: true,
  check: (obj, path, ctx) => ({ flags: ctx.reader.stringList(obj, "flags", path).map((f, i) => ctx.flag(f, `${path}.flags[${i}]`)) }),
});

registerAction<AbsorbData>("absorb", {
  keys: ["amount", "tags"],
  held: true,
  check: (obj, path, ctx) => ({ amount: ctx.expr(obj.amount, `${path}.amount`), tags: obj.tags === undefined ? [] : ctx.reader.stringList(obj, "tags", path) }),
});

registerAction<CastData>("cast", {
  keys: ["skill", "level", "vars", "mode", "by"],
  check: (obj, path, ctx) => {
    const skill = ctx.skill(obj.skill, `${path}.skill`);
    const vars: CastData["vars"] = [];
    if (obj.vars !== undefined) {
      const raw = ctx.reader.object(obj.vars, `${path}.vars`);
      for (const [name, value] of Object.entries(raw)) {
        const at = `${path}.vars.${name}`;
        vars.push({ index: ctx.skillVar(skill, name, at), value: ctx.expr(value, at) });
      }
    }
    return {
      skill,
      level: obj.level === undefined ? null : ctx.expr(obj.level, `${path}.level`),
      vars,
      mode: obj.mode === undefined ? "apply" : ctx.reader.oneOf(obj, "mode", path, ["apply", "cast"] as const),
      by: obj.by === undefined ? "caster" : ctx.reader.oneOf(obj, "by", path, ["caster", "host"] as const),
    };
  },
});

registerAction<StacksData>("stacks", {
  keys: ["skill", "stackGroup", "amount"],
  check: (obj, path, ctx) => {
    if ((obj.skill === undefined) === (obj.stackGroup === undefined)) ctx.reader.fail(path, "name either a `skill` or a `stackGroup`");
    return {
      skill: obj.skill === undefined ? -1 : ctx.skill(obj.skill, `${path}.skill`),
      stackGroup: ctx.reader.optionalString(obj, "stackGroup", path) ?? "",
      amount: ctx.expr(obj.amount, `${path}.amount`),
    };
  },
});

registerAction<RemoveData>("remove", {
  keys: ["skill", "tag", "dispel", "count"],
  check: (obj, path, ctx) => {
    if (obj.skill === undefined && obj.tag === undefined && obj.dispel === undefined) ctx.reader.fail(path, "name a `skill`, a `tag` or a `dispel` type to remove");
    return {
      skill: obj.skill === undefined ? -1 : ctx.skill(obj.skill, `${path}.skill`),
      tag: ctx.reader.optionalString(obj, "tag", path) ?? "",
      dispel: ctx.reader.optionalString(obj, "dispel", path) ?? "",
      count: ctx.optionalExpr(obj, "count", path, 1000),
    };
  },
});

registerAction<InterruptData>("interrupt", {
  keys: ["lockout"],
  check: (obj, path, ctx) => ({ lockout: ctx.optionalExpr(obj, "lockout", path, 0) }),
});

registerAction<MoveData>("move", {
  keys: ["kind", "speed", "distance", "height", "toTarget"],
  check: (obj, path, ctx) => ({
    kind: ctx.reader.oneOf(obj, "kind", path, ["dash", "leap", "knockback", "pull", "teleport"] as const),
    speed: ctx.optionalExpr(obj, "speed", path, 20),
    distance: ctx.optionalExpr(obj, "distance", path, 10),
    height: ctx.optionalExpr(obj, "height", path, 0),
    toTarget: ctx.reader.boolean(obj, "toTarget", path, false),
  }),
});

registerAction<SummonData>("summon", {
  keys: ["template", "count", "duration", "at"],
  check: (obj, path, ctx) => ({
    template: ctx.template(obj.template, `${path}.template`),
    count: ctx.optionalExpr(obj, "count", path, 1),
    duration: ctx.optionalExpr(obj, "duration", path, 0),
    at: obj.at === undefined ? -1 : ctx.area(obj.at, `${path}.at`),
  }),
});

registerAction<ThreatData>("threat", {
  keys: ["amount", "taunt"],
  check: (obj, path, ctx) => ({ amount: ctx.optionalExpr(obj, "amount", path, 0), taunt: ctx.reader.boolean(obj, "taunt", path, false) }),
});

registerAction<NameData>("animation", { keys: ["name"], check: (obj, path, ctx) => ({ name: ctx.reader.string(obj, "name", path) }) });
registerAction<NameData>("effect", { keys: ["name"], check: (obj, path, ctx) => ({ name: ctx.reader.string(obj, "name", path) }) });
registerAction<GotoData>("goto", { keys: ["state"], check: (obj, path, ctx) => ({ state: ctx.state(obj.state, `${path}.state`) }) });

registerAction<SetData>("set", {
  keys: ["var", "value"],
  check: (obj, path, ctx) => ({ variable: ctx.ownVar(obj.var, `${path}.var`), value: ctx.expr(obj.value, `${path}.value`) }),
});

registerAction<IfData>("if", {
  keys: ["when", "has", "then", "else"],
  check: (obj, path, ctx) => {
    if (obj.when === undefined && obj.has === undefined) ctx.reader.fail(path, "needs `when` (an expression) or `has` (a group that must not be empty), or both");
    return {
      when: obj.when === undefined ? null : ctx.expr(obj.when, `${path}.when`),
      has: obj.has === undefined ? -1 : ctx.group(obj.has, `${path}.has`),
      then: ctx.actions(obj.then ?? [], `${path}.then`),
      otherwise: ctx.actions(obj.else ?? [], `${path}.else`),
    };
  },
});

registerAction<ChanceData>("chance", {
  keys: ["p", "then", "else"],
  check: (obj, path, ctx) => ({ p: ctx.expr(obj.p, `${path}.p`), then: ctx.actions(obj.then ?? [], `${path}.then`), otherwise: ctx.actions(obj.else ?? [], `${path}.else`) }),
});

registerAction<null>("end", { keys: [], check: () => null });

// Progression's kinds (PROGRESSION.md, *Actions*): read here, beside the rest; their effects are
// attached by src/sim/progression, and a discipline's id is checked by the progression rules.
export interface LearnData { skill: number }
export interface XpData { discipline: string; amount: CompiledFormula }

registerAction<LearnData>("learn", { keys: ["skill"], check: (obj, path, ctx) => ({ skill: ctx.skill(obj.skill, `${path}.skill`) }) });

registerAction<XpData>("xp", {
  keys: ["discipline", "amount"],
  check: (obj, path, ctx) => ({ discipline: ctx.reader.string(obj, "discipline", path), amount: ctx.expr(obj.amount, `${path}.amount`) }),
});
