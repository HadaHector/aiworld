export interface SettingsPanelOptions {
  min: number;
  max: number;
  initial: number;
  onChange: (value: number) => void;
}

/** A small, always-visible dev-tool panel with a draw-distance slider. */
export function createSettingsPanel(options: SettingsPanelOptions): void {
  const { min, max, initial, onChange } = options;

  const container = document.createElement("div");
  container.style.cssText = `
    position: fixed; top: 16px; left: 16px; z-index: 900;
    background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;
    padding: 6px 10px; font-family: sans-serif; font-size: 11px; color: #eee;
    display: flex; align-items: center; gap: 8px;
  `;

  const label = document.createElement("span");
  label.textContent = `Draw distance: ${initial}`;
  label.style.cssText = "white-space: nowrap; min-width: 105px;";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = "10";
  slider.value = String(initial);
  slider.style.cssText = "width: 140px;";

  slider.addEventListener("input", () => {
    const value = Number(slider.value);
    label.textContent = `Draw distance: ${value}`;
    onChange(value);
  });

  container.appendChild(label);
  container.appendChild(slider);
  document.body.appendChild(container);
}
