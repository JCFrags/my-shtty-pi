import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const QUESTION_ACTIVE_WORK_MS = 30 * 60 * 1000;
export const QUESTION_MEANINGFUL_RUNS = 3;
export const MAX_TOOL_ACTIVE_MS = 5 * 60 * 1000;

export interface QuestionToolStartEvent { toolCallId: string; toolName: string; args: unknown }
export interface QuestionToolEndEvent { toolCallId: string; toolName: string; isError: boolean; result?: unknown }
export interface QuestionAgentEndEvent { messages?: readonly unknown[] }
export interface QuestionActivitySpan {
  toolCallId: string;
  startedAt: number;
  endedAt: number;
  startAnchorId: string | null;
  strong: boolean;
}
export interface QuestionActivityAggregate {
  runId: string;
  spans: QuestionActivitySpan[];
}

type Context = Pick<ExtensionContext, "sessionManager">;
type Classification = { eligible: true; strong: boolean } | { eligible: false; strong: false };
type ToolSpan = { toolCallId: string; toolName: string; startedAt: number; startAnchorId: string | null; classification: Classification };
type CompletedSpan = ToolSpan & { endedAt: number };
type Run = {
  id: string;
  sessionId: string;
  anchorId: string | null;
  tools: Map<string, ToolSpan>;
  completed: CompletedSpan[];
  hadError: boolean;
  terminalError: boolean;
  retryChain: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function action(value: unknown): string | undefined {
  const candidate = record(value);
  return typeof candidate?.action === "string" ? candidate.action : undefined;
}

/** Unknown operations fail closed. Bash, process, session, orchestration and UI tools never count. */
export function classifyQuestionWork(toolName: string, args: unknown): Classification {
  if (["read", "local_search", "lsp", "web_search", "web_read", "web_read_batch", "web_content"].includes(toolName)) {
    if (toolName === "local_search" && action(args) !== "query") return { eligible: false, strong: false };
    if (toolName === "lsp" && !["diagnostics", "hover", "definition", "references", "rename_preview"].includes(action(args) ?? "")) return { eligible: false, strong: false };
    return { eligible: true, strong: false };
  }
  if (toolName === "edit" || toolName === "write") return { eligible: true, strong: true };
  if (toolName === "todo") {
    const operation = action(args);
    return operation && ["add", "update", "start", "done", "block", "remove", "reorder", "clear_done", "replace"].includes(operation)
      ? { eligible: true, strong: true }
      : { eligible: false, strong: false };
  }
  if (toolName === "workplan") {
    const operation = action(args);
    return operation && ["create", "revise", "add_milestone", "update_milestone", "record_decision", "record_risk", "record_question", "checkpoint", "pause", "resume", "complete", "archive"].includes(operation)
      ? { eligible: true, strong: true }
      : { eligible: false, strong: false };
  }
  return { eligible: false, strong: false };
}

function sameScope(run: Run, ctx: Context): boolean {
  try {
    return ctx.sessionManager.getSessionId() === run.sessionId
      && (run.anchorId === null || ctx.sessionManager.getBranch().some((entry) => entry.id === run.anchorId));
  } catch { return false; }
}

function terminalFailed(messages: readonly unknown[] | undefined): boolean {
  if (!messages) return false;
  return messages.some((value) => {
    const message = record(value);
    return message?.role === "assistant" && ["error", "aborted", "length"].includes(String(message.stopReason));
  });
}

export function questionActiveMs(spans: readonly Pick<QuestionActivitySpan, "startedAt" | "endedAt">[]): number {
  const intervals = spans.map((span) => [span.startedAt, Math.min(span.endedAt, span.startedAt + MAX_TOOL_ACTIVE_MS)] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let start: number | undefined;
  let end = 0;
  for (const interval of intervals) {
    if (start === undefined) { [start, end] = interval; continue; }
    if (interval[0] <= end) end = Math.max(end, interval[1]);
    else { total += end - start; [start, end] = interval; }
  }
  return Math.max(0, Math.floor(start === undefined ? 0 : total + end - start));
}

export class QuestionActivityTracker {
  #run: Run | undefined;
  constructor(
    private readonly consume: (aggregate: QuestionActivityAggregate, ctx: Context) => void,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  agentStart(ctx: Context): void {
    // A second start before agent_settled is an automatic retry/continuation. Discard the earlier run.
    const retryChain = this.#run !== undefined;
    this.#run = { id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), anchorId: ctx.sessionManager.getLeafId(), tools: new Map(), completed: [], hadError: false, terminalError: false, retryChain };
  }

  toolStart(event: QuestionToolStartEvent, ctx: Context): void {
    const run = this.#run;
    if (!run || !sameScope(run, ctx) || run.tools.has(event.toolCallId)) return;
    const classification = classifyQuestionWork(event.toolName, event.args);
    if (!classification.eligible) return;
    run.tools.set(event.toolCallId, { toolCallId: event.toolCallId, toolName: event.toolName, startedAt: this.monotonicNow(), startAnchorId: ctx.sessionManager.getLeafId(), classification });
  }

  toolEnd(event: QuestionToolEndEvent, ctx: Context): void {
    const run = this.#run;
    if (!run || !sameScope(run, ctx)) return;
    if (event.isError) run.hadError = true;
    const span = run.tools.get(event.toolCallId);
    if (!span) return;
    run.tools.delete(event.toolCallId);
    if (!event.isError && span.toolName === event.toolName) run.completed.push({ ...span, endedAt: this.monotonicNow() });
  }

  uiPromptStart(ctx: Context): void {
    const run = this.#run;
    if (run && sameScope(run, ctx)) run.hadError = true;
  }
  uiPromptEnd(_ctx: Context): void { /* A prompt-invalidated run remains excluded. */ }

  agentEnd(event: QuestionAgentEndEvent, ctx: Context): void {
    const run = this.#run;
    if (!run || !sameScope(run, ctx)) return;
    run.terminalError ||= terminalFailed(event.messages);
  }

  agentSettled(ctx: Context): void {
    const run = this.#run;
    this.#run = undefined;
    if (!run || !sameScope(run, ctx) || run.hadError || run.terminalError || run.retryChain || run.tools.size > 0) return;
    const unique = new Map(run.completed.map((span) => [span.toolCallId, span]));
    const spans = [...unique.values()].slice(0, 64).map((span) => ({
      toolCallId: span.toolCallId, startedAt: span.startedAt, endedAt: span.endedAt,
      startAnchorId: span.startAnchorId, strong: span.classification.strong,
    }));
    if (spans.length) this.consume({ runId: run.id, spans }, ctx);
  }

  sessionTree(): void { this.#run = undefined; }
  stop(): void { this.#run = undefined; }
}
