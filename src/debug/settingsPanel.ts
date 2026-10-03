export interface SettingsToggle {
  label: string;
  initial: boolean;
  onChange: (on: boolean) => void;
}

export interface SettingsSlider {
  label: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  /** Formats the live value for the label - e.g. hours into a clock face. Defaults to the raw
   *  number, same as the draw-distance slider has always shown. */
  format?: (value: number) => string;
  onChange: (value: number) => void;
}

export interface SettingsSelect {
  label: string;
  options: { value: string; label: string }[];
  initial: string;
  onChange: (value: string) => void;
}

export interface SettingsPanelOptions {
  min: number;
  max: number;
  initial: number;
  onChange: (value: number) => void;
  toggles?: SettingsToggle[];
  /** Additional sliders beyond the built-in draw-distance one - each gets its own label + input,
   *  laid out the same way. */
  sliders?: SettingsSlider[];
  /** Drop-down choices, after the sliders. */
  selects?: SettingsSelect[];
}

/** A small, always-visible dev-tool panel with a draw-distance slider and any switches handed to it. */
export function createSettingsPanel(options: SettingsPanelOptions): void {
  const { min, max, initial, onChange, toggles = [], sliders = [], selects = [] } = options;

  const container = document.createElement("div");
  container.style.cssText = `
    position: fixed; top: 16px; left: 16px; z-index: 900;
    background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;
    padding: 6px 10px; font-family: sans-serif; font-size: 11px; color: #eee;
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
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

  for (const extra of sliders) {
    const extraLabel = document.createElement("span");
    const format = extra.format ?? ((value: number) => String(value));
    extraLabel.textContent = `${extra.label}: ${format(extra.initial)}`;
    extraLabel.style.cssText = "white-space: nowrap; min-width: 105px;";

    const extraSlider = document.createElement("input");
    extraSlider.type = "range";
    extraSlider.min = String(extra.min);
    extraSlider.max = String(extra.max);
    extraSlider.step = String(extra.step);
    extraSlider.value = String(extra.initial);
    extraSlider.style.cssText = "width: 140px;";

    extraSlider.addEventListener("input", () => {
      const value = Number(extraSlider.value);
      extraLabel.textContent = `${extra.label}: ${format(value)}`;
      extra.onChange(value);
    });

    container.appendChild(extraLabel);
    container.appendChild(extraSlider);
  }

  for (const choice of selects) {
    const wrapper = document.createElement("label");
    wrapper.style.cssText = "display: flex; align-items: center; gap: 4px; white-space: nowrap;";
    const select = document.createElement("select");
    select.style.cssText = "font-size: 11px;";
    for (const option of choice.options) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    }
    select.value = choice.initial;
    select.addEventListener("change", () => choice.onChange(select.value));
    wrapper.appendChild(document.createTextNode(`${choice.label}:`));
    wrapper.appendChild(select);
    container.appendChild(wrapper);
  }

  for (const toggle of toggles) {
    const wrapper = document.createElement("label");
    wrapper.style.cssText = "display: flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap;";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = toggle.initial;
    box.style.cssText = "margin: 0;";
    box.addEventListener("change", () => toggle.onChange(box.checked));
    wrapper.appendChild(box);
    wrapper.appendChild(document.createTextNode(toggle.label));
    container.appendChild(wrapper);
  }

  document.body.appendChild(container);
}
