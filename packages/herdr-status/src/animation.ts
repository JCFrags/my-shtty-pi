import { sanitizeVisible } from "./sanitize.ts";
import type { ProfileId } from "./settings-types.ts";

export type ActivityKind = "thinking" | "writing" | "compacting" | "bash" | "editing" | "reading" | "searching" | "tool";
export interface Activity {
  kind: ActivityKind;
  label: string;
}

export interface AnimationProfile {
  id: ProfileId;
  name: string;
  description: string;
}

export const PROFILES: readonly AnimationProfile[] = [
  { id: "smart", name: "Smart Activity", description: "Phase-aware spark, wave, scanner, pencil, terminal, and compaction effects" },
  { id: "minimal", name: "Minimal", description: "Quiet Braille, pulse, and compact shrinking animations" },
  { id: "arcade", name: "Arcade", description: "Pac-Man chases, Knight Rider sweeps, and retro movement" },
  { id: "cosmic", name: "Cosmic", description: "Comets, orbital motion, moon phases, DNA, and a compaction black hole" },
  { id: "playful", name: "Playful", description: "Nyan-style cat, tiny train, books-to-sparkles compaction, and cheerful motion" },
  { id: "terminal", name: "Terminal", description: "Typewriter, cursor, scanner, Braille, and archive-style compaction" },
  { id: "context", name: "Context Pressure", description: "A live context-density meter that contracts during compaction" },
  { id: "surprise", name: "Surprise Me", description: "Rotates through the animated profiles during each run" },
  { id: "still", name: "Still", description: "No motion; retain activity labels, elapsed time, and context" },
];

const FX = {
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  pulse: ["·", "•", "●", "✦", "●", "•"],
  wave: ["▁▂▃▄▅", "▂▃▄▅▆", "▃▄▅▆▇", "▄▅▆▇█", "▃▄▅▆▇", "▂▃▄▅▆"],
  thinking: ["[✦···]", "[·✦··]", "[··✦·]", "[···✦]", "[··✦·]", "[·✦··]"],
  reading: ["[▰▱▱▱]", "[▱▰▱▱]", "[▱▱▰▱]", "[▱▱▱▰]", "[▱▱▰▱]", "[▱▰▱▱]"],
  writing: ["[✎···]", "[·✎··]", "[··✎·]", "[···✎]", "[··✎·]", "[·✎··]"],
  terminal: ["[›_··]", "[·›_·]", "[··›_]", "[·›_·]"],
  searching: ["[⌕···]", "[·⌕··]", "[··⌕·]", "[···⌕]", "[··⌕·]", "[·⌕··]"],
  shrink: ["[≡≡≡≡]", "[·≡≡≡]", "[··≡≡]", "[···≡]", "[····]", "[··✦·]"],
  pacman: ["ᗧ•••", "•ᗧ••", "••ᗧ•", "•••ᗧ", "••ᗤ•", "•ᗤ••"],
  knight: ["[●····]", "[·●···]", "[··●··]", "[···●·]", "[····●]", "[···●·]", "[··●··]", "[·●···]"],
  comet: ["✦···", "·✦··", "··✦·", "···✦", "··✦·", "·✦··"],
  orbit: ["◜", "◝", "◞", "◟"],
  moon: ["○", "◔", "◑", "◕", "●", "◕", "◑", "◔"],
  dna: ["╲╱", "╳", "╱╲", "╳"],
  blackHole: ["[✦···]", "[·✦··]", "[··✦·]", "[··●·]", "[··◉·]", "[··●·]"],
  nyan: ["=^.^=···", "·=^.^=··", "··=^.^=·", "···=^.^=", "··=^.^=·", "·=^.^=··"],
  train: ["🚂···", "·🚂··", "··🚂·", "···🚂", "··🚂·", "·🚂··"],
  books: ["📚📚📚→✨", "·📚📚→✨", "··📚→✨", "···✨", "··✨·", "·✨··"],
  typewriter: ["T▌", "Ty▌", "Typ▌", "Typi▌", "Typin▌", "Typing▌", "Typing·", "Typing▌"],
  archive: ["[####]", "[###·]", "[##··]", "[#···]", "[zip·]", "[·✓··]"],
} as const;

export function toolActivity(toolName: string): Activity {
  const baseName = toolName.toLowerCase().split(/[.:/]/u).at(-1);
  switch (baseName) {
    case "bash":
    case "shell":
    case "exec": return { kind: "bash", label: "Running command" };
    case "edit": return { kind: "editing", label: "Editing file" };
    case "write": return { kind: "editing", label: "Writing file" };
    case "find": return { kind: "searching", label: "Finding files" };
    case "grep":
    case "local_search": return { kind: "searching", label: "Searching" };
    case "read": return { kind: "reading", label: "Reading" };
    default: return { kind: "tool", label: `Using ${sanitizeVisible(toolName.replaceAll("_", " "), 28) || "tool"}` };
  }
}

function smartFrames(kind: ActivityKind): readonly string[] {
  switch (kind) {
    case "compacting": return FX.books;
    case "bash": return FX.terminal;
    case "editing": return FX.writing;
    case "reading": return FX.reading;
    case "searching": return FX.searching;
    case "writing": return FX.wave;
    case "tool": return FX.pulse;
    default: return FX.thinking;
  }
}

function framesFor(profile: ProfileId, kind: ActivityKind, index: number, percent: number): readonly string[] {
  switch (profile) {
    case "surprise": {
      const rotation: readonly ProfileId[] = ["smart", "minimal", "arcade", "cosmic", "playful", "terminal"];
      return framesFor(rotation[Math.floor(index / 30) % rotation.length]!, kind, index, percent);
    }
    case "still": return ["●"];
    case "minimal": return kind === "compacting" ? FX.shrink : kind === "writing" ? FX.pulse : FX.braille;
    case "arcade":
      if (kind === "bash" || kind === "editing") return FX.knight;
      return kind === "writing" ? FX.wave : FX.pacman;
    case "cosmic":
      if (kind === "compacting") return FX.blackHole;
      if (kind === "reading") return FX.moon;
      if (kind === "searching") return FX.dna;
      return kind === "thinking" ? FX.orbit : FX.comet;
    case "playful":
      if (kind === "compacting") return FX.books;
      return kind === "bash" || kind === "editing" || kind === "tool" ? FX.train : FX.nyan;
    case "terminal":
      if (kind === "compacting") return FX.archive;
      if (kind === "writing") return FX.typewriter;
      if (kind === "bash") return FX.terminal;
      return kind === "reading" || kind === "searching" ? FX.reading : FX.braille;
    case "context": {
      if (kind === "compacting") return FX.shrink;
      const filled = Math.max(0, Math.min(8, Math.round(percent / 12.5)));
      return [`${index % 4 === 0 ? "◆" : "◇"}[${"█".repeat(filled)}${"░".repeat(8 - filled)}]`];
    }
    default: return smartFrames(kind);
  }
}

/** Pure frame selection. Rendering never starts a process or a timer. */
export function animationFrame(profile: ProfileId, kind: ActivityKind, frameIndex: number, contextPercent = 0): string {
  const index = Number.isFinite(frameIndex) ? Math.max(0, Math.trunc(frameIndex)) : 0;
  const percent = Number.isFinite(contextPercent) ? contextPercent : 0;
  const frames = framesFor(profile, kind, index, percent);
  return frames[index % frames.length]!;
}

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${(seconds % 60).toString().padStart(2, "0")}s`;
}

export function milestoneBadge(elapsedMs: number): string {
  if (elapsedMs >= 300_000) return "🧙";
  if (elapsedMs >= 120_000) return "🐢";
  if (elapsedMs >= 30_000) return "☕";
  return "";
}

export function previewAnimation(profile: ProfileId, frameIndex = 0): string {
  return sanitizeVisible(`${animationFrame(profile, "thinking", frameIndex, 76)} Thinking · 12s`, 72);
}
