/**
 * Render control characters as visible text before applying terminal styling.
 * This prevents paths or file contents from injecting terminal escape sequences,
 * line breaks, or bidirectional overrides into an approval surface.
 */
export function renderControlCharacters(text: string): string {
  return text.replace(
    /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 0x1f) return String.fromCodePoint(0x2400 + codePoint);
      if (codePoint === 0x7f) return "␡";
      return `<U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}>`;
    },
  );
}
