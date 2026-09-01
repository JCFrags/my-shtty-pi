import type { OmissionNotice } from "../types.js";

// CSI, OSC, two-character escapes, and single-character escape sequences.
const ANSI_PATTERN = /[\u001B\u009B](?:\][^\u0007]*(?:\u0007|\u001B\\)|[[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;

export interface NormalizationResult {
  readonly text: string;
  readonly changed: boolean;
  readonly omissions: readonly OmissionNotice[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function normalizeTerminalText(input: string): NormalizationResult {
  let ansiCount = 0;
  const withoutAnsi = input.replace(ANSI_PATTERN, () => {
    ansiCount += 1;
    return "";
  });

  let carriageFrames = 0;
  const lines = withoutAnsi.split("\n").map((line) => {
    if (!line.includes("\r")) return line;
    const frames = line.split("\r");
    carriageFrames += Math.max(0, frames.length - 1);
    return frames[frames.length - 1] ?? "";
  });

  const text = lines.join("\n").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
  const omissions: OmissionNotice[] = [];
  if (ansiCount > 0) omissions.push({ description: `${ansiCount} ANSI control sequence(s) removed` });
  if (carriageFrames > 0) omissions.push({ description: `${carriageFrames} overwritten progress frame(s) collapsed` });
  return {
    text,
    changed: text !== input,
    omissions,
    metadata: { ansiSequencesRemoved: ansiCount, carriageFramesCollapsed: carriageFrames },
  };
}

export interface CollapsedLinesResult {
  readonly lines: readonly string[];
  readonly repeatedLines: number;
  readonly groups: number;
}

export function collapseAdjacentRepeatedLines(lines: readonly string[], threshold = 3): CollapsedLinesResult {
  const output: string[] = [];
  let repeatedLines = 0;
  let groups = 0;
  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const count = end - index;
    if (count >= threshold) {
      output.push(line, `[... previous line repeated ${count - 1} additional time(s) ...]`);
      repeatedLines += count - 1;
      groups += 1;
    } else {
      for (let cursor = index; cursor < end; cursor += 1) output.push(lines[cursor] ?? "");
    }
    index = end;
  }
  return { lines: output, repeatedLines, groups };
}
