export interface LoadingScreen {
  /** `total` of 0 means "no countable steps" - the bar shows an indeterminate sweep instead. */
  update: (phase: string, completed: number, total: number) => void;
  hide: () => void;
  /** Puts it back over everything - for travelling to another dimension (see DIMENSIONS.md). */
  show: () => void;
  /** Stops on a failure: `title` in place of the phase, and `lines` listed under it. */
  fail: (title: string, lines: string[]) => void;
  /** A line under the title - "Entering Oakvale as Brynja" - or "" for none. */
  setHeading: (text: string) => void;
  /** Where a failure can go back to: a button under it that calls this (and puts the screen back
   *  as it was); null for none - a failure then stays. */
  onBack: (back: (() => void) | null) => void;
}

/**
 * The startup overlay - and the one shown while travelling between dimensions. It is written into
 * the page by index.html rather than created here, so it is on screen from the very first paint -
 * building it in TypeScript would leave the user looking at a blank canvas for however long the
 * module graph takes to load and parse.
 */
/** The page's own title, without the "(loading)" index.html starts it with. */
const TITLE = "aiworld";

export function createLoadingScreen(): LoadingScreen {
  const root = document.getElementById("loadingScreen");
  let phaseName = "";
  let phaseStart = performance.now();
  const label = document.getElementById("loadingPhase");
  const bar = document.getElementById("loadingBar");
  /** When it was last shown: the times it reads out count from here. */
  let shownAt = 0;
  let hideTimer = 0;
  // Made here rather than in index.html: only the front end uses them.
  const heading = document.createElement("div");
  heading.style.cssText = "font-size: 15px; letter-spacing: 0.08em; opacity: 0.8; min-height: 1.4em;";
  document.getElementById("loadingTitle")?.after(heading);
  const backButton = document.createElement("button");
  backButton.textContent = "Back to menu";
  backButton.style.cssText = "display: none; font: 13px system-ui, sans-serif; padding: 6px 14px; cursor: pointer; background: #2b3a4a; color: #dfe6ee; border: 1px solid #5a7088; border-radius: 3px;";
  root?.appendChild(backButton);
  let back: (() => void) | null = null;
  backButton.addEventListener("click", () => {
    const go = back;
    root?.classList.remove("failed");
    backButton.style.display = "none";
    const errors = document.getElementById("loadingErrors");
    if (errors) errors.textContent = "";
    go?.();
  });

  function update(phase: string, completed: number, total: number): void {
    // Each phase's time in the console, for seeing where a slow start goes.
    if (phase !== phaseName) {
      const now = performance.now();
      if (phaseName) console.info(`[loading] ${phaseName}: ${((now - phaseStart) / 1000).toFixed(2)} s`);
      phaseName = phase;
      phaseStart = now;
    }
    const elapsed = `${((performance.now() - shownAt) / 1000).toFixed(1)} s`;
    if (label) {
      label.textContent = total > 0 ? `${phase}  ${completed}/${total}  ·  ${elapsed}` : `${phase}  ·  ${elapsed}`;
    }
    if (bar) {
      const determinate = total > 0;
      bar.classList.toggle("indeterminate", !determinate);
      bar.style.width = determinate ? `${Math.round((completed / total) * 100)}%` : "100%";
    }
  }

  function hide(): void {
    if (phaseName) console.info(`[loading] ${phaseName}: ${((performance.now() - phaseStart) / 1000).toFixed(2)} s - ready after ${((performance.now() - shownAt) / 1000).toFixed(1)} s`);
    phaseName = "";
    document.title = TITLE;
    if (!root) return;
    root.classList.add("hidden");
    // Shown for the length of the fade, then taken out of the layout so it can never swallow a click.
    hideTimer = window.setTimeout(() => (root.style.display = "none"), 450);
  }

  function show(): void {
    shownAt = performance.now();
    document.title = `${TITLE} (loading)`;
    if (!root) return;
    clearTimeout(hideTimer);
    root.style.display = "";
    root.classList.remove("hidden");
  }

  function fail(title: string, lines: string[]): void {
    document.title = `${TITLE} (failed to load)`;
    root?.classList.add("failed");
    if (label) label.textContent = title;
    const errors = document.getElementById("loadingErrors");
    if (errors) errors.textContent = lines.join("\n");
  }

  return {
    update,
    hide,
    show,
    fail(title, lines) {
      fail(title, lines);
      if (back) backButton.style.display = "";
    },
    setHeading: (text) => void (heading.textContent = text),
    onBack: (handler) => void (back = handler),
  };
}
