import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

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
