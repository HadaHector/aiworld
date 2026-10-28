import type { GameRules } from "../sim/rules/gameRules";
import type { ProgressionRules, SourceDef, UnlockDef } from "../sim/rules/progressionRules";
import { formatMoney, type ItemRules } from "../sim/rules/itemRules";
import type { CompiledFormula } from "../sim/rules/formula";
import { formulaText, nameText } from "../sim/rules/formulaText";
import { modifierText } from "./progressPanel";

/**
 * The rule book (PROGRESSION.md, *The client*), on K: how this game works, written from the rules
 * the page loaded - so it is right for whatever packs and seed are running. Chapters of plain text
 * and tables for now; a friendlier book later. Every formula is shown as readable text.
 */
export interface RuleBook {
  readonly visible: boolean;
  toggle: () => void;
  /** Every chapter as plain text - for the probe and the console. */
  text: () => string;
  dispose: () => void;
}

export interface RuleBookOptions {
  game: GameRules;
  progression: ProgressionRules;
  items: ItemRules;
}

/** A chapter: its title and its sections, each a heading and lines (a line may be a table row). */
interface Chapter {
  title: string;
  intro: string;
  sections: { heading: string; lines: (string | string[])[] }[];
}

const PANEL = "background: rgba(24, 22, 18, 0.95); color: #eee; border-radius: 8px; font: 13px/1.5 Georgia, serif; box-shadow: 0 4px 16px rgba(0,0,0,0.55);";

const f = (formula: CompiledFormula, names: Record<string, string> = {}): string => formulaText(formula.source, names);
const DISC_NAMES = { own: "its level" };
const SOURCE_NAMES = { own: "its level", amount: "the amount", earners: "the number of earners", share: "your share" };

/** What a source is, in words. */
function sourceText(s: SourceDef): string {
  const when: Record<string, string> = {
    kill: "Killing a creature",
    defeat: "Beating a unit that does not die (the training dummy) down to nothing",
    hitDealt: "Hitting something",
    hitTaken: "Being hit",
    healDealt: "Healing (overhealing does not count)",
    cast: "Casting an ability",
    skill: "An ability or item that gives it directly",
    gather: "Gathering",
    craft: "Crafting",
    quest: "Finishing a quest",
  };
  const credit: Record<string, string> = {
    all: "everyone who fought it gets the full amount",
    split: "it is shared evenly between everyone who fought it",
    damage: "it is shared by the damage each did",
    first: "only whoever hit it first gets it",
    top: "only whoever it hated most gets it",
  };
  const parts = [when[s.on] ?? s.on];
  if (s.tags.length) parts.push(`(abilities tagged ${s.tags.join(", ")})`);
  if (s.notTags.length) parts.push(`(not tagged ${s.notTags.join(", ")})`);
  if (s.weapon) parts.push(s.weapon === "none" ? "with bare hands" : `with ${"template" in s.weapon ? `a ${s.weapon.template}` : "type" in s.weapon ? s.weapon.type : `a ${s.weapon.kind}`} in hand`);
  if (s.spellSource) parts.push(s.spellSource.startsWith("origin:") ? `(only abilities your ${s.spellSource.slice(7)} gives)` : `(abilities from ${s.spellSource})`);
  if (s.periodic !== null) parts.push(s.periodic ? "(over time)" : "(not over time)");
  let line = `${parts.join(" ")}: ${f(s.amount, SOURCE_NAMES)} XP`;
  if (s.on === "kill" || s.on === "defeat") line += `; ${credit[s.credit]}`;
  if (s.when) line += `, when ${f(s.when, SOURCE_NAMES)}`;
  if (s.rate) line += `, times ${f(s.rate, SOURCE_NAMES)}`;
  return `${line}.`;
}

function levelsText(u: UnlockDef): string {
  if (u.at) return u.at.length === 1 ? `At level ${u.at[0]}` : `At levels ${u.at.join(", ")}`;
  const until = u.to < 1000 ? ` to ${u.to}` : "";
  return u.every === 1 ? `Every level from ${u.from}${until}` : `Every ${u.every} levels from ${u.from}${until}`;
}

function unlockText(game: GameRules, rules: ProgressionRules, items: ItemRules, u: UnlockDef): string {
  const gives: string[] = [];
  if (u.skill >= 0) {
    const name = game.skills[u.skill].name;
    gives.push(
      u.how === "auto" ? `you learn ${name}` : u.how === "trainer" ? `a trainer can teach you ${name}${u.cost ? ` for ${formatMoney(items.currencies[items.main], u.cost)}` : ""}` : u.how === "item" ? `a book can teach you ${name}` : u.how === "talent" ? `${name} can be taken as a talent` : `${name} can be learned by ${u.how}`,
    );
  }
  for (const m of u.modifiers) gives.push(modifierText(game, m, "rank"));
  for (const p of u.points) gives.push(`${p.amount} ${p.pool} point${p.amount === 1 ? "" : "s"}`);
  if (u.resource >= 0) gives.push(`you gain ${game.resources[u.resource].name}`);
  for (const d of u.disciplines) gives.push(`you start ${rules.disciplines[d.discipline].name} at level ${d.level}`);
  for (const k of u.knows) gives.push(`you know ${nameText(k)}`);
  return `${levelsText(u)}: ${gives.join(", ")}.`;
}

/** The book's chapters, from the rules. */
export function ruleBookChapters(game: GameRules, rules: ProgressionRules, items: ItemRules): Chapter[] {
  const chapters: Chapter[] = [];
  const defaults = new Float64Array(rules.disciplineScope.size);
  for (const stat of game.stats) defaults[stat.index] = stat.default;
  const levelDisc = rules.disciplines[rules.config.level];
  // In a discipline's formulas a stat is the character's own: "your Level".
  const discNames: Record<string, string> = { ...DISC_NAMES };
  for (const stat of game.stats) discNames[stat.id] = `your ${stat.name}`;
  for (const d of rules.disciplines) discNames[`disc.${d.id}`] = `your ${d.name}`;

  // --- disciplines ---
  chapters.push({
    title: "Disciplines",
    intro: `Everything you get better at is a discipline, with its own level and XP.${levelDisc ? ` ${levelDisc.name} is your character level.` : ""} XP comes from what you do; each level may teach you abilities, make you stronger, or give points to spend on talents.`,
    sections: rules.disciplines.map((d) => {
      const lines: (string | string[])[] = [];
      const facts: string[] = [];
      facts.push(d.start > 0 ? `Everyone starts at level ${d.start}.` : "You only have it once something gives it to you.");
      if (d.stat >= 0) facts.push(`Its level is your ${game.stats[d.stat].name}.`);
      facts.push(`It goes up to ${f(d.cap, discNames)}.`);
      if (d.overflow === "keep") facts.push("XP earned at the top is kept for when it can rise.");
      if (d.rate >= 0) facts.push(`Every gain is multiplied by your ${game.stats[d.rate].name}.`);
      if (d.template) facts.push(`This world made it from the template "${d.template}"${d.varNames.length ? `, rolling ${d.varNames.map((n, i) => `${n} = ${d.vars[i]}`).join(", ")}` : ""}.`);
      lines.push(facts.join(" "));
      lines.push(`XP from one level to the next: ${f(d.next, discNames)}.`);
      // The first levels' XP, worked out with every stat at its default.
      const row: string[] = [];
      for (let level = 1; level <= 10; level++) {
        defaults[rules.disciplineScope.own] = level;
        d.vars.forEach((v, i) => (defaults[rules.disciplineScope.vars + i] = v));
        row.push(`${level}→${level + 1}: ${Math.ceil(d.next.run(defaults))}`);
      }
      lines.push(row);
      if (d.sources.length) for (const s of d.sources) lines.push(sourceText(s));
      else lines.push("Nothing gives it XP yet.");
      for (const u of d.unlocks) lines.push(unlockText(game, rules, items, u));
      return { heading: `${d.name}${d.group ? ` (${d.group})` : ""}`, lines };
    }),
  });

  // --- origins ---
  for (const slot of rules.config.slots) {
    const origins = rules.origins.filter((o) => o.slot === slot.id);
    chapters.push({
      title: `${slot.id[0].toUpperCase()}${slot.id.slice(1)}`,
      intro: `Every character has a ${slot.id}${slot.required ? "" : " or none"}; ${rules.origins[rules.originIndex.get(slot.default) ?? -1]?.name ?? "none"} if you pick none. Choose with ?${slot.id}=<id> in the address until there is a character screen.`,
      sections: origins.map((o) => {
        const lines: (string | string[])[] = [];
        const raw = o.raw as { stats?: Record<string, number>; resources?: string[]; spells?: ({ skill: string } | string)[]; look?: { race?: string } };
        const stats = Object.entries(raw.stats ?? {}).map(([id, v]) => `${v > 0 ? "+" : ""}${v} ${game.stats[game.statIndex.get(id) ?? -1]?.name ?? id}`);
        if (stats.length) lines.push(`Stats: ${stats.join(", ")}.`);
        const modifiers = Array.isArray((o.raw as { modifiers?: unknown[] }).modifiers) ? ((o.raw as { modifiers: { stat: string; kind?: string; value: number }[] }).modifiers) : [];
        if (modifiers.length) lines.push(`Also: ${modifiers.map((m) => `${m.kind === "percent" ? `${m.value > 0 ? "+" : ""}${m.value}%` : `${m.value > 0 ? "+" : ""}${m.value}`} ${game.stats[game.statIndex.get(m.stat) ?? -1]?.name ?? m.stat}`).join(", ")}.`);
        if (raw.resources?.length) lines.push(`Uses ${raw.resources.map((r) => game.resources[game.resourceIndex.get(r) ?? -1]?.name ?? r).join(" and ")}.`);
        if (raw.spells?.length) lines.push(`Starts with ${raw.spells.map((s) => game.skills[game.skillIndex.get(typeof s === "string" ? s : s.skill) ?? -1]?.name ?? "?").join(", ")}.`);
        if (raw.look?.race) lines.push(`Looks: the ${raw.look.race} body.`);
        if (o.disciplines.length) lines.push(`Starts ${o.disciplines.map((d) => `${rules.disciplines[d.discipline].name} at ${d.level}`).join(", ")}.`);
        for (const [discipline, list] of o.unlocks) for (const u of list) lines.push(`${rules.disciplines[discipline].name}: ${unlockText(game, rules, items, u)}`);
        if (o.trees.length) lines.push(`Talents: ${o.trees.map((t) => rules.trees[t].name).join(", ")}.`);
        if (o.never.length) lines.push(`Cannot be ${o.never.map((id) => rules.origins[rules.originIndex.get(id) ?? -1]?.name ?? id).join(" or ")}.`);
        if (o.template) lines.push(`This world invented it from the template "${o.template}".`);
        return { heading: o.name, lines };
      }),
    });
  }

  // --- talents ---
  chapters.push({
    title: "Talents",
    intro: "Talent trees are spent in with points your levels give. A tier opens once enough points are spent in the tree (and sometimes at a level); some tiers let you take only one of their talents. A tree can be reset to get its points back.",
    sections: rules.trees.map((t) => ({
      heading: `${t.name} (${t.points} points${t.discipline >= 0 ? `, ${rules.disciplines[t.discipline].name}` : ""})`,
      lines: t.tiers.flatMap((tier, i) => [
        `Tier ${i + 1}${tier.requires ? `: after ${tier.requires} points spent` : ""}${tier.level ? `, at level ${tier.level}` : ""}${Number.isFinite(tier.pick) ? `, choose ${tier.pick}` : ""}.`,
        ...t.nodes.filter((n) => n.tier === i).map((n) => {
          const gives = [...n.modifiers.map((m) => modifierText(game, m, "rank")), n.skill >= 0 ? `teaches ${game.skills[n.skill].name}` : ""].filter(Boolean).join(", ");
          return `    ${n.name}${n.ranks > 1 ? ` (${n.ranks} ranks)` : ""}: ${gives}${n.requires.length ? `; needs ${n.requires.map((r) => t.nodes[r].name).join(", ")}` : ""}.`;
        }),
      ]),
    })),
  });

  // --- stats and resources ---
  chapters.push({
    title: "Stats",
    intro: "Every number a character has. Derived stats are worked out from others; anything can change them - gear, auras, talents, levels.",
    sections: [{
      heading: "Every stat",
      lines: game.stats.map((s) => [s.name, s.formula ? `= ${f(s.formula)}` : `starts at ${s.default}`, [Number.isFinite(s.min) ? `at least ${s.min}` : "", Number.isFinite(s.max) ? `at most ${s.max}` : ""].filter(Boolean).join(", ")]),
    }],
  });
  chapters.push({
    title: "Resources",
    intro: "What abilities spend, and health. Each fills from a stat and comes back over time - differently in and out of combat.",
    sections: game.resources.map((r) => ({
      heading: r.name,
      lines: [
        `Its most is your ${game.stats[r.max].name}; it starts ${r.start === 1 ? "full" : r.start === 0 ? "empty" : `at ${Math.round(r.start * 100)}%`}.`,
        `Out of combat, per second: ${f(r.regenOutOfCombat)}. In combat: ${f(r.regenInCombat)}.${r.interval ? ` It comes in ticks every ${r.interval} s.` : ""}`,
      ],
    })),
  });

  // --- combat and abilities ---
  const c = game.combat;
  chapters.push({
    title: "Combat",
    intro: `Abilities on the global cooldown wait ${c.gcd} s after each other; one asked for within ${c.queueWindow} s of being ready goes off as soon as it can. Out of combat ${c.combatTimeout} s after the last blow.`,
    sections: c.rolls.map((r) => ({
      heading: `Rolls: ${r.id}`,
      lines: [`Chance to hit: ${f(r.hit)}.`, `Chance to crit: ${f(r.crit)}, for ${f(r.critMultiplier)} times the damage.`, `Damage after armour: ${f(r.mitigate)}.`],
    })),
  });
  chapters.push({
    title: "Abilities",
    intro: "Every ability in the game: what it costs, how often, how far.",
    sections: [{
      heading: "Every ability",
      lines: game.skills
        // What a unit casts, not what those casts leave behind (a burn, a root).
        .filter((s) => !s.passive && (s.cost.length > 0 || s.cooldown.constant !== 0 || s.target === "enemy"))
        .map((s) => [s.name, s.cost.map((k) => `${f(k.amount, { level: "rank" })} ${game.resources[k.resource].name}`).join(", ") || "free", s.cooldown.constant === 0 ? "no cooldown" : `cooldown ${f(s.cooldown)} s`, s.range ? `range ${f(s.range)} m` : "", s.tags.join(" ")]),
    }],
  });
  return chapters;
}

function el(tag: string, css: string, parent?: HTMLElement, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export function createRuleBook(options: RuleBookOptions): RuleBook {
  const chapters = ruleBookChapters(options.game, options.progression, options.items);
  const root = el("div", `position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(900px, calc(100vw - 32px)); height: min(640px, calc(100vh - 80px)); display: none; z-index: 980; ${PANEL}`, document.body);
  const nav = el("div", "position: absolute; left: 0; top: 0; bottom: 0; width: 170px; padding: 14px 10px; border-right: 1px solid #554a36; overflow-y: auto;", root);
  el("div", "font-size: 18px; font-weight: 600; color: #ffd27a; margin-bottom: 10px;", nav, "Rule Book");
  const page = el("div", "position: absolute; left: 171px; right: 0; top: 0; bottom: 0; padding: 14px 20px; overflow-y: auto;", root);
  const close = el("button", "position: absolute; right: 10px; top: 8px; font: 16px sans-serif; background: none; border: none; color: #ccc; cursor: pointer;", root, "×");
  let visible = false;
  let current = 0;
  close.addEventListener("click", () => toggle());

  function show(index: number): void {
    current = index;
    page.innerHTML = "";
    const chapter = chapters[index];
    el("div", "font-size: 20px; font-weight: 600; color: #ffd27a;", page, chapter.title);
    el("p", "color: #ccc; margin: 4px 0 10px;", page, chapter.intro);
    for (const s of chapter.sections) {
      el("div", "font-size: 15px; font-weight: 600; margin: 12px 0 4px; color: #f0e2c0;", page, s.heading);
      let table: HTMLElement | null = null;
      for (const line of s.lines) {
        if (Array.isArray(line)) {
          if (!table) table = el("table", "border-collapse: collapse; font: 12px/1.4 system-ui, sans-serif; margin: 2px 0 6px;", page);
          const tr = el("tr", "", table);
          for (const cell of line) el("td", "padding: 1px 10px 1px 0; color: #ddd; vertical-align: top;", tr, cell);
        } else {
          table = null;
          el("div", `margin: 2px 0; ${line.startsWith("    ") ? "padding-left: 16px; color: #ddd;" : ""}`, page, line.trim());
        }
      }
    }
    nav.querySelectorAll("div[data-chapter]").forEach((n, i) => ((n as HTMLElement).style.color = i === index ? "#ffd27a" : "#ccc"));
  }
  chapters.forEach((chapter, i) => {
    const link = el("div", "cursor: pointer; padding: 3px 0; color: #ccc;", nav, chapter.title);
    link.dataset.chapter = String(i);
    link.addEventListener("click", () => show(i));
  });

  function toggle(): void {
    visible = !visible;
    root.style.display = visible ? "block" : "none";
    if (visible) show(current);
  }

  return {
    get visible() {
      return visible;
    },
    toggle,
    text: () => chapters.map((c) => [`# ${c.title}`, c.intro, ...c.sections.flatMap((s) => [`## ${s.heading}`, ...s.lines.map((l) => (Array.isArray(l) ? l.join(" | ") : l))])].join("\n")).join("\n\n"),
    dispose: () => root.remove(),
  };
}
