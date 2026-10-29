import type { GameRules } from "../sim/rules/gameRules";
import type { ProgressionRules, UnlockModifier } from "../sim/rules/progressionRules";
import { formatMoney, type ItemRules } from "../sim/rules/itemRules";
import { formulaText } from "../sim/rules/formulaText";
import type { ClientMessage, ProgressEventState } from "../sim/protocol";
import type { ProgressMirror } from "../game/progressMirror";
import type { EntityMirror } from "../game/entityMirror";
import { indexRules } from "../sim/rules/ruleIndex";

/**
 * The progression panel (PROGRESSION.md, *The client*), on P: the own origins, every discipline
 * with its level and XP, points left, the talent trees to spend them in, and what has been learned
 * or may be - with a trainer's Learn buttons when one is in reach. Plain DOM, as the inventory: the
 * HUD proper is step 10. Debug buttons give XP and levels.
 */
export interface ProgressPanel {
  /** Its element, for a HUD region to take (ui/hud.ts). */
  readonly element: HTMLElement;
  readonly visible: boolean;
  toggle: () => void;
  dispose: () => void;
}

export interface ProgressPanelOptions {
  game: GameRules;
  rules: ProgressionRules;
  items: ItemRules;
  progress: ProgressMirror;
  entities: EntityMirror;
  ownId: () => number;
  send: (message: ClientMessage) => void;
  /** Opens the rule book at a topic (`stat:<id>`, `disc:<id>`...), or at its start for "". */
  openBook: (key: string) => void;
}

const PANEL = "background: rgba(18, 20, 24, 0.92); color: #eee; border-radius: 6px; font: 12px/1.35 system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,0.45);";
const BUTTON = "font: inherit; font-size: 11px; padding: 1px 6px; margin-left: 4px; cursor: pointer; background: #333; color: #eee; border: 1px solid #555; border-radius: 3px;";

const REFUSALS: Record<string, string> = {
  known: "You already know that.",
  notYet: "You cannot learn that yet.",
  cannot: "That cannot be learned.",
  money: "You cannot afford that.",
  range: "The trainer is too far away.",
  notTrainer: "That is no trainer.",
  notTaught: "This trainer does not teach that.",
  points: "Not enough points.",
  tierLocked: "Spend more points in this tree first.",
  level: "Your level is too low for that tier.",
  picked: "You have already chosen in that tier.",
  requires: "Take the talent before it first.",
  maxed: "That talent is at its highest rank.",
  noTree: "That is not one of your trees.",
  nothing: "Nothing to reset.",
};

function el(tag: string, css: string, parent?: HTMLElement, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/** A modifier as a player reads it: "+3% armor per rank". */
export function modifierText(game: GameRules, m: UnlockModifier, variable: string): string {
  const stat = game.stats[m.stat]?.name ?? "?";
  const kind = game.modifierKinds[m.kind]?.id ?? "";
  const value = m.value.constant !== null ? String(m.value.constant) : formulaText(m.value.source, { own: "level", rank: variable });
  const sign = m.value.constant !== null && m.value.constant > 0 ? "+" : "";
  return kind === "percent" ? `${sign}${value}% ${stat}` : kind === "multiplier" ? `×${value} ${stat}` : `${sign}${value} ${stat}`;
}

export function createProgressPanel(options: ProgressPanelOptions): ProgressPanel {
  const { game, rules, items, progress, entities, send, openBook } = options;
  const index = indexRules(game, rules, items);
  const LINK = "color: #9fc7ff; cursor: pointer;";
  /** A name that opens the rule book at its page. */
  const bookLink = (parent: HTMLElement, text: string, key: string, css = ""): HTMLElement => {
    const e = el("span", `${LINK} ${css}`, parent, text);
    e.addEventListener("click", () => openBook(key));
    return e;
  };
  const ownStats = (): ReadonlyMap<number, number> => entities.entities.get(options.ownId())?.stats ?? new Map();
  const root = el("div", `position: fixed; right: 16px; top: 60px; width: 380px; max-height: 100%; overflow-y: auto; box-sizing: border-box; padding: 8px 10px; z-index: 960; display: none; ${PANEL}`, document.body);
  const body = el("div", "", root);
  const log = el("div", "margin-top: 8px; border-top: 1px solid #444; padding-top: 4px; font-size: 11px; color: #bbb;", root);
  let visible = false;
  let trainer = 0;
  const money = (n: number): string => formatMoney(items.currencies[items.main], n);
  const skillName = (skill: number): string => game.skills[skill]?.name ?? "?";

  /** The nearest trainer in reach of the own player, from what the client sees. */
  function trainerInReach(): number {
    const me = entities.entities.get(options.ownId());
    if (!me) return 0;
    let best = 0;
    let nearest = rules.config.trainRange;
    for (const entity of entities.entities.values()) {
      if (!rules.config.trainers.has(entity.templateId)) continue;
      const d = Math.hypot(entity.x - me.x, entity.z - me.z);
      if (d <= nearest) {
        nearest = d;
        best = entity.id;
      }
    }
    return best;
  }

  function section(title: string): HTMLElement {
    el("div", "font-weight: 600; margin: 8px 0 3px; color: #ffd27a;", body, title);
    return el("div", "", body);
  }

  function draw(): void {
    body.innerHTML = "";
    const p = progress.progress;
    if (!p) {
      body.textContent = "No progress yet.";
      return;
    }
    const top = el("div", "display: flex; align-items: center;", body);
    el("div", "font-weight: 600; font-size: 14px; flex: 1;", top, "Progression");
    el("button", BUTTON, top, "Rule book (K)").addEventListener("click", () => openBook(""));
    el("div", "color: #bbb;", body, rules.config.slots.map((slot, i) => `${slot.id}: ${rules.origins[p.origins[i]]?.name ?? "-"}`).join(" · "));

    // Disciplines, by group.
    const groups = new Map<string, typeof p.disciplines>();
    for (const d of p.disciplines) {
      const def = rules.disciplines[d.discipline];
      const group = def.group || "other";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(d);
    }
    const box = section("Disciplines");
    for (const [group, list] of groups) {
      el("div", "color: #999; font-size: 11px; margin-top: 3px; text-transform: capitalize;", box, group);
      for (const d of list) {
        const def = rules.disciplines[d.discipline];
        const row = el("div", "display: flex; align-items: center; gap: 6px; margin: 2px 0;", box);
        const name = el("div", "width: 92px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;", row);
        const what = def.stat >= 0 ? (index.readBy.get(def.stat) ?? []).map((u) => u.what) : [];
        const gives = def.unlocks.length + rules.origins.reduce((n, o) => n + (o.unlocks.get(d.discipline)?.length ?? 0), 0);
        const hint = [what.length ? `Used by: ${what.join(", ")}` : "", gives ? `Its levels give ${gives} thing${gives > 1 ? "s" : ""}` : "", what.length || gives ? "" : "Nothing reads it yet"];
        bookLink(name, def.name, `disc:${def.id}`).title = [...hint.filter(Boolean), "Click for what it does and how it rises"].join("\n");
        el("div", "width: 54px; color: #ccc;", row, `${d.level} / ${d.cap}`);
        const bar = el("div", "position: relative; flex: 1; height: 12px; background: #2a2a2a; border-radius: 3px; overflow: hidden;", row);
        el("div", `position: absolute; left: 0; top: 0; bottom: 0; width: ${Math.min(100, (100 * d.xp) / d.next)}%; background: ${d.level >= d.cap ? "#7a6a3a" : "#8a5ad8"};`, bar);
        el("div", "position: absolute; inset: 0; text-align: center; font-size: 10px; line-height: 12px; text-shadow: 0 1px 1px #000;", bar, d.level >= d.cap ? `at cap${d.banked > 0 ? ` (${Math.floor(d.banked)} banked)` : ""}` : `${Math.floor(d.xp)} / ${Math.ceil(d.next)}`);
        const xp = el("button", BUTTON, row, "+XP");
        xp.title = "Debug: a quarter of a level's XP";
        xp.addEventListener("click", () => send({ type: "debugXp", discipline: d.discipline, amount: Math.ceil(d.next / 4) }));
        const up = el("button", BUTTON, row, "+1");
        up.title = "Debug: one level";
        up.addEventListener("click", () => send({ type: "debugLevel", discipline: d.discipline, level: d.level + 1 }));
      }
    }

    // The own stats, each a link to what it does.
    const character = section("Character");
    const stats = ownStats();
    const grid = el("div", "display: grid; grid-template-columns: 1fr 1fr; gap: 1px 12px;", character);
    for (const stat of game.stats) {
      const value = stats.get(stat.index);
      if (value === undefined) continue;
      const cell = el("div", "display: flex; justify-content: space-between;", grid);
      const uses = (index.readBy.get(stat.index) ?? []).map((u) => u.what);
      bookLink(cell, stat.name, `stat:${stat.id}`).title = uses.length ? `Used by: ${uses.slice(0, 6).join(", ")}${uses.length > 6 ? "..." : ""}` : "Nothing reads it yet";
      el("span", "color: #ddd;", cell, String(Math.round(value * 100) / 100));
    }

    // Points and trees.
    const points = section("Talents");
    el("div", "color: #ccc;", points, p.points.map((pt) => `${pt.pool}: ${pt.left} of ${pt.total} left`).join(" · ") || "No point pools.");
    for (const treeIndex of p.trees) {
      const tree = rules.trees[treeIndex];
      const ranks = new Map(p.talents.filter((t) => t.tree === treeIndex).map((t) => [t.node, t.rank]));
      let spent = 0;
      for (const [node, rank] of ranks) spent += rank * tree.nodes[node].cost;
      const head = el("div", "display: flex; align-items: center; margin-top: 6px;", points);
      el("div", "font-weight: 600; flex: 1;", head, `${tree.name} (${tree.points}, ${spent} spent)`);
      const reset = el("button", BUTTON, head, "Reset");
      reset.addEventListener("click", () => send({ type: "talentReset", tree: treeIndex }));
      const disciplineLevel = tree.discipline >= 0 ? (p.disciplines.find((d) => d.discipline === tree.discipline)?.level ?? 0) : Infinity;
      tree.tiers.forEach((tier, t) => {
        const open = spent >= tier.requires && disciplineLevel >= tier.level;
        const needs = [tier.requires > 0 ? `${tier.requires} spent` : "", tier.level > 0 ? `${rules.disciplines[tree.discipline].name} ${tier.level}` : "", Number.isFinite(tier.pick) ? `pick ${tier.pick}` : ""].filter(Boolean).join(", ");
        const row = el("div", `display: flex; flex-wrap: wrap; gap: 4px; margin: 3px 0; opacity: ${open ? 1 : 0.45};`, points);
        el("div", "width: 100%; font-size: 10px; color: #999;", row, `Tier ${t + 1}${needs ? ` - ${needs}` : ""}`);
        for (const node of tree.nodes.filter((n) => n.tier === t)) {
          const rank = ranks.get(node.index) ?? 0;
          const button = el("button", `${BUTTON} margin: 0; ${rank > 0 ? "border-color: #c9a040; color: #ffd27a;" : ""}`, row, `${node.name} ${rank}/${node.ranks}`);
          const gives = [...node.modifiers.map((m) => modifierText(game, m, "rank")), node.skill >= 0 ? `teaches ${skillName(node.skill)}` : "", node.requires.length ? `needs ${node.requires.map((r) => tree.nodes[r].name).join(", ")}` : ""].filter(Boolean);
          const yours = [...new Set(node.modifiers.map((m) => m.stat))].map((s) => `your ${game.stats[s].name}: ${Math.round((stats.get(s) ?? 0) * 100) / 100}`);
          button.title = `${gives.join("\n")}\ncosts ${node.cost} ${tree.points} a rank${yours.length ? `\n(${yours.join(", ")})` : ""}`;
          button.addEventListener("click", () => send({ type: "talentPick", tree: treeIndex, node: node.index }));
        }
      });
    }

    // Abilities.
    const abilities = section("Abilities");
    el("div", "color: #ccc;", abilities, p.learned.length ? `Learned: ${p.learned.map((l) => `${skillName(l.skill)} (${l.how})`).join(", ")}` : "Nothing learned yet: what your class starts with is in the spell bar.");
    trainer = trainerInReach();
    for (const a of p.available) {
      const row = el("div", "display: flex; align-items: center; margin: 2px 0;", abilities);
      const where = a.how === "trainer" ? `from a trainer${a.cost > 0 ? `, ${money(a.cost)}` : ""}` : a.how === "item" ? "from a book" : `by ${a.how}`;
      el("div", "flex: 1;", row, `${skillName(a.skill)} - ${where}`);
      if (a.how === "trainer" && trainer) {
        const learn = el("button", BUTTON, row, "Learn");
        learn.addEventListener("click", () => send({ type: "learn", trainer, skill: a.skill }));
      }
    }
    if (p.available.length === 0) el("div", "color: #999;", abilities, "Nothing waiting to be learned.");
    const all = el("button", `${BUTTON} margin: 6px 0 0;`, abilities, "Learn everything (debug)");
    all.addEventListener("click", () => send({ type: "debugLearnAll" }));
  }

  function eventText(e: ProgressEventState): string {
    const d = rules.disciplines[e.discipline]?.name ?? "";
    switch (e.kind) {
      case "xp":
        return `+${Math.round(e.amount)} ${d} XP (${e.source})`;
      case "levelUp":
        return `${d} is now level ${e.level}`;
      case "learned":
        return `Learned ${skillName(e.skill)}`;
      case "unlocked":
        return `${skillName(e.skill)} can now be learned ${e.source === "trainer" ? "from a trainer" : e.source === "item" ? "from a book" : `by ${e.source}`}`;
      case "talent":
        return e.amount < 0 ? `${e.source}: talents reset` : `${e.source}: talent taken (rank ${e.level})`;
      case "refused":
        return REFUSALS[e.source] ?? `Refused: ${e.source}`;
      default:
        return e.kind;
    }
  }
  function drawLog(): void {
    log.innerHTML = "";
    for (const e of progress.recent.slice(-8)) el("div", e.kind === "refused" ? "color: #ff9a8a;" : "", log, eventText(e));
  }

  progress.onChange(() => visible && draw());
  progress.onEvents(() => visible && drawLog());
  // A trainer coming into or out of reach changes the Learn buttons.
  const timer = setInterval(() => {
    if (visible && trainerInReach() !== trainer) draw();
  }, 500);

  return {
    element: root,
    get visible() {
      return visible;
    },
    toggle() {
      visible = !visible;
      root.style.display = visible ? "block" : "none";
      if (visible) {
        draw();
        drawLog();
      }
    },
    dispose() {
      clearInterval(timer);
      root.remove();
    },
  };
}
