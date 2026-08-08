import { createHash } from "node:crypto";

export type LineEnding = "\n" | "\r\n";

export function stripBom(text: string): { bom: string; text: string } {
  return text.charCodeAt(0) === 0xfeff ? { bom: "\ufeff", text: text.slice(1) } : { bom: "", text };
}

export function detectLineEnding(text: string): LineEnding {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: LineEnding): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function countOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  if (!needle) return positions;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    positions.push(index);
    from = index + 1;
  }
  return positions;
}
