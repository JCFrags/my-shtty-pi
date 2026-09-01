const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/gu;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function textWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

export function truncateText(text: string, width: number, suffix = "…"): string {
  const safeWidth = Math.max(0, Math.trunc(width));
  if (textWidth(text) <= safeWidth) return text;
  if (safeWidth === 0) return "";

  const suffixWidth = textWidth(suffix);
  if (suffixWidth >= safeWidth) return [...suffix].slice(0, safeWidth).join("");

  const target = safeWidth - suffixWidth;
  let result = "";
  let used = 0;
  for (const character of [...stripAnsi(text)]) {
    if (used + 1 > target) break;
    result += character;
    used += 1;
  }
  return result + suffix;
}

export function padRight(text: string, width: number): string {
  const padding = Math.max(0, Math.trunc(width) - textWidth(text));
  return text + " ".repeat(padding);
}

export function fitLine(text: string, width: number): string {
  return truncateText(text, Math.max(0, Math.trunc(width)), "");
}

export function paint(theme: { fg?(role: string, text: string): string }, role: string, text: string): string {
  try {
    return typeof theme.fg === "function" ? theme.fg(role, text) : text;
  } catch {
    return text;
  }
}

export function emphasize(theme: { bold?(text: string): string }, text: string): string {
  try {
    return typeof theme.bold === "function" ? theme.bold(text) : text;
  } catch {
    return text;
  }
}

export function abbreviateToolCallId(toolCallId: string, width = 10): string {
  const safeWidth = Math.max(4, Math.trunc(width));
  if (toolCallId.length <= safeWidth) return toolCallId;
  const tail = Math.max(2, Math.floor((safeWidth - 1) / 2));
  const head = Math.max(1, safeWidth - tail - 1);
  return `${toolCallId.slice(0, head)}…${toolCallId.slice(-tail)}`;
}
