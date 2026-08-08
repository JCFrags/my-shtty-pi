import { sha256 } from "./text.ts";

export interface AnchoredDocument {
  digest: string;
  lines: string[];
  anchors: string[];
  rendered: string;
}

export function anchorDocument(text: string): AnchoredDocument {
  const lines = text.split("\n");
  const occurrences = new Map<string, number>();
  const anchors = lines.map((line) => {
    const occurrence = (occurrences.get(line) ?? 0) + 1;
    occurrences.set(line, occurrence);
    return sha256(`${line}\0${occurrence}`).slice(0, 12);
  });
  const digest = sha256(text);
  const rendered = [
    `snapshot:${digest}`,
    ...lines.map((line, index) => `${anchors[index]}│${line}`),
  ].join("\n");
  return { digest, lines, anchors, rendered };
}

export function resolveAnchorRange(
  document: AnchoredDocument,
  startAnchor: string,
  endAnchor: string,
): { start: number; end: number } {
  const start = document.anchors.indexOf(startAnchor);
  const end = document.anchors.indexOf(endAnchor);
  if (start < 0 || end < 0) {
    throw new Error("Anchor not found in the current file. Read again with mode=anchors.");
  }
  if (end < start) throw new Error("endAnchor occurs before startAnchor");
  return { start, end };
}
