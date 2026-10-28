import type { EntityMirror, MirroredEntity } from "./entityMirror";
import { PLAYER_TEMPLATE, type GameRules } from "../sim/rules/gameRules";
import type { CombatEvent } from "../sim/protocol";
import { describeEvent } from "../sim/skills/combatLog";
import { EVENT_KIND } from "../sim/skills/events";
import { FLAG, FLAG_NAMES } from "../sim/skills/flags";

/**
 * The combat HUD of ABILITIES.md's test - minimal, until step 10's real screens: the own unit frame
 * and the target's (name, level, health and the rest, cast bar, buffs and debuffs, flags), the own
 * cast bar, a bar of the spells the player knows on keys 1-9 with their cooldowns, a combat log, and
 * a respawn button when dead. Everything it shows comes from the mirror and the events.
 */
export interface CombatHud {
  /** Redraws from the mirror - each frame. */
  update: (target: number) => void;
  /** Adds the events of a step to the log. */
  log: (events: readonly CombatEvent[]) => void;
  /** The skills on keys 1-9, in the order the player knows them: passives left out. */
  readonly keys: () => number[];
  dispose: () => void;
}

export interface CombatHudOptions {
  rules: GameRules;
  mirror: EntityMirror;
  ownId: () => number;
  /** Casts the spell on key n. */
  onKey: (skill: number) => void;
  onRespawn: () => void;
  /** The own level's XP (PROGRESSION.md), as a share of the way to the next level, for a thin bar
   *  under the own frame - null to show none. */
  experience?: () => { label: string; fraction: number } | null;
}

const LOG_LINES = 14;
const RESOURCE_COLOURS: Record<string, string> = { health: "#3fb04a", mana: "#3a6fd8", rage: "#c43b2e" };

function el(tag: string, css: string, parent?: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  parent?.appendChild(e);
  return e;
}

/** Sets text only when it changed: the HUD redraws every frame. */
function text(e: HTMLElement, value: string): void {
  if (e.textContent !== value) e.textContent = value;
}

const PANEL = "background: rgba(18, 20, 24, 0.82); color: #eee; border-radius: 6px; font: 12px/1.35 system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,0.4);";

interface Frame {
  root: HTMLElement;
  name: HTMLElement;
  bars: HTMLElement;
  cast: HTMLElement;
  castFill: HTMLElement;
  castText: HTMLElement;
  auras: HTMLElement;
  xp: HTMLElement;
  xpFill: HTMLElement;
}

function makeFrame(left: string): Frame {
  // Its top is set each frame (see `frameTop`).
  const root = el("div", `position: fixed; top: 60px; left: ${left}; width: 250px; padding: 6px 8px; z-index: 900; display: none; ${PANEL}`, document.body);
  const name = el("div", "font-weight: 600; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;", root);
  const bars = el("div", "", root);
  const cast = el("div", "position: relative; height: 14px; margin-top: 4px; background: #333; border-radius: 3px; overflow: hidden; display: none;", root);
  const castFill = el("div", "position: absolute; left: 0; top: 0; bottom: 0; background: #d8a630;", cast);
  const castText = el("div", "position: absolute; inset: 0; text-align: center; font-size: 11px; line-height: 14px; color: #fff; text-shadow: 0 1px 1px #000;", cast);
  const auras = el("div", "display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px;", root);
  const xp = el("div", "position: relative; height: 5px; margin-top: 3px; background: #2a2a2a; border-radius: 2px; overflow: hidden; display: none;", root);
  const xpFill = el("div", "position: absolute; left: 0; top: 0; bottom: 0; background: #8a5ad8; transition: width 0.3s;", xp);
  return { root, name, bars, cast, castFill, castText, auras, xp, xpFill };
}

/** Where the unit frames sit: just under the settings bar at the top, when the window is wide
 *  enough for them to clear the debug panels down the left (about 330 px wide); else below those
 *  panels, which reach about 200 px down. */
function frameTop(): string {
  return window.innerWidth / 2 - 270 >= 340 ? "60px" : "206px";
}

export function createCombatHud(options: CombatHudOptions): CombatHud {
  const { rules, mirror, ownId } = options;
  const ownFrame = makeFrame("calc(50% - 270px)");
  const targetFrame = makeFrame("calc(50% + 20px)");

  // The own cast bar, above the spell bar.
  const castBar = el("div", `position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); width: 280px; height: 18px; z-index: 900; display: none; ${PANEL} background: #222; overflow: hidden;`, document.body);
  const castFill = el("div", "position: absolute; left: 0; top: 0; bottom: 0; background: #d8a630;", castBar);
  const castText = el("div", "position: absolute; inset: 0; text-align: center; font-size: 12px; line-height: 18px; color: #fff; text-shadow: 0 1px 1px #000;", castBar);

  // The spell bar.
  const bar = el("div", "position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; gap: 4px; z-index: 900;", document.body);
  const slots: { root: HTMLElement; cool: HTMLElement; label: HTMLElement; skill: number }[] = [];

  // The combat log.
  const logBox = el("div", `position: fixed; left: 16px; bottom: 16px; width: 400px; padding: 6px 8px; z-index: 900; ${PANEL} font-size: 11px; white-space: pre-wrap;`, document.body);
  const logLines: string[] = [];

  // Dead: a button to come back.
  const deadBox = el("div", `position: fixed; left: 50%; top: 35%; transform: translateX(-50%); padding: 12px 18px; z-index: 950; display: none; text-align: center; ${PANEL}`, document.body);
  el("div", "font-size: 16px; font-weight: 600; margin-bottom: 8px;", deadBox).textContent = "You have died.";
  const respawn = el("button", "font: inherit; padding: 4px 12px; cursor: pointer;", deadBox);
  respawn.textContent = "Respawn";
  respawn.addEventListener("click", () => options.onRespawn());

  const keys = (): number[] => mirror.own.spells.filter((s) => !rules.skills[s.skill]?.passive).map((s) => s.skill).slice(0, 9);

  function drawBars(frame: Frame, entity: MirroredEntity): void {
    const rows: string[] = [];
    for (const [index, value] of entity.resources) {
      const def = rules.resources[index];
      if (!def || value.max <= 0) continue;
      rows.push(`${def.id}:${Math.round(value.current)}/${Math.round(value.max)}`);
    }
    const signature = rows.join("|");
    if (frame.bars.dataset.sig === signature) return;
    frame.bars.dataset.sig = signature;
    frame.bars.innerHTML = "";
    for (const [index, value] of entity.resources) {
      const def = rules.resources[index];
      if (!def || value.max <= 0) continue;
      const row = el("div", "position: relative; height: 14px; margin: 2px 0; background: #2a2a2a; border-radius: 3px; overflow: hidden;", frame.bars);
      el("div", `position: absolute; left: 0; top: 0; bottom: 0; width: ${(100 * value.current) / value.max}%; background: ${RESOURCE_COLOURS[def.id] ?? "#888"};`, row);
      el("div", "position: absolute; inset: 0; text-align: center; font-size: 11px; line-height: 14px; text-shadow: 0 1px 1px #000;", row).textContent = `${def.name} ${Math.round(value.current)} / ${Math.round(value.max)}`;
    }
  }

  function drawFrame(frame: Frame, entity: MirroredEntity | undefined, now: number, target: boolean): void {
    if (!entity) {
      frame.root.style.display = "none";
      return;
    }
    frame.root.style.display = "block";
    const level = entity.stats.get(rules.statIndex.get("level") ?? -1);
    const flags = FLAG_NAMES.filter((_, i) => entity.flags & (1 << i) && i < 8);
    const hostile = target && entity.template?.hostility === "hostile";
    const neutral = target && entity.template?.hostility === "neutral" && entity.templateId !== PLAYER_TEMPLATE;
    frame.name.style.color = hostile ? "#ff8a7a" : neutral ? "#ffe27a" : "#eee";
    text(frame.name, `${entity.name}${level !== undefined ? ` · level ${level}` : ""}${flags.length ? ` · ${flags.join(", ")}` : ""}`);
    drawBars(frame, entity);
    // Cast bar.
    if (entity.cast) {
      const done = Math.min(1, Math.max(0, (now - entity.cast.start) / Math.max(entity.cast.length, 1e-6)));
      frame.cast.style.display = "block";
      frame.castFill.style.width = `${(entity.cast.channel ? 1 - done : done) * 100}%`;
      text(frame.castText, `${rules.skills[entity.cast.skill]?.name ?? "?"} ${Math.max(0, entity.cast.start + entity.cast.length - now).toFixed(1)}`);
    } else frame.cast.style.display = "none";
    // Buffs and debuffs: a chip each, with stacks and seconds left.
    const chips = entity.auras.map((a) => {
      const skill = rules.skills[a.skill];
      const left = a.ends > 0 ? Math.max(0, a.ends - now) : 0;
      return { debuff: skill?.display === "debuff", label: `${skill?.name ?? "?"}${a.stacks > 1 ? ` ×${a.stacks}` : ""}${a.ends > 0 ? ` ${left.toFixed(0)}s` : ""}` };
    });
    const signature = chips.map((c) => c.label).join("|");
    if (frame.auras.dataset.sig !== signature) {
      frame.auras.dataset.sig = signature;
      frame.auras.innerHTML = "";
      for (const chip of chips) {
        el("span", `padding: 1px 5px; border-radius: 3px; font-size: 10px; background: ${chip.debuff ? "#6b2320" : "#1f4d6b"};`, frame.auras).textContent = chip.label;
      }
    }
  }

  function drawSpellBar(now: number): void {
    const skills = keys();
    if (slots.length !== skills.length || slots.some((s, i) => s.skill !== skills[i])) {
      bar.innerHTML = "";
      slots.length = 0;
      skills.forEach((skill, i) => {
        const root = el("div", `position: relative; width: 64px; height: 46px; ${PANEL} cursor: pointer; overflow: hidden; text-align: center;`, bar);
        el("div", "position: absolute; left: 4px; top: 2px; font-size: 10px; color: #aaa;", root).textContent = String(i + 1);
        const label = el("div", "position: absolute; left: 2px; right: 2px; top: 14px; font-size: 10px; line-height: 1.15;", root);
        label.textContent = rules.skills[skill]?.name ?? "?";
        const cool = el("div", "position: absolute; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); font-size: 11px; line-height: 46px;", root);
        root.addEventListener("click", () => options.onKey(skill));
        slots.push({ root, cool, label, skill });
      });
    }
    const own = mirror.own;
    const ownEntity = mirror.entities.get(ownId());
    for (const slot of slots) {
      const spell = own.spells.find((s) => s.skill === slot.skill);
      const def = rules.skills[slot.skill];
      const gcd = def && def.gcd !== "none" ? own.gcdUntil : 0;
      const until = Math.max(spell?.ready ?? 0, gcd);
      const left = until - now;
      // Greyed when the cost cannot be paid - from what the mirror has of the own resources.
      const short = def?.cost.some((c) => c.amount.constant !== null && (ownEntity?.resources.get(c.resource)?.current ?? 0) < c.amount.constant);
      slot.root.style.opacity = short ? "0.5" : "1";
      if (left > 0.05) {
        slot.cool.style.height = "100%";
        text(slot.cool, left > 1.6 ? left.toFixed(0) : "");
      } else {
        slot.cool.style.height = "0";
        text(slot.cool, "");
      }
    }
  }

  return {
    update(targetId) {
      const top = frameTop();
      if (ownFrame.root.style.top !== top) ownFrame.root.style.top = targetFrame.root.style.top = top;
      const now = mirror.serverTime();
      const own = mirror.entities.get(ownId());
      drawFrame(ownFrame, own, now, false);
      const experience = options.experience?.() ?? null;
      ownFrame.xp.style.display = experience ? "block" : "none";
      if (experience) {
        ownFrame.xpFill.style.width = `${Math.round(Math.min(1, experience.fraction) * 1000) / 10}%`;
        ownFrame.xp.title = experience.label;
      }
      drawFrame(targetFrame, targetId ? mirror.entities.get(targetId) : undefined, now, true);
      // The own cast bar.
      if (own?.cast) {
        const done = Math.min(1, Math.max(0, (now - own.cast.start) / Math.max(own.cast.length, 1e-6)));
        castBar.style.display = "block";
        castFill.style.width = `${(own.cast.channel ? 1 - done : done) * 100}%`;
        text(castText, `${rules.skills[own.cast.skill]?.name ?? "?"}  ${Math.max(0, own.cast.start + own.cast.length - now).toFixed(1)}`);
      } else castBar.style.display = "none";
      drawSpellBar(now);
      deadBox.style.display = own && own.flags & (1 << FLAG.dead) ? "block" : "none";
    },
    log(events) {
      const nameOf = (id: number) => mirror.entities.get(id)?.name ?? `#${id}`;
      for (const event of events) {
        // Swings and visual effects are seen, not read.
        if (event.kind === EVENT_KIND.animation || event.kind === EVENT_KIND.effect) continue;
        logLines.push(describeEvent(rules, event, nameOf));
      }
      if (logLines.length > LOG_LINES) logLines.splice(0, logLines.length - LOG_LINES);
      text(logBox, logLines.join("\n") || "Combat log");
    },
    keys,
    dispose() {
      for (const e of [ownFrame.root, targetFrame.root, castBar, bar, logBox, deadBox]) e.remove();
    },
  };
}
