import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  applyWorkplanEvent,
  cloneWorkplanState,
  emptyWorkplanState,
  performWorkplanAction,
  renderWorkplanList,
  renderWorkplanMutation,
  renderWorkplanStatus,
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
    "create", "list", "status", "read", "recover", "revise", "add_milestone", "update_milestone", "record_decision",
    "record_risk", "record_question", "checkpoint", "pause", "resume", "complete", "archive",
  ] as const, { description: "recover returns bounded project orientation; read returns the complete plan; mutation actions require expectedRevision" }),
  planId: Type.Optional(Type.String({ description: "Workplan ID. Required except for create and list." })),
  section: Type.Optional(StringEnum([
    "title", "objective", "background", "scope", "nonGoals", "constraints", "approach", "acceptanceCriteria",
    "verification", "risks", "openQuestions",
  ] as const, { description: "Section for revise. JSON property names use camelCase." })),
  milestoneId: Type.Optional(Type.String({ description: "Milestone ID for update_milestone" })),
  content: Type.Optional(Type.Unknown({ description: "Action payload. create: {title, objective, approach, background?, scope?, nonGoals?, constraints?, acceptanceCriteria?: string[], verification?}. add_milestone: {title, description?, dependsOn?, acceptanceCriteria?}. update_milestone: one or more of {title, description, dependsOn, status, evidence, linkedTodoIds}. record_decision: {decision}. record_risk: {description, impact, mitigation, status?}. record_question: {question, status?, answer?}. checkpoint: {summary, currentFocus?, nextActions?: string[], criterionEvidence?: [{criterionId, evidence}]}. revise uses the section value shape." })),
  rationale: Type.Optional(Type.String({ description: "Reason for revise, decision, or plan lifecycle mutation" })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1, description: "Current plan revision required for every mutation except create" })),
}, { additionalProperties: false });

export const WORKPLAN_DESCRIPTION = "Manage durable branch-aware project specifications and recovery state. Use recover to restore the goal, constraints, current position, decisions, and next actions after compaction or other context loss.";
export const WORKPLAN_PROMPT_SNIPPET = "Preserve and recover durable goals, milestones, decisions, and evidence";
export const WORKPLAN_GUIDELINES = [
  "Use workplan for durable project goals, constraints, milestones, decisions, checkpoints, and recovery across compaction. Use todo for immediate executable actions.",
  "When [workplan state] names an active plan and the current goal or position is not already clear, call workplan recover before substantial planning or execution. Always do this after compaction, session restore, or branch change.",
  "Record a workplan checkpoint with currentFocus and nextActions after a major phase and before a pause or handoff. Do not treat linked todo IDs as synchronized state.",
  "Workplan has no direct file export. Use a separate reviewed write call when the user requests a file.",
];

export function prepareWorkplanArguments(args: unknown): Static<typeof WorkplanParams> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args as Static<typeof WorkplanParams>;
  const input = { ...(args as Record<string, unknown>) };
  const sectionAliases: Record<string, string> = {
    non_goals: "nonGoals",
    acceptance_criteria: "acceptanceCriteria",
    open_questions: "openQuestions",
  };
  if (typeof input.section === "string" && sectionAliases[input.section]) input.section = sectionAliases[input.section];
  if (input.action === "create" && input.content && typeof input.content === "object" && !Array.isArray(input.content)) {
    const content = { ...(input.content as Record<string, unknown>) };
    for (const [legacy, canonical] of [["non_goals", "nonGoals"], ["acceptance_criteria", "acceptanceCriteria"]] as const) {
      if (Object.hasOwn(content, legacy) && !Object.hasOwn(content, canonical)) content[canonical] = content[legacy];
      delete content[legacy];
    }
    input.content = content;
  }
  return input as Static<typeof WorkplanParams>;
}

interface EntryLike {
  id?: string;
  type?: string;
  message?: { role?: string; toolName?: string; details?: unknown };
}

function contextMessage(text: string) {
  return { role: "custom" as const, customType: "grounded-workplan-context", content: text, display: false, timestamp: 0 };
}

function latestVisibleRecovery(messages: readonly unknown[]): { planId: string; revision: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const candidate = message as Record<string, unknown>;
    if (candidate.role !== "toolResult" || candidate.toolName !== "workplan") continue;
    const details = candidate.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    const recovery = (details as Record<string, unknown>).recovery;
    if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) continue;
    const value = recovery as Record<string, unknown>;
    if (typeof value.planId === "string" && Number.isSafeInteger(value.revision) && (value.revision as number) >= 1) {
      return { planId: value.planId, revision: value.revision as number };
    }
  }
  return undefined;
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
    const text = corruptEntryId ? `[workplan state] corrupt entry=${corruptEntryId}` : workplanContextLine(state, latestVisibleRecovery(event.messages));
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
    prepareArguments: prepareWorkplanArguments,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (corruptEntryId) throw new StateToolError("STATE_CORRUPT", `Workplan state is corrupt at entry ${corruptEntryId}`);
      cancelled(signal);
      const operation = performWorkplanAction(state, params);
      cancelled(signal);
      let text: string;
      if (operation.event) text = renderWorkplanMutation(operation.state, operation.event);
      else if (params.action === "list") text = renderWorkplanList(operation.state);
      else if (params.action === "status") {
        const plan = operation.state.plans.find((item) => item.id === params.planId);
        if (!plan) throw new StateToolError("STATE_NOT_FOUND", `Workplan ${params.planId} does not exist`);
        text = renderWorkplanStatus(plan);
      } else text = typeof operation.result === "string" ? operation.result : JSON.stringify(operation.result, null, 2);
      const bounded = await boundedStateOutput(text, "grounded-workplan", signal, params.action === "read" ? {} : { maxBytes: 48 * 1024, maxLines: 1500 });
      text = bounded.text;
      const fullOutputPath = bounded.fullOutputPath;
      cancelled(signal);
      if (operation.event) state = cloneWorkplanState(operation.state);
      const recoveryPlan = params.action === "recover" ? operation.state.plans.find((plan) => plan.id === params.planId) : undefined;
      const details: StateToolDetails & { recovery?: { planId: string; revision: number } } = {
        protocol: STATE_RESULT_PROTOCOL,
        action: params.action,
        ...(operation.event ? { event: operation.event } : {}),
        result: operation.result,
        ...(recoveryPlan ? { recovery: { planId: recoveryPlan.id, revision: recoveryPlan.revision } } : {}),
        ...(fullOutputPath ? { fullOutputPath } : {}),
      };
      return { content: [{ type: "text" as const, text }], details };
    },
  });
}
