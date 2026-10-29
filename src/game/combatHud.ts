import type { EntityMirror, MirroredEntity } from "./entityMirror";
import { BAR_COLOURS, BAR_TEXT, BAR_TRACK, BUTTON_CLASS, GOLD, PANEL, QUIET_PANEL, TITLE_FONT, barFill } from "../ui/theme";
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
  /** Where the action bar goes (ui/actionBar.ts): between the cast bar and the XP bar. */
  readonly barSlot: HTMLElement;
  dispose: () => void;
}

export interface CombatHudOptions {
  rules: GameRules;
  mirror: EntityMirror;
  ownId: () => number;
  onRespawn: () => void;
  /** Where its parts go (ui/hud.ts): the unit frames, the cast, spell and XP bars, the log. */
  regions: { frames: HTMLElement; actions: HTMLElement; log: HTMLElement };
  /** The own level's XP (PROGRESSION.md), as a share of the way to the next level, for a thin bar
   *  under the own frame - null to show none. */
  experience?: () => { label: string; fraction: number } | null;
}

const LOG_LINES = 14;
const barColour = (id: string): string => BAR_COLOURS[id] ?? "#7a7a7a";

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

const NAME = `font: 600 13px/1.2 ${TITLE_FONT}; color: ${GOLD}; letter-spacing: 0.02em; text-shadow: 0 1px 2px #000;`;

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

function makeFrame(parent: HTMLElement): Frame {
  const root = el("div", `width: 250px; padding: 7px 9px; display: none; box-sizing: border-box; ${PANEL}`, parent);
  const name = el("div", `${NAME} margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`, root);
  const bars = el("div", "", root);
  const cast = el("div", `${BAR_TRACK} height: 14px; margin-top: 5px; display: none;`, root);
  const castFill = el("div", barFill(BAR_COLOURS.cast), cast);
  const castText = el("div", `${BAR_TEXT} font-size: 10px; line-height: 14px;`, cast);
  const auras = el("div", "display: flex; flex-wrap: wrap; gap: 3px; margin-top: 5px;", root);
  const xp = el("div", `${BAR_TRACK} height: 5px; margin-top: 4px; display: none;`, root);
  const xpFill = el("div", `${barFill(BAR_COLOURS.xp)} transition: width 0.3s;`, xp);
  return { root, name, bars, cast, castFill, castText, auras, xp, xpFill };
}

export function createCombatHud(options: CombatHudOptions): CombatHud {
  const { rules, mirror, ownId } = options;
  const { regions } = options;
  const ownFrame = makeFrame(regions.frames);
  const targetFrame = makeFrame(regions.frames);

  // The own cast bar, above the spell bar.
  const castBar = el("div", `${BAR_TRACK} width: 280px; height: 18px; display: none; margin-bottom: 6px;`, regions.actions);
  const castFill = el("div", barFill(BAR_COLOURS.cast), castBar);
  const castText = el("div", `${BAR_TEXT} font-size: 11px; line-height: 18px;`, castBar);

  // The action bar's place (ui/actionBar.ts fills it).
  const bar = el("div", "", regions.actions);
  // The XP bar under it (PROGRESSION.md): the character level's progress, as wide as the spell bar.
  const xpBar = el("div", `${BAR_TRACK} width: 280px; height: 12px; display: none;`, regions.actions);
  const xpBarFill = el("div", `${barFill(BAR_COLOURS.xp)} transition: width 0.3s;`, xpBar);
  const xpBarText = el("div", `${BAR_TEXT} font-size: 9px; line-height: 12px; font-weight: 600;`, xpBar);

  // The combat log.
  const logBox = el("div", `width: 100%; box-sizing: border-box; padding: 6px 8px; ${QUIET_PANEL} white-space: pre-wrap; overflow: hidden; color: #d8ceb6;`, regions.log);
  const logLines: string[] = [];

  // Dead: a button to come back.
  const deadBox = el("div", `position: fixed; left: 50%; top: 35%; transform: translateX(-50%); padding: 14px 24px; z-index: 950; display: none; text-align: center; ${PANEL}`, document.body);
  el("div", `font: 600 20px/1.3 ${TITLE_FONT}; color: #e06a5a; letter-spacing: 0.04em; text-shadow: 0 1px 3px #000; margin-bottom: 10px;`, deadBox).textContent = "You have died.";
  const respawn = el("button", "font-size: 12px; padding: 5px 16px;", deadBox);
  respawn.className = BUTTON_CLASS;
  respawn.textContent = "Respawn";
  respawn.addEventListener("click", () => options.onRespawn());


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
      const row = el("div", `${BAR_TRACK} height: 15px; margin: 3px 0;`, frame.bars);
      el("div", `${barFill(barColour(def.id))} width: ${(100 * value.current) / value.max}%;`, row);
      el("div", `${BAR_TEXT} font-size: 10px; line-height: 15px;`, row).textContent = `${def.name} ${Math.round(value.current)} / ${Math.round(value.max)}`;
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
    frame.name.style.color = hostile ? "#ff8a7a" : neutral ? "#ffe27a" : GOLD;
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
        el("span", `padding: 1px 6px; border-radius: 3px; font-size: 10px; border: 1px solid ${chip.debuff ? "#b0453a" : "#4a86b0"}; background: ${chip.debuff ? "linear-gradient(#6b2320, #3e1210)" : "linear-gradient(#1f4d6b, #102a3e)"}; box-shadow: 0 0 0 1px #000;`, frame.auras).textContent = chip.label;
      }
    }
  }

  return {
    barSlot: bar,
    update(targetId) {
      const now = mirror.serverTime();
      const own = mirror.entities.get(ownId());
      drawFrame(ownFrame, own, now, false);
      const experience = options.experience?.() ?? null;
      ownFrame.xp.style.display = experience ? "block" : "none";
      if (experience) {
        ownFrame.xpFill.style.width = `${Math.round(Math.min(1, experience.fraction) * 1000) / 10}%`;
        ownFrame.xp.title = experience.label;
        xpBarFill.style.width = ownFrame.xpFill.style.width;
        text(xpBarText, experience.label);
        const width = `${Math.max(200, bar.offsetWidth)}px`;
        if (xpBar.style.width !== width) xpBar.style.width = width;
      }
      xpBar.style.display = experience ? "block" : "none";
      drawFrame(targetFrame, targetId ? mirror.entities.get(targetId) : undefined, now, true);
      // The own cast bar.
      if (own?.cast) {
        const done = Math.min(1, Math.max(0, (now - own.cast.start) / Math.max(own.cast.length, 1e-6)));
        castBar.style.display = "block";
        castFill.style.width = `${(own.cast.channel ? 1 - done : done) * 100}%`;
        text(castText, `${rules.skills[own.cast.skill]?.name ?? "?"}  ${Math.max(0, own.cast.start + own.cast.length - now).toFixed(1)}`);
      } else castBar.style.display = "none";
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
      // A short log (the HUD caps its height on small screens) shows the newest lines.
      logBox.scrollTop = logBox.scrollHeight;
    },
    dispose() {
      for (const e of [ownFrame.root, targetFrame.root, castBar, bar, xpBar, logBox, deadBox]) e.remove();
    },
  };
}
