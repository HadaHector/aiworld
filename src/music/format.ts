// Tracker-style text for cells and patterns: what the music page's grid shows and what the probe
// prints. Notes "C#4", note-off "===", volume 00-64 as in XM, effects by their XM letter.

import type { Cell, Effect, Pattern, Song } from "./song";
import { noteName } from "./theory";

export function noteText(cell: Cell | undefined): string {
  if (cell?.note === "off") return "===";
  if (cell?.note === undefined) return "...";
  const name = noteName(cell.note);
  return name.length === 2 ? `${name[0]}-${name[1]}` : name;
}

export function volumeText(cell: Cell | undefined): string {
  return cell?.volume === undefined ? ".." : String(Math.round(cell.volume * 64)).padStart(2, "0");
}

const signed = (n: number, digits = 1): string => (n >= 0 ? "+" : "") + n.toFixed(digits);

export function effectText(effect: Effect): string {
  switch (effect.type) {
    case "arpeggio":
      return `0${effect.x.toString(16)}${effect.y.toString(16)}`;
    case "portamento":
      return `${effect.perTick >= 0 ? 1 : 2}${Math.abs(effect.perTick).toFixed(2)}`;
    case "tonePortamento":
      return `3${effect.perTick.toFixed(2)}`;
    case "vibrato":
      return `4${effect.depth.toFixed(1)}/${effect.rate}`;
    case "tremolo":
      return `7${effect.depth.toFixed(1)}/${effect.rate}`;
    case "volumeSlide":
      return `A${signed(effect.perTick * 64, 2)}`;
    case "noteDelay":
      return `ED${effect.ticks}`;
    case "noteCut":
      return `EC${effect.ticks}`;
    case "retrigger":
      return `E9${effect.every}`;
    case "slideIn":
      return `S${signed(effect.semis, 0)}`;
  }
}

export function effectsText(cell: Cell | undefined): string {
  return cell?.effects?.map(effectText).join(" ") ?? "";
}

/** Instrument ids to their two-letter names. */
export type ShortNames = Record<string, string>;

export function cellText(cell: Cell | undefined, shorts: ShortNames): string {
  const instrument = cell?.instrument ? (shorts[cell.instrument] ?? "??") : "..";
  const effects = effectsText(cell).padEnd(6).slice(0, 6);
  return `${noteText(cell)} ${instrument} ${volumeText(cell)} ${effects || "......"}`;
}

export function patternText(song: Song, pattern: Pattern, shorts: ShortNames): string {
  const lines = [`${pattern.section}  ${pattern.chords.map((c) => c.name).join(" ")}`];
  lines.push("   | " + song.channels.map((c) => c.name.padEnd(16).slice(0, 16)).join(" | "));
  for (let row = 0; row < pattern.rows; row++) {
    const cells = pattern.cells[row].map((cell) => cellText(cell, shorts).padEnd(16));
    lines.push(String(row).padStart(2, "0") + " | " + cells.join(" | "));
  }
  return lines.join("\n");
}
