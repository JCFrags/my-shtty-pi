const ANSI_PATTERN = /(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~])/g;
const ANSI_AT_START = /^(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~])/;

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  );
}

function isFullWidth(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function codePointCellWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0) || isCombining(codePoint)) return 0;
  return isFullWidth(codePoint) ? 2 : 1;
}


/** Render untrusted filesystem/file text without allowing terminal control sequences. */
export function sanitizeTerminalText(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0 && codePoint <= 0x1f) {
      output += String.fromCodePoint(0x2400 + codePoint);
    } else if (codePoint === 0x7f) {
      output += "␡";
    } else if (codePoint >= 0x80 && codePoint <= 0x9f) {
      output += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else if (
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      output += `⟦U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}⟧`;
    } else {
      output += character;
    }
  }
  return output;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function cellWidth(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) width += codePointCellWidth(character);
  return width;
}

/** Truncate by terminal cells while preserving complete ANSI/OSC sequences. */
export function truncateToCells(value: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (cellWidth(value) <= width) return value;
  const ellipsisWidth = cellWidth(ellipsis);
  const target = Math.max(0, width - ellipsisWidth);
  let output = "";
  let used = 0;
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) === 0x1b) {
      const match = value.slice(index).match(ANSI_AT_START);
      if (match?.[0]) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const characterWidth = codePointCellWidth(character);
    if (used + characterWidth > target) break;
    output += character;
    used += characterWidth;
    index += character.length;
  }
  return output + (ellipsisWidth <= width ? ellipsis : "") + "\u001b[0m";
}

export function padToCells(value: string, width: number): string {
  const truncated = truncateToCells(value, width);
  return truncated + " ".repeat(Math.max(0, width - cellWidth(truncated)));
}

export function alignRight(left: string, right: string, width: number): string {
  const safeRight = truncateToCells(right, Math.max(0, width - 1));
  const remaining = width - cellWidth(safeRight);
  const safeLeft = truncateToCells(left, Math.max(0, remaining - 1));
  const gap = Math.max(1, width - cellWidth(safeLeft) - cellWidth(safeRight));
  return padToCells(`${safeLeft}${" ".repeat(gap)}${safeRight}`, width);
}
