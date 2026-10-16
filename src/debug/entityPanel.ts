import type { EntityMirror, MirroredEntity } from "../game/entityMirror";
import type { GameRules } from "../sim/rules/gameRules";
import type { ClientMessage } from "../sim/protocol";

const REFRESH_MS = 250;
/** The source the panel's buttons put their modifiers under. */
export const DEBUG_SOURCE = "debug";

export interface EntityPanelOptions {
  rules: GameRules;
  mirror: EntityMirror;
  /** The client's own player's entity id. */
  ownId: () => number;
  /** Sends a debug command to the server. */
  command: (message: ClientMessage) => void;
  /** Spawns a dummy in front of the player. */
  spawnDummy: () => void;
  /**
   * The server's own account of an entity - its full modifier stack, bases included - as lines of
   * text; null when there is no server in this page. Single player only: a client is only ever told
   * what it may see.
   */
  inspectOnServer: (id: number) => string[] | null;
}

export interface EntityPanel {
  readonly visible: boolean;
  setVisible: (on: boolean) => void;
  toggle: () => void;
  /** Shows an entity - the own player when null. */
  select: (id: number | null) => void;
  readonly selected: number | null;
  dispose: () => void;
}

const num = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/**
 * The entity inspector (see ENTITIES.md), toggled with I: the client's own player, or an entity
 * picked from the list or clicked in the world - its resources as bars, its stats as the client was
 * told them, and for its own player the modifier stack. In single player, the server's own breakdown
 * of the same entity below. Buttons send debug commands: modifiers under the source "debug", combat,
 * spending, a dummy.
 */
export function createEntityPanel(options: EntityPanelOptions): EntityPanel {
  const { rules, mirror, ownId, command } = options;
  const root = document.createElement("div");
  root.style.cssText = `
    position: fixed; top: 64px; right: 12px; width: 360px; max-height: calc(100vh - 128px); overflow-y: auto;
    background: rgba(18, 20, 24, 0.88); color: #e8e8e8; border-radius: 6px; padding: 10px 12px;
    font: 12px/1.45 system-ui, sans-serif; z-index: 20; display: none; box-shadow: 0 2px 10px rgba(0,0,0,0.4);
  `;
  const title = document.createElement("div");
  title.style.cssText = "font-weight: 600; font-size: 13px; margin-bottom: 6px; display: flex; justify-content: space-between;";
  const bars = document.createElement("div");
  const buttons = document.createElement("div");
  buttons.style.cssText = "display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0;";
  const statsBox = document.createElement("div");
  statsBox.style.cssText = "font: 11px/1.45 ui-monospace, Consolas, monospace; white-space: pre; font-variant-numeric: tabular-nums;";
  const listTitle = document.createElement("div");
  listTitle.style.cssText = "font-weight: 600; margin-top: 8px;";
  listTitle.textContent = "In view";
  const list = document.createElement("div");
  const serverTitle = document.createElement("div");
  serverTitle.style.cssText = "font-weight: 600; margin-top: 8px;";
  serverTitle.textContent = "On the server (single player only)";
  const serverBox = document.createElement("div");
  serverBox.style.cssText = statsBox.style.cssText + "white-space: pre-wrap; color: #b8c4d0;";
  root.append(title, bars, buttons, statsBox, listTitle, list, serverTitle, serverBox);
  document.body.appendChild(root);

  let selected: number | null = null;
  /** What the combat button last set - the client is not told who is in combat. */
  let combat = false;
  const target = (): number => (selected === null || selected === ownId() ? 0 : selected);
  const S = (id: string): number => rules.statIndex.get(id) ?? -1;
  const K = (id: string): number => rules.kindIndex.get(id) ?? -1;
  const R = (id: string): number => rules.resourceIndex.get(id) ?? -1;
  const shown = (): MirroredEntity | undefined => mirror.entities.get(selected ?? ownId()) ?? mirror.entities.get(ownId());

  function button(label: string, onClick: () => void, enabled = () => true): void {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "font: 11px system-ui; padding: 2px 6px; background: #2c3138; color: #e8e8e8; border: 1px solid #454c55; border-radius: 3px; cursor: pointer;";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (enabled()) onClick();
      refresh();
    });
    buttons.appendChild(b);
  }
  const modifier = (stat: string, kind: string, value: number) => () =>
    command({ type: "debugModifier", entity: target(), stat: S(stat), kind: K(kind), value, source: DEBUG_SOURCE });
  const spendFraction = (resource: string, fraction: number) => () => {
    const r = shown()?.resources.get(R(resource));
    if (r) command({ type: "debugResource", entity: target(), resource: R(resource), delta: -r.max * fraction });
  };
  button("+10 stamina", modifier("stamina", "flat", 10));
  button("+20% max health", modifier("maxHealth", "percent", 20));
  button("+50% speed", modifier("speed", "percent", 50));
  button("Remove debug", () => command({ type: "debugRemoveSource", entity: target(), source: DEBUG_SOURCE }));
  button("Combat on/off", () => {
    combat = !combat;
    command({ type: "debugCombat", entity: target(), inCombat: combat });
  });
  button("Spend 40% health", spendFraction("health", 0.4));
  button("Fill rage", () => command({ type: "debugResource", entity: target(), resource: R("rage"), delta: 1e9 }));
  button("Empty rage", spendFraction("rage", 1));
  button("Spawn dummy", options.spawnDummy);
  button("Despawn", () => {
    if (selected !== null && selected !== ownId()) command({ type: "debugDespawn", entity: selected });
    selected = null;
  });

  function bar(name: string, current: number, max: number): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "margin: 2px 0;";
    const fraction = max > 0 ? Math.min(1, current / max) : 0;
    row.innerHTML = `<div style="display:flex;justify-content:space-between"><span>${name}</span><span>${num(current)} / ${num(max)}</span></div>
      <div style="height:6px;background:#30353c;border-radius:3px"><div style="height:6px;width:${(fraction * 100).toFixed(1)}%;background:${name === "Health" ? "#4caf50" : "#5b8def"};border-radius:3px"></div></div>`;
    return row;
  }

  function refresh(): void {
    if (root.style.display === "none") return;
    const entity = shown();
    if (selected !== null && !mirror.entities.has(selected)) selected = null;
    const own = entity?.id === ownId();
    title.textContent = "";
    const name = document.createElement("span");
    name.textContent = entity ? `${entity.name} #${entity.id}${own ? " (you)" : ""}` : "No entity";
    const close = document.createElement("span");
    close.textContent = "I to close";
    close.style.cssText = "font-weight: normal; color: #888;";
    title.append(name, close);
    bars.replaceChildren(...(entity ? [...entity.resources].map(([r, v]) => bar(rules.resources[r].name, v.current, v.max)) : []));

    // Stats as told: every one for the own player, the visible ones for others; the own player's
    // modifiers listed under the stat they are on.
    const lines: string[] = [];
    if (entity) {
      for (const def of rules.stats) {
        const value = entity.stats.get(def.index);
        if (value === undefined) continue;
        lines.push(`${def.name.padEnd(16)} ${num(value).padStart(8)}`);
        for (const m of own ? entity.modifiers.filter((m) => m.stat === def.index) : []) {
          lines.push(`    ${rules.modifierKinds[m.kind].id} ${num(m.value)}  ← ${m.source}`);
        }
      }
      if (!own) lines.push("(only the stats marked visible: all)");
    }
    statsBox.textContent = lines.join("\n");

    const me = mirror.entities.get(ownId());
    const others = [...mirror.entities.values()]
      .filter((e) => e.id !== ownId())
      .map((e) => ({ e, d: me ? Math.hypot(e.x - me.x, e.z - me.z) : 0 }))
      .sort((a, b) => a.d - b.d);
    list.replaceChildren(
      ...[{ e: me, d: 0 }, ...others].filter((x) => x.e).map(({ e, d }) => {
        const row = document.createElement("div");
        const health = e!.resources.get(rules.health);
        row.textContent = `${e!.id === ownId() ? "▸ you" : `${e!.name} #${e!.id}`} · ${num(d)} m${health ? ` · ${num(health.current)}/${num(health.max)}` : ""}`;
        row.style.cssText = `cursor: pointer; padding: 1px 4px; border-radius: 3px; ${e === entity ? "background:#3a4250;" : ""}`;
        row.addEventListener("click", () => select(e!.id === ownId() ? null : e!.id));
        return row;
      }),
    );

    const fromServer = entity ? options.inspectOnServer(entity.id) : null;
    serverTitle.style.display = serverBox.style.display = fromServer ? "" : "none";
    serverBox.textContent = fromServer?.join("\n") ?? "";
  }

  function select(id: number | null): void {
    if (id !== selected) combat = false;
    selected = id;
    refresh();
  }
  function setVisible(on: boolean): void {
    root.style.display = on ? "" : "none";
    refresh();
  }
  const timer = setInterval(refresh, REFRESH_MS);
  const onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key.toLowerCase() === "i") setVisible(root.style.display === "none");
  };
  window.addEventListener("keydown", onKey);

  return {
    get visible() {
      return root.style.display !== "none";
    },
    setVisible,
    toggle: () => setVisible(root.style.display === "none"),
    select,
    get selected() {
      return selected;
    },
    dispose: () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
      root.remove();
    },
  };
}
