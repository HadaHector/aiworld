import { BRONZE, CLOSE_CLASS, GOLD, PANEL as GAME_PANEL, TEXT, TITLE_FONT } from "./theme";
import type { GameRules } from "../sim/rules/gameRules";
import type { ProgressionRules, SourceDef, UnlockDef } from "../sim/rules/progressionRules";
import { formatMoney, type ItemRules } from "../sim/rules/itemRules";
import type { CompiledFormula } from "../sim/rules/formula";
import { formulaText, nameText } from "../sim/rules/formulaText";
import { changeText, indexRules, skillNames, statNames, type RuleIndex, type StatUse } from "../sim/rules/ruleIndex";
import { describeSkill } from "../sim/rules/skillText";

/**
 * The rule book (PROGRESSION.md, *The client*), on K: how this game works, written from the rules
 * the page loaded - so it is right for whatever packs and seed are running. Every stat says what reads
 * it and where it comes from, every discipline what it gives and how it rises, every ability what it
 * does and who gets it, with the own character's numbers beside them. Names link to their pages.
 */
export interface RuleBook {
  readonly visible: boolean;
  toggle: () => void;
  /** Opens the book at a topic: `stat:<id>`, `disc:<id>`, `skill:<id>`, `origin:<id>`, `tree:<id>`. */
  open: (key: string) => void;
  /** Every chapter as plain text - for the probe and the console. */
  text: () => string;
  dispose: () => void;
}

/** The own character, as far as the book shows it. */
export interface BookCharacter {
  stats: ReadonlyMap<number, number>;
  /** Discipline index to level. */
  levels: ReadonlyMap<number, number>;
  /** Origin indices it has. */
  origins: readonly number[];
}

export interface RuleBookOptions {
  game: GameRules;
  progression: ProgressionRules;
  items: ItemRules;
  /** The own character, when there is one. */
  own?: () => BookCharacter | null;
}

/** A piece of a line: text, or text that links to a topic. */
type Part = string | { text: string; key: string };
/** A line of a section: words, or a table row. */
type Line = { parts: Part[] } | { row: string[] };
interface Section {
  heading: string;
  key: string;
  lines: Line[];
}
export interface Chapter {
  title: string;
  intro: string;
  sections: Section[];
}

const PANEL = `${GAME_PANEL} font: 13px/1.55 ${TITLE_FONT};`;

const say = (...parts: Part[]): { parts: Part[] } => ({ parts });
const link = (text: string, key: string): Part => (key ? { text, key } : text);
const number = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const list = (items: Part[][], separator = ", "): Part[] => items.flatMap((item, i) => [...(i ? [separator] : []), ...item]);

/** The book's chapters, from the rules and, if given, the own character. */
export function ruleBookChapters(game: GameRules, rules: ProgressionRules, items: ItemRules, own: BookCharacter | null = null, index: RuleIndex = indexRules(game, rules, items)): Chapter[] {
  const names = statNames(game);
  const rollNames = skillNames(game);
  const f = (formula: CompiledFormula, extra: Record<string, string> = {}): string => formulaText(formula.source, { ...names, ...extra });
  const statLink = (stat: number): Part => link(game.stats[stat]?.name ?? "?", game.stats[stat] ? `stat:${game.stats[stat].id}` : "");
  const skillLink = (skill: number): Part => link(game.skills[skill]?.name ?? "?", game.skills[skill] ? `skill:${game.skills[skill].id}` : "");
  const discLink = (d: number): Part => link(rules.disciplines[d]?.name ?? "?", rules.disciplines[d] ? `disc:${rules.disciplines[d].id}` : "");
  const originLink = (o: number): Part => link(rules.origins[o].name, `origin:${rules.origins[o].id}`);
  const money = (n: number): string => formatMoney(items.currencies[items.main], n);
  const useParts = (u: StatUse): Part[] => [link(u.what, u.key), `: ${u.how}.`];
  const chapters: Chapter[] = [];
  const levelDisc = rules.disciplines[rules.config.level];

  const howText = (u: UnlockDef): string =>
    u.how === "trainer" ? `from a trainer${u.cost ? ` for ${money(u.cost)}` : ""}` : u.how === "item" ? "from a book" : u.how === "talent" ? "as a talent" : u.how === "auto" ? "learned at once" : `by ${u.how}`;
  const levelsText = (u: UnlockDef): string => {
    if (u.at) return u.at.length === 1 ? `At level ${u.at[0]}` : `At levels ${u.at.join(", ")}`;
    const until = u.to < 1000 ? ` to ${u.to}` : "";
    return u.every === 1 ? `Every level from ${u.from}${until}` : `Every ${u.every} levels from ${u.from}${until}`;
  };
  function unlockLine(u: UnlockDef, prefix: Part[] = []): Line {
    const gives: Part[][] = [];
    if (u.skill >= 0) gives.push(u.how === "auto" ? ["you learn ", skillLink(u.skill)] : [skillLink(u.skill), ` can be learned ${howText(u)}`]);
    for (const m of u.modifiers) gives.push([`${changeText(m, game, { own: "level" })} `, statLink(m.stat)]);
    for (const p of u.points) gives.push([`${p.amount} ${p.pool} point${p.amount === 1 ? "" : "s"}`]);
    if (u.resource >= 0) gives.push([`you gain ${game.resources[u.resource].name}`]);
    for (const d of u.disciplines) gives.push(["you start ", discLink(d.discipline), ` at level ${d.level}`]);
    for (const k of u.knows) gives.push([`you know ${nameText(k)}`]);
    return say(...prefix, `${levelsText(u)}: `, ...list(gives), ".");
  }
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
    const extra = { own: "its level", amount: "the amount", earners: "the number of earners", share: "your share" };
    const parts = [when[s.on] ?? s.on];
    if (s.tags.length) parts.push(`(abilities tagged ${s.tags.join(", ")})`);
    if (s.notTags.length) parts.push(`(not tagged ${s.notTags.join(", ")})`);
    if (s.weapon) parts.push(s.weapon === "none" ? "with bare hands" : `with ${"template" in s.weapon ? `a ${s.weapon.template}` : "type" in s.weapon ? s.weapon.type : `a ${s.weapon.kind}`} in hand`);
    if (s.spellSource) parts.push(s.spellSource.startsWith("origin:") ? `(only abilities your ${s.spellSource.slice(7)} gives)` : `(abilities from ${s.spellSource})`);
    if (s.periodic !== null) parts.push(s.periodic ? "(over time)" : "(not over time)");
    let line = `${parts.join(" ")}: ${f(s.amount, extra)} XP`;
    if (s.on === "kill" || s.on === "defeat") line += `; ${credit[s.credit]}`;
    if (s.when) line += `, when ${f(s.when, extra)}`;
    if (s.rate) line += `, times ${f(s.rate, extra)}`;
    return `${line}.`;
  }

  // Who gets each skill, and how: from origins, levels, talents, items and creatures.
  const getters = new Map<number, Part[][]>();
  const gets = (skill: number, ...parts: Part[]): void => {
    if (skill < 0) return;
    if (!getters.has(skill)) getters.set(skill, []);
    getters.get(skill)!.push(parts);
  };
  for (const o of rules.origins) {
    for (const s of Array.isArray(o.raw.spells) ? o.raw.spells : []) gets(game.skillIndex.get(String(typeof s === "object" && s ? (s as { skill: unknown }).skill : s)) ?? -1, originLink(o.index), " from the start");
    for (const [d, unlocks] of o.unlocks) for (const u of unlocks) if (u.skill >= 0) gets(u.skill, originLink(o.index), ` at ${rules.disciplines[d].name} ${u.at?.join(", ") ?? u.from}${u.how === "auto" ? "" : `, ${howText(u)}`}`);
  }
  for (const d of rules.disciplines) for (const u of d.unlocks) if (u.skill >= 0) gets(u.skill, "everyone at ", discLink(d.index), ` ${u.at?.join(", ") ?? u.from}`);
  for (const t of rules.trees) for (const n of t.nodes) if (n.skill >= 0) gets(n.skill, "the talent ", link(`${n.name} (${t.name})`, `tree:${t.id}`));
  for (const type of items.types) {
    if (type.use) gets(game.skillIndex.get(type.use.skill) ?? -1, `using ${type.name}`);
    if (type.equip) gets(game.skillIndex.get(type.equip.skill) ?? -1, `wearing ${type.name}`);
  }
  const creatures = new Map<number, string[]>();
  for (const [id, template] of game.templates) {
    if (id === "player" || id.startsWith("player.")) continue;
    for (const s of template.spells) {
      if (!creatures.has(s.skill)) creatures.set(s.skill, []);
      if (!creatures.get(s.skill)!.includes(template.name)) creatures.get(s.skill)!.push(template.name);
    }
  }
  for (const [skill, who] of creatures) gets(skill, who.length > 3 ? `${who.slice(0, 3).join(", ")} and ${who.length - 3} more` : who.join(", "));

  // --- your character ---
  if (own) {
    chapters.push({
      title: "Your character",
      intro: "Where you stand. Click any name for what it means.",
      sections: [
        { heading: "Who you are", key: "", lines: own.origins.map((o) => say(`${rules.origins[o].slot}: `, originLink(o))) },
        { heading: "Your disciplines", key: "", lines: [...own.levels].sort((a, b) => a[0] - b[0]).map(([d, level]) => say(discLink(d), `: level ${level}`)) },
        {
          heading: "Your stats",
          key: "",
          lines: game.stats
            .filter((s) => own.stats.has(s.index))
            .map((s) => {
              const reads = index.readBy.get(s.index) ?? [];
              const what = reads.length ? ` - for ${reads.slice(0, 3).map((u) => u.what).join(", ")}${reads.length > 3 ? "..." : ""}` : "";
              return say(statLink(s.index), `: ${number(own.stats.get(s.index)!)}${what}`);
            }),
        },
      ],
    });
  }

  // --- disciplines ---
  const discNames: Record<string, string> = { own: "its level" };
  for (const stat of game.stats) discNames[stat.id] = `your ${stat.name}`;
  for (const d of rules.disciplines) discNames[`disc.${d.id}`] = `your ${d.name}`;
  const defaults = new Float64Array(rules.disciplineScope.size);
  for (const stat of game.stats) defaults[stat.index] = stat.default;
  chapters.push({
    title: "Disciplines",
    intro: `Everything you get better at is a discipline, with its own level and XP.${levelDisc ? ` ${levelDisc.name} is your character level.` : ""} XP comes from what you do; each level may teach you abilities, make you stronger, or give points to spend on talents.`,
    sections: rules.disciplines.map((d) => {
      const lines: Line[] = [];
      const facts: string[] = [];
      const mine = own?.levels.get(d.index);
      if (mine !== undefined) facts.push(`You are level ${mine}.`);
      facts.push(d.start > 0 ? `Everyone starts at level ${d.start}.` : "You only have it once something gives it to you.");
      facts.push(`It goes up to ${formulaText(d.cap.source, discNames)}.`);
      if (d.overflow === "keep") facts.push("XP earned at the top is kept for when it can rise.");
      if (d.rate >= 0) facts.push(`Every gain is multiplied by your ${game.stats[d.rate].name}.`);
      if (d.template) facts.push(`This world made it from the template "${d.template}"${d.varNames.length ? `, rolling ${d.varNames.map((n, i) => `${n} = ${d.vars[i]}`).join(", ")}` : ""}.`);
      lines.push(say(facts.join(" ")));
      // What it does: what its levels give, and whatever reads its level.
      lines.push(say("What it does:"));
      const reads = d.stat >= 0 ? (index.readBy.get(d.stat) ?? []) : [];
      if (d.stat >= 0) lines.push(say("    Its level is your ", statLink(d.stat), "."));
      for (const u of reads) lines.push(say("    ", ...useParts(u)));
      for (const u of d.unlocks) lines.push(unlockLine(u, ["    "]));
      for (const o of rules.origins) for (const u of o.unlocks.get(d.index) ?? []) lines.push(unlockLine(u, ["    ", originLink(o.index), ": "]));
      if (!reads.length && !d.unlocks.length && !rules.origins.some((o) => o.unlocks.has(d.index))) lines.push(say("    Nothing yet: no rule reads its level, and its levels give nothing."));
      lines.push(say("How it rises:"));
      if (d.sources.length) for (const s of d.sources) lines.push(say(`    ${sourceText(s)}`));
      else lines.push(say("    Nothing gives it XP yet."));
      lines.push(say(`XP from one level to the next: ${formulaText(d.next.source, discNames)}.`));
      const row: string[] = [];
      for (let level = 1; level <= 10; level++) {
        defaults[rules.disciplineScope.own] = level;
        d.vars.forEach((v, i) => (defaults[rules.disciplineScope.vars + i] = v));
        row.push(`${level}→${level + 1}: ${Math.ceil(d.next.run(defaults))}`);
      }
      lines.push({ row });
      return { heading: `${d.name}${d.group ? ` (${d.group})` : ""}`, key: `disc:${d.id}`, lines };
    }),
  });

  // --- origins ---
  for (const slot of rules.config.slots) {
    chapters.push({
      title: `${slot.id[0].toUpperCase()}${slot.id.slice(1)}`,
      intro: `Every character has a ${slot.id}${slot.required ? "" : " or none"}; ${rules.origins[rules.originIndex.get(slot.default) ?? -1]?.name ?? "none"} if you pick none. Choose with ?${slot.id}=<id> in the address until there is a character screen.`,
      sections: rules.origins
        .filter((o) => o.slot === slot.id)
        .map((o) => {
          const lines: Line[] = [];
          const raw = o.raw as { stats?: Record<string, number>; resources?: string[]; spells?: ({ skill: string } | string)[]; look?: { race?: string }; modifiers?: { stat: string; kind?: string; value: number }[] };
          if (own?.origins.includes(o.index)) lines.push(say(`You are ${/^[AEIOU]/.test(o.name) ? "an" : "a"} ${o.name}.`));
          const stats = Object.entries(raw.stats ?? {});
          if (stats.length) lines.push(say("Stats: ", ...list(stats.map(([id, v]) => [`${v > 0 ? "+" : ""}${v} `, statLink(game.statIndex.get(id) ?? -1)])), "."));
          if (raw.modifiers?.length) lines.push(say("Also: ", ...list(raw.modifiers.map((m) => [`${m.value > 0 ? "+" : ""}${m.value}${m.kind === "percent" ? "%" : ""} `, statLink(game.statIndex.get(m.stat) ?? -1)])), "."));
          if (raw.resources?.length) lines.push(say(`Uses ${raw.resources.map((r) => game.resources[game.resourceIndex.get(r) ?? -1]?.name ?? r).join(" and ")}.`));
          if (raw.spells?.length) lines.push(say("Starts with ", ...list(raw.spells.map((s) => [skillLink(game.skillIndex.get(typeof s === "string" ? s : s.skill) ?? -1)])), "."));
          if (raw.look?.race) lines.push(say(`Looks: the ${raw.look.race} body.`));
          if (o.disciplines.length) lines.push(say("Starts ", ...list(o.disciplines.map((d) => [discLink(d.discipline), ` at ${d.level}`])), "."));
          for (const [d, unlocks] of o.unlocks) for (const u of unlocks) lines.push(unlockLine(u, [discLink(d), ": "]));
          if (o.trees.length) lines.push(say("Talents: ", ...list(o.trees.map((t) => [link(rules.trees[t].name, `tree:${rules.trees[t].id}`)])), "."));
          if (o.never.length) lines.push(say(`Cannot be ${o.never.map((id) => rules.origins[rules.originIndex.get(id) ?? -1]?.name ?? id).join(" or ")}.`));
          if (o.template) lines.push(say(`This world invented it from the template "${o.template}".`));
          return { heading: o.name, key: `origin:${o.id}`, lines };
        }),
    });
  }

  // --- talents ---
  chapters.push({
    title: "Talents",
    intro: "Talent trees are spent in with points your levels give. A tier opens once enough points are spent in the tree (and sometimes at a level); some tiers let you take only one of their talents. A tree can be reset to get its points back.",
    sections: rules.trees.map((t) => ({
      heading: `${t.name} (${t.points} points${t.discipline >= 0 ? `, ${rules.disciplines[t.discipline].name}` : ""})`,
      key: `tree:${t.id}`,
      lines: t.tiers.flatMap((tier, i): Line[] => [
        say(`Tier ${i + 1}${tier.requires ? `: after ${tier.requires} points spent` : ""}${tier.level ? `, at level ${tier.level}` : ""}${Number.isFinite(tier.pick) ? `, choose ${tier.pick}` : ""}.`),
        ...t.nodes
          .filter((n) => n.tier === i)
          .map((n) => {
            const gives: Part[][] = n.modifiers.map((m) => [`${changeText(m, game, { rank: "rank" })} `, statLink(m.stat)]);
            if (n.skill >= 0) gives.push(["teaches ", skillLink(n.skill)]);
            return say(`    ${n.name}${n.ranks > 1 ? ` (${n.ranks} ranks)` : ""}: `, ...list(gives), n.requires.length ? `; needs ${n.requires.map((r) => t.nodes[r].name).join(", ")}` : "", ".");
          }),
      ]),
    })),
  });

  // --- stats ---
  chapters.push({
    title: "Stats",
    intro: "Every number a character has: what reads it, and where more of it comes from. Derived stats are worked out from others.",
    sections: game.stats.map((s) => {
      const lines: Line[] = [];
      const facts = [s.formula ? `Worked out as ${f(s.formula)}.` : `Starts at ${s.default}.`];
      if (Number.isFinite(s.min)) facts.push(`At least ${s.min}.`);
      if (Number.isFinite(s.max)) facts.push(`At most ${s.max}.`);
      if (own?.stats.has(s.index)) facts.push(`Yours: ${number(own.stats.get(s.index)!)}.`);
      lines.push(say(facts.join(" ")));
      const reads = index.readBy.get(s.index) ?? [];
      lines.push(say(reads.length ? "What it does:" : "What it does: nothing reads it yet."));
      for (const u of reads) lines.push(say("    ", ...useParts(u)));
      const from = index.changedBy.get(s.index) ?? [];
      if (from.length) {
        lines.push(say("Where it comes from:"));
        for (const u of from) lines.push(say("    ", ...useParts(u)));
      }
      return { heading: s.name, key: `stat:${s.id}`, lines };
    }),
  });

  // --- resources and combat ---
  chapters.push({
    title: "Resources",
    intro: "What abilities spend, and health. Each fills from a stat and comes back over time - differently in and out of combat.",
    sections: game.resources.map((r) => ({
      heading: r.name,
      key: `resource:${r.id}`,
      lines: [
        say("Its most is your ", statLink(r.max), `; it starts ${r.start === 1 ? "full" : r.start === 0 ? "empty" : `at ${Math.round(r.start * 100)}%`}.`),
        say(`Out of combat, per second: ${f(r.regenOutOfCombat)}. In combat: ${f(r.regenInCombat)}.${r.interval ? ` It comes in ticks every ${r.interval} s.` : ""}`),
      ],
    })),
  });
  const c = game.combat;
  chapters.push({
    title: "Combat",
    intro: `Abilities on the global cooldown wait ${c.gcd} s after each other; one asked for within ${c.queueWindow} s of being ready goes off as soon as it can. Out of combat ${c.combatTimeout} s after the last blow.`,
    sections: c.rolls.map((r) => ({
      heading: `Rolls: ${r.id}`,
      key: "",
      lines: [say(`Chance to hit: ${f(r.hit, rollNames)}.`), say(`Chance to crit: ${f(r.crit, rollNames)}, for ${f(r.critMultiplier, rollNames)} times the damage.`), say(`Damage after armour: ${f(r.mitigate, rollNames)}.`)],
    })),
  });

  // --- abilities ---
  chapters.push({
    title: "Abilities",
    intro: "Every ability in the game: what it does and who gets it. Effects that abilities leave behind (a burn, a stun) have their own pages.",
    sections: game.skills.map((s) => ({
      heading: s.name,
      key: `skill:${s.id}`,
      lines: [...describeSkill(game, s).map((l) => say(l)), ...(getters.has(s.index) ? [say("Who gets it: ", ...list(getters.get(s.index)!, "; "), ".")] : [])],
    })),
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

const lineText = (line: Line): string => ("row" in line ? line.row.join(" | ") : line.parts.map((p) => (typeof p === "string" ? p : p.text)).join(""));

/** The chapters as plain text: for the probe and the console. */
export function chapterText(chapters: Chapter[]): string {
  return chapters.map((c) => [`# ${c.title}`, c.intro, ...c.sections.flatMap((s) => [`## ${s.heading}`, ...s.lines.map(lineText)])].join("\n")).join("\n\n");
}

export function createRuleBook(options: RuleBookOptions): RuleBook {
  const index = indexRules(options.game, options.progression, options.items);
  const build = (): Chapter[] => ruleBookChapters(options.game, options.progression, options.items, options.own?.() ?? null, index);
  let chapters = build();
  const root = el("div", `position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(920px, calc(100vw - 32px)); height: min(680px, calc(100vh - 80px)); display: none; z-index: 980; ${PANEL}`, document.body);
  const nav = el("div", `position: absolute; left: 0; top: 0; bottom: 0; width: 170px; padding: 14px 10px; box-sizing: border-box; border-right: 1px solid ${BRONZE}; overflow-y: auto; background: linear-gradient(90deg, rgba(58, 47, 29, 0.55), rgba(33, 26, 16, 0.35));`, root);
  nav.className = "game-scroll";
  const page = el("div", "position: absolute; left: 171px; right: 0; top: 0; bottom: 0; padding: 14px 20px; overflow-y: auto;", root);
  page.className = "game-scroll";
  const close = el("span", "position: absolute; right: 10px; top: 10px;", root, "×");
  close.className = CLOSE_CLASS;
  let visible = false;
  let current = 0;
  close.addEventListener("click", () => toggle());

  function drawNav(): void {
    nav.innerHTML = "";
    el("div", `font: 600 20px/1.2 ${TITLE_FONT}; color: ${GOLD}; letter-spacing: 0.05em; text-shadow: 0 1px 3px #000; margin-bottom: 12px;`, nav, "Rule Book");
    chapters.forEach((chapter, i) => {
      const item = el("div", `cursor: pointer; padding: 4px 6px; border-radius: 3px; color: ${i === current ? GOLD : TEXT}; ${i === current ? "background: rgba(240, 201, 121, 0.12); box-shadow: inset 2px 0 0 #f0c979;" : ""}`, nav, chapter.title);
      item.addEventListener("click", () => show(i));
    });
  }

  function show(chapterIndex: number, key = ""): void {
    current = chapterIndex;
    drawNav();
    page.innerHTML = "";
    const chapter = chapters[chapterIndex];
    el("div", `font: 600 22px/1.2 ${TITLE_FONT}; color: ${GOLD}; letter-spacing: 0.04em; text-shadow: 0 1px 3px #000; padding-bottom: 4px; border-bottom: 1px solid ${BRONZE};`, page, chapter.title);
    el("p", "color: #ccc; margin: 4px 0 10px;", page, chapter.intro);
    let target: HTMLElement | null = null;
    for (const s of chapter.sections) {
      const heading = el("div", `font: 600 15px/1.3 ${TITLE_FONT}; margin: 16px 0 4px; color: #f0e2c0;`, page, s.heading);
      if (key && s.key === key) {
        target = heading;
        heading.style.color = GOLD;
      }
      let table: HTMLElement | null = null;
      for (const line of s.lines) {
        if ("row" in line) {
          if (!table) table = el("table", "border-collapse: collapse; font: 12px/1.4 system-ui, sans-serif; margin: 2px 0 6px;", page);
          const tr = el("tr", "", table);
          for (const cell of line.row) el("td", "padding: 1px 10px 1px 0; color: #ddd; vertical-align: top;", tr, cell);
          continue;
        }
        table = null;
        const first = line.parts[0];
        const indent = typeof first === "string" && first.startsWith("    ");
        const div = el("div", `margin: 2px 0; ${indent ? "padding-left: 16px; color: #ddd;" : ""}`, page);
        line.parts.forEach((part, i) => {
          if (typeof part === "string") div.appendChild(document.createTextNode(i === 0 ? part.trimStart() : part));
          else {
            const a = el("span", "text-decoration: underline dotted;", div, part.text);
            a.className = "game-link";
            a.addEventListener("click", () => open(part.key));
          }
        });
      }
    }
    if (target) target.scrollIntoView({ block: "start" });
    else page.scrollTop = 0;
  }

  function open(key: string): void {
    visible = true;
    root.style.display = "block";
    chapters = build();
    const at = chapters.findIndex((c) => c.title !== "Your character" && c.sections.some((s) => s.key === key));
    show(at >= 0 ? at : 0, key);
  }

  function toggle(): void {
    visible = !visible;
    root.style.display = visible ? "block" : "none";
    if (visible) {
      chapters = build();
      show(Math.min(current, chapters.length - 1));
    }
  }

  return {
    get visible() {
      return visible;
    },
    toggle,
    open,
    text: () => chapterText(chapters),
    dispose: () => root.remove(),
  };
}
