import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyWorkplanEvent,
  cloneWorkplanState,
  emptyWorkplanState,
  performWorkplanAction,
  workplanContextLine,
} from "@grounded/pi-core/workplan";
import {
  boundedStateOutput,
  cancelled,
  STATE_EVENT_PROTOCOL,
  STATE_RESULT_PROTOCOL,
  StateToolError,
  type StateToolDetails,
} from "@grounded/pi-core/state";

export const WorkplanParams = Type.Object({
  action: StringEnum([
    "create", "list", "status", "read", "revise", "add_milestone", "update_milestone", "record_decision",
    "record_risk", "record_question", "checkpoint", "pause", "resume", "complete", "archive",
  ] as const),
  planId: Type.Optional(Type.String()),
  section: Type.Optional(StringEnum([
    "title", "objective", "background", "scope", "non_goals", "constraints", "approach", "acceptance_criteria",
    "verification", "risks", "open_questions",
  ] as const)),
  milestoneId: Type.Optional(Type.String()),
  content: Type.Optional(Type.Unknown()),
  rationale: Type.Optional(Type.String()),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export const WORKPLAN_DESCRIPTION = "Manage detailed branch-aware execution specifications. Workplans contain objectives, milestones, criteria, decisions, risks, questions, checkpoints, evidence, and immutable revision records.";
export const WORKPLAN_PROMPT_SNIPPET = "Manage detailed milestones and execution specifications";
export const WORKPLAN_GUIDELINES = [
  "Use workplan for detailed milestones and specifications. Workplan milestones do not replace todo. Workplan has no direct file export.",
];

interface EntryLike {
  id?: string;
  type?: string;
  message?: { role?: string; toolName?: string; details?: unknown };
}

function contextMessage(text: string) {
  return { role: "custom" as const, customType: "grounded-workplan-context", content: text, display: false, timestamp: 0 };
}

export default function groundedWorkplan(pi: ExtensionAPI) {
  let state = emptyWorkplanState();
  let corruptEntryId: string | undefined;

  const restore = (ctx: ExtensionContext) => {
    state = emptyWorkplanState();
    corruptEntryId = undefined;
    for (const raw of ctx.sessionManager.getBranch() as EntryLike[]) {
      if (raw.type !== "message" || raw.message?.role !== "toolResult" || raw.message.toolName !== "workplan") continue;
      const details = raw.message.details;
      if (!details || typeof details !== "object" || Array.isArray(details)) continue;
      const candidate = details as Record<string, unknown>;
      if (candidate.protocol !== STATE_RESULT_PROTOCOL || !Object.hasOwn(candidate, "event")) continue;
      const event = candidate.event;
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const envelope = event as Record<string, unknown>;
      if (envelope.protocol !== STATE_EVENT_PROTOCOL || envelope.tool !== "workplan") continue;
      try {
        state = applyWorkplanEvent(state, event);
      } catch {
        corruptEntryId = raw.id ?? "unknown";
        break;
      }
    }
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("context", (event) => {
    const text = corruptEntryId ? `[workplan state] corrupt entry=${corruptEntryId}` : workplanContextLine(state);
    if (!text) return;
    return { messages: [...event.messages, contextMessage(text)] };
  });

  pi.registerTool({
    name: "workplan",
    label: "Workplan",
    description: WORKPLAN_DESCRIPTION,
    promptSnippet: WORKPLAN_PROMPT_SNIPPET,
    promptGuidelines: WORKPLAN_GUIDELINES,
    parameters: WorkplanParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (corruptEntryId) throw new StateToolError("STATE_CORRUPT", `Workplan state is corrupt at entry ${corruptEntryId}`);
      cancelled(signal);
      const operation = performWorkplanAction(state, params);
      cancelled(signal);
      let text = typeof operation.result === "string" ? operation.result : JSON.stringify(operation.result, null, 2);
      let fullOutputPath: string | undefined;
      if (params.action === "read") {
        const bounded = await boundedStateOutput(text, "grounded-workplan", signal);
        text = bounded.text;
        fullOutputPath = bounded.fullOutputPath;
      }
      cancelled(signal);
      if (operation.event) state = cloneWorkplanState(operation.state);
      const details: StateToolDetails = {
        protocol: STATE_RESULT_PROTOCOL,
        action: params.action,
        ...(operation.event ? { event: operation.event } : {}),
        result: operation.result,
        ...(fullOutputPath ? { fullOutputPath } : {}),
      };
      return { content: [{ type: "text" as const, text }], details };
    },
  });
}
