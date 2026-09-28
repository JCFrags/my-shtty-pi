/** Structural types keep the pure library independent of host declaration versions. */
export interface PresentationContext {
  args: Record<string, unknown>;
  isError: boolean;
}
export interface PresentationResult {
  content: readonly { type: string; text?: string }[];
  details?: unknown;
}
export interface PresentationOptions {
  expanded: boolean;
  isPartial: boolean;
}
export interface PresentationComponent {
  render(width: number): string[];
  invalidate(): void;
}
type Color = "toolTitle" | "toolOutput" | "dim" | "muted" | "success" | "warning" | "error";
export interface PresentationTheme {
  fg(color: Color, text: string): string;
  bold(text: string): string;
}

/** Prioritized display copies. Notices precede excerpts. No field changes model output. */
export interface PresentationView {
  summary?: string;
  notices?: readonly string[];
  lines?: readonly string[];
  /** Some saved evidence is not included in this preview. */
  omitted?: boolean;
  /** Hide a successful collapsed body, leaving only its call row. */
  quiet?: boolean;
  tone?: "muted" | "success" | "warning" | "error";
}
export interface PresentationSpec {
  call(args: Record<string, unknown>, context: PresentationContext): string;
  result(result: PresentationResult, options: PresentationOptions, context: PresentationContext): PresentationView;
}

/** No execution, registration, I/O, event handlers, or retained state. */
export function createToolPresentation(spec: PresentationSpec): {
  renderShell: "self";
  renderCall(args: Record<string, unknown>, theme: PresentationTheme, context: PresentationContext): PresentationComponent;
  renderResult(result: PresentationResult, options: PresentationOptions, theme: PresentationTheme, context: PresentationContext): PresentationComponent;
};
