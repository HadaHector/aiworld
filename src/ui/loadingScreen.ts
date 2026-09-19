export interface LoadingScreen {
  /** `total` of 0 means "no countable steps" - the bar shows an indeterminate sweep instead. */
  update: (phase: string, completed: number, total: number) => void;
  hide: () => void;
}

/**
 * The startup overlay. It is written into the page by index.html rather than created here, so it is
 * on screen from the very first paint - building it in TypeScript would leave the user looking at a
 * blank canvas for however long the module graph takes to load and parse.
 */
export function createLoadingScreen(): LoadingScreen {
  const root = document.getElementById("loadingScreen");
  const label = document.getElementById("loadingPhase");
  const bar = document.getElementById("loadingBar");

  function update(phase: string, completed: number, total: number): void {
    if (label) {
      label.textContent = total > 0 ? `${phase}  ${completed}/${total}` : phase;
    }
    if (bar) {
      const determinate = total > 0;
      bar.classList.toggle("indeterminate", !determinate);
      bar.style.width = determinate ? `${Math.round((completed / total) * 100)}%` : "100%";
    }
  }

  function hide(): void {
    if (!root) return;
    root.classList.add("hidden");
    // Left in the DOM for the length of the fade, then removed so it can never swallow a click.
    window.setTimeout(() => root.remove(), 450);
  }

  return { update, hide };
}
