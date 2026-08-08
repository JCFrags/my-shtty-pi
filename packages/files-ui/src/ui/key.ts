export type BrowserKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "shift-up"
  | "shift-down"
  | "page-up"
  | "page-down"
  | "tab"
  | "shift-tab"
  | "enter"
  | "escape"
  | "space"
  | "backspace"
  | "delete"
  | "home"
  | "end"
  | "slash"
  | "unknown";

const KEY_SEQUENCES: ReadonlyMap<string, BrowserKey> = new Map([
  ["\u001b[A", "up"],
  ["\u001bOA", "up"],
  ["\u001b[B", "down"],
  ["\u001bOB", "down"],
  ["\u001b[D", "left"],
  ["\u001bOD", "left"],
  ["\u001b[C", "right"],
  ["\u001bOC", "right"],
  ["\u001b[1;2A", "shift-up"],
  ["\u001b[1;2B", "shift-down"],
  ["\u001b[5~", "page-up"],
  ["\u001b[6~", "page-down"],
  ["\u001b[H", "home"],
  ["\u001bOH", "home"],
  ["\u001b[F", "end"],
  ["\u001bOF", "end"],
  ["\t", "tab"],
  ["\u001b[Z", "shift-tab"],
  ["\r", "enter"],
  ["\n", "enter"],
  ["\u001b", "escape"],
  [" ", "space"],
  ["\u007f", "backspace"],
  ["\b", "backspace"],
  ["\u001b[3~", "delete"],
  ["/", "slash"],
]);

/**
 * Decode the conventional terminal sequences used by Pi. Kitty keyboard-protocol
 * modifier forms for arrows are accepted as well, so the extension remains fully
 * keyboard-operable when that protocol is enabled.
 */
export function decodeBrowserKey(data: string): BrowserKey {
  const direct = KEY_SEQUENCES.get(data);
  if (direct) return direct;

  // Kitty/CSI-u and modified cursor-key forms Pi may receive from modern terminals.
  if (/^\u001b\[(?:1;)?2A$/.test(data) || /^\u001b\[57358;2u$/.test(data)) return "shift-up";
  if (/^\u001b\[(?:1;)?2B$/.test(data) || /^\u001b\[57359;2u$/.test(data)) return "shift-down";
  if (/^\u001b\[(?:1;\d+)?A$/.test(data)) return "up";
  if (/^\u001b\[(?:1;\d+)?B$/.test(data)) return "down";
  if (/^\u001b\[(?:1;\d+)?C$/.test(data)) return "right";
  if (/^\u001b\[(?:1;\d+)?D$/.test(data)) return "left";
  if (/^\u001b\[13(?:;\d+)?u$/.test(data)) return "enter";
  if (/^\u001b\[27(?:;\d+)?u$/.test(data)) return "escape";
  if (/^\u001b\[32(?:;\d+)?u$/.test(data)) return "space";
  if (/^\u001b\[9(?:;\d+)?u$/.test(data)) return "tab";
  return "unknown";
}

export function isPrintableInput(data: string): boolean {
  if (data.length === 0 || data.startsWith("\u001b")) return false;
  for (const character of data) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return false;
  }
  return true;
}
