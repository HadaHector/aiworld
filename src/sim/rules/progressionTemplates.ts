import { isObject, Reader, type ContentIssue, type RawObject } from "../../world/content/contentReader";
import { hashString } from "../../world/content/dimensions";
import { deriveSeed, mulberry32 } from "../../world/rng";

/** A pack file, or one a template made: the progression rules read both the same way. */
export interface GeneratedEntry {
  id: string;
  file: string;
  data: unknown;
  /** The template that made it. */
  template: string;
}

interface Entry {
  id: string;
  file: string;
  data: unknown;
}

/** One choice on an axis: its id, its name, and whatever fields it sets. */
type Part = RawObject & { id: string };

const DISCIPLINE_TEMPLATE_KEYS = ["axes", "only", "never", "name", "stat", "start", "cap", "next", "overflow", "rate", "xp", "unlocks", "visible", "group", "order", "vars"];
const ORIGIN_TEMPLATE_KEYS = ["axes", "only", "never", "keep", "abilities", "tree", "unlocksOn", "slot", "name", "look", "stats", "modifiers", "resources", "spells", "disciplines", "unlocks", "trees"];

/**
 * Expands `disciplineTemplates/` and `originTemplates/` into disciplines, origins and their talent
 * trees for a world seed (see PROGRESSION.md, *Generated disciplines and origins*), as raw objects
 * the progression rules then read like any pack file. Everything the seed decides - rolled vars,
 * which combinations a world keeps, which abilities and talents a generated class gets - comes from
 * a stream seeded by the world seed and the made thing's id.
 */
export function expandTemplates(
  disciplineTemplates: Entry[],
  originTemplates: Entry[],
  pools: Entry[],
  seed: number,
  never: ReadonlySet<string>,
  issues: ContentIssue[],
): { disciplines: GeneratedEntry[]; origins: GeneratedEntry[]; trees: Entry[] } {
  const disciplines: GeneratedEntry[] = [];
  for (const entry of disciplineTemplates) {
    if (never.has(entry.id)) continue;
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", DISCIPLINE_TEMPLATE_KEYS);
    for (const parts of combinations(obj, reader)) {
      const id = [entry.id, ...Object.values(parts).map((p) => p.id)].join(".");
      if (never.has(id)) continue;
      const own = fill(withoutKeys(obj, ["axes", "only", "never", "vars"]), parts) as RawObject;
      // Vars: each [low, high] rolled for this discipline, so one world's curve differs from another's.
      if (obj.vars !== undefined) {
        const random = mulberry32(deriveSeed(seed, hashString(`discipline:${id}`)));
        const raw = reader.object(obj.vars, "vars");
        const vars: Record<string, number> = {};
        for (const name of Object.keys(raw).sort()) {
          const value = raw[name];
          if (typeof value === "number") vars[name] = value;
          else {
            const [lo, hi] = reader.range(raw, name, "vars", { allowEqual: true });
            vars[name] = Math.round((lo + random() * (hi - lo)) * 100) / 100;
          }
        }
        own.vars = vars;
      }
      disciplines.push({ id, file: entry.file, data: own, template: entry.id });
    }
  }

  const poolNodes = new Map<string, Map<string, RawObject>>();
  for (const entry of pools) {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["nodes"]);
    const nodes = reader.object(obj.nodes, "nodes");
    poolNodes.set(entry.id, new Map(Object.keys(nodes).sort().map((id) => [id, reader.object(nodes[id], `nodes.${id}`)])));
  }

  const origins: GeneratedEntry[] = [];
  const trees: Entry[] = [];
  for (const entry of originTemplates) {
    if (never.has(entry.id)) continue;
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ORIGIN_TEMPLATE_KEYS);
    const candidates = combinations(obj, reader).filter((parts) => !never.has([entry.id, ...Object.values(parts).map((p) => p.id)].join(".")));
    // Which of them this world keeps.
    const random = mulberry32(deriveSeed(seed, hashString(`originTemplate:${entry.id}`)));
    const keep = obj.keep === undefined ? [candidates.length, candidates.length] : typeof obj.keep === "number" ? [obj.keep, obj.keep] : reader.range(obj, "keep", "", { allowEqual: true });
    const count = Math.min(candidates.length, keep[0] + Math.floor(random() * (keep[1] - keep[0] + 1)));
    const kept: Record<string, Part>[] = [];
    const left = [...candidates];
    for (let i = 0; i < count; i++) kept.push(left.splice(Math.floor(random() * left.length), 1)[0]);
    kept.sort((a, b) => key(a).localeCompare(key(b)));

    for (const parts of kept) {
      const id = [entry.id, ...Object.values(parts).map((p) => p.id)].join(".");
      const own = makeOrigin(obj, parts, reader);
      const stream = mulberry32(deriveSeed(seed, hashString(`origin:${id}`)));
      // Abilities drawn from the pool, learned at levels spread over `at`.
      if (obj.abilities !== undefined) {
        const raw = reader.object(obj.abilities, "abilities");
        reader.onlyKeys(raw, "abilities", ["pick", "pool", "at", "on"]);
        const known = new Set((own.spells as unknown[]).map((s) => (isObject(s) ? s.skill : s)));
        const pool = reader.array(raw, "pool", "abilities").filter((p) => !known.has(isObject(p) ? p.skill : p));
        const pick = typeof raw.pick === "number" ? [raw.pick, raw.pick] : reader.range(raw, "pick", "abilities", { allowEqual: true });
        const n = Math.min(pool.length, pick[0] + Math.floor(stream() * (pick[1] - pick[0] + 1)));
        const chosen: unknown[] = [];
        for (let i = 0; i < n; i++) chosen.push(pool.splice(Math.floor(stream() * pool.length), 1)[0]);
        const at = raw.at === undefined ? [2, 10] : reader.range(raw, "at", "abilities", { allowEqual: true });
        const on = typeof raw.on === "string" ? raw.on : typeof obj.unlocksOn === "string" ? obj.unlocksOn : "class";
        const unlocks = isObject(own.unlocks) ? own.unlocks : {};
        const list = Array.isArray(unlocks[on]) ? [...(unlocks[on] as unknown[])] : [];
        chosen.forEach((p, i) => {
          const level = n === 1 ? at[0] : Math.round(at[0] + (i * (at[1] - at[0])) / (n - 1));
          list.push({ ...(isObject(p) ? p : { skill: p }), at: level });
        });
        own.unlocks = { ...unlocks, [on]: list };
      }
      // A talent tree of nodes drawn from a pool, laid out in tiers by their weight.
      if (obj.tree !== undefined) {
        const tree = makeTree(id, reader.object(obj.tree, "tree"), parts, poolNodes, stream, reader);
        if (tree) {
          trees.push({ id: tree.id, file: entry.file, data: tree.data });
          own.trees = [...(Array.isArray(own.trees) ? own.trees : []), tree.id];
        }
      }
      origins.push({ id, file: entry.file, data: own, template: entry.id });
    }
  }
  return { disciplines, origins, trees };
}

const key = (parts: Record<string, Part>): string => Object.values(parts).map((p) => p.id).join(".");

function withoutKeys(obj: RawObject, keys: string[]): RawObject {
  const out: RawObject = {};
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** Every allowed pick of one part per axis, in the axes' order. */
function combinations(obj: RawObject, reader: Reader): Record<string, Part>[] {
  const axesRaw = reader.object(obj.axes, "axes");
  let combos: Record<string, Part>[] = [{}];
  for (const axis of Object.keys(axesRaw)) {
    const parts = reader.array(axesRaw, axis, "axes").map((value, i): Part => {
      const part = reader.object(value, `axes.${axis}[${i}]`);
      const partId = reader.string(part, "id", `axes.${axis}[${i}]`);
      if (partId && !/^[A-Za-z0-9_-]+$/.test(partId)) reader.fail(`axes.${axis}[${i}].id`, "may only use letters, digits, - and _");
      return { ...part, id: partId };
    });
    if (parts.length === 0) reader.fail(`axes.${axis}`, "an axis needs at least one part");
    combos = combos.flatMap((c) => parts.map((p) => ({ ...c, [axis]: p })));
  }
  const rules = (k: "only" | "never"): RawObject[] => (obj[k] === undefined ? [] : reader.array(obj, k, "").map((v, i) => reader.object(v, `${k}[${i}]`)));
  const matches = (combo: Record<string, Part>, rule: RawObject): boolean => Object.entries(rule).every(([axis, part]) => combo[axis]?.id === part);
  const only = rules("only");
  const never = rules("never");
  return combos.filter((c) => (only.length === 0 || only.some((r) => matches(c, r))) && !never.some((r) => matches(c, r)));
}

/** Fills `{axis}` (the part's name) and `{axis.field}` (one of its fields) everywhere in a value: a
 *  string that is only `{axis.field}` becomes that field's value, whatever it is. */
function fill(value: unknown, parts: Record<string, Part>): unknown {
  if (typeof value === "string") {
    const whole = /^\{(\w+)\.(\w+)\}$/.exec(value);
    if (whole && parts[whole[1]] && parts[whole[1]][whole[2]] !== undefined) return parts[whole[1]][whole[2]];
    return value.replace(/\{(\w+)(?:\.(\w+))?\}/g, (match, axis: string, field?: string) => {
      const part = parts[axis];
      if (!part) return match;
      const v = field ? part[field] : (part.name ?? part.id);
      return typeof v === "string" || typeof v === "number" ? String(v) : match;
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, parts));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, parts)]));
  return value;
}

const ORIGIN_FIELDS = ["look", "stats", "modifiers", "resources", "spells", "disciplines", "unlocks", "trees"];

/** An origin from a template's own fields with each part's merged over them: stats add, lists add
 *  (a resource or a spell once), `look`, `disciplines` and `unlocks` merge. */
function makeOrigin(template: RawObject, parts: Record<string, Part>, reader: Reader): RawObject {
  const own: RawObject = { slot: template.slot, name: fill(template.name ?? "", parts) };
  const layers: RawObject[] = [template, ...Object.values(parts)];
  const stats: Record<string, number> = {};
  const lists: Record<string, unknown[]> = { modifiers: [], resources: [], spells: [], trees: [] };
  let look: RawObject = {};
  const disciplines: Record<string, number> = {};
  const unlocks: Record<string, unknown[]> = {};
  for (const layer of layers) {
    for (const k of Object.keys(layer)) {
      if (layer !== template && !["id", "name", ...ORIGIN_FIELDS].includes(k)) reader.fail(`axes`, `a part's "${k}" is not an origin field (expected one of: id, name, ${ORIGIN_FIELDS.join(", ")})`);
    }
    if (isObject(layer.stats)) for (const [k, v] of Object.entries(layer.stats)) stats[k] = (stats[k] ?? 0) + (typeof v === "number" ? v : 0);
    for (const k of Object.keys(lists)) if (Array.isArray(layer[k])) lists[k].push(...(layer[k] as unknown[]));
    if (isObject(layer.look)) look = { ...look, ...layer.look };
    if (isObject(layer.disciplines)) for (const [k, v] of Object.entries(layer.disciplines)) disciplines[k] = Math.max(disciplines[k] ?? 0, typeof v === "number" ? v : 0);
    if (isObject(layer.unlocks)) for (const [k, v] of Object.entries(layer.unlocks)) if (Array.isArray(v)) unlocks[k] = [...(unlocks[k] ?? []), ...v];
  }
  const once = (list: unknown[]): unknown[] => {
    const seen = new Set<string>();
    return list.filter((v) => {
      const k = JSON.stringify(isObject(v) && v.skill !== undefined ? v.skill : v);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  Object.assign(own, {
    stats,
    modifiers: lists.modifiers,
    resources: once(lists.resources),
    spells: once(lists.spells),
    disciplines,
    unlocks,
    trees: once(lists.trees),
  });
  if (Object.keys(look).length > 0) own.look = look;
  return fill(own, parts) as RawObject;
}

/** A generated talent tree: `nodes.pick` nodes drawn from a pool, sorted by weight and dealt into
 *  `tiers` tiers, each opening `step` points after the one before (or as many as there are below). */
function makeTree(originId: string, raw: RawObject, parts: Record<string, Part>, pools: Map<string, Map<string, RawObject>>, random: () => number, reader: Reader): { id: string; data: RawObject } | null {
  reader.onlyKeys(raw, "tree", ["name", "points", "tiers", "step", "nodes"]);
  const nodesRaw = reader.object(raw.nodes, "tree.nodes");
  reader.onlyKeys(nodesRaw, "tree.nodes", ["pick", "pool"]);
  const poolId = reader.string(nodesRaw, "pool", "tree.nodes");
  const pool = pools.get(poolId);
  if (!pool) {
    reader.fail("tree.nodes.pool", `no talent pool "${poolId}" (known: ${[...pools.keys()].join(", ") || "none"})`);
    return null;
  }
  const pick = typeof nodesRaw.pick === "number" ? [nodesRaw.pick, nodesRaw.pick] : reader.range(nodesRaw, "pick", "tree.nodes", { allowEqual: true });
  const ids = [...pool.keys()];
  const n = Math.min(ids.length, pick[0] + Math.floor(random() * (pick[1] - pick[0] + 1)));
  const chosen: string[] = [];
  for (let i = 0; i < n; i++) chosen.push(ids.splice(Math.floor(random() * ids.length), 1)[0]);
  const weight = (id: string): number => (typeof pool.get(id)!.weight === "number" ? (pool.get(id)!.weight as number) : 0);
  chosen.sort((a, b) => weight(a) - weight(b) || a.localeCompare(b));
  const tierCount = Math.max(1, Math.min(chosen.length, reader.optionalNumber(raw, "tiers", "tree", 3, { integer: true, min: 1 })));
  const step = reader.optionalNumber(raw, "step", "tree", 3, { integer: true, min: 0 });
  const nodes: Record<string, RawObject> = {};
  const tiers: RawObject[] = [];
  let below = 0;
  for (let t = 0; t < tierCount; t++) {
    const from = Math.floor((t * chosen.length) / tierCount);
    const to = Math.floor(((t + 1) * chosen.length) / tierCount);
    tiers.push({ requires: Math.min(t * step, below) });
    for (const id of chosen.slice(from, to)) {
      const node = { ...pool.get(id)! };
      delete node.weight;
      nodes[id] = { ...node, tier: t };
      below += (typeof node.ranks === "number" ? node.ranks : 1) * (typeof node.cost === "number" ? node.cost : 1);
    }
  }
  return {
    id: `${originId}.tree`,
    data: { name: fill(raw.name ?? originId, parts), points: raw.points ?? "talent", tiers, nodes },
  };
}
