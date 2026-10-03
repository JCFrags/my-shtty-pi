import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const WorkplanParams = Type.Object({
  action: StringEnum([
    "create", "list", "status", "read", "recover", "revise", "add_milestone", "update_milestone", "record_decision",
    "record_risk", "record_question", "checkpoint", "pause", "resume", "complete", "archive", "restore",
  ] as const, { description: "recover returns bounded project orientation; read returns the complete plan; restore returns an archive to its prior draft, paused, or completed status without activation; omitted planId uses the active plan; omitted expectedRevision uses the latest saved revision inside the serialized mutation" }),
  planId: Type.Optional(Type.String({ description: "Workplan ID. Defaults to the active plan except for untargeted create/list. Supply an ID when no plan is active." })),
  section: Type.Optional(StringEnum([
    "title", "objective", "background", "scope", "nonGoals", "constraints", "approach", "acceptanceCriteria",
    "verification", "risks", "openQuestions",
  ] as const, { description: "Section for revise. JSON property names use camelCase." })),
  milestoneId: Type.Optional(Type.String({ description: "Milestone ID for update_milestone" })),
  content: Type.Optional(Type.Unknown({ description: "Action payload types. create: {title:string, objective:string, approach:string, background?:string, scope?:string[], nonGoals?:string[], constraints?:string[], acceptanceCriteria?:string[], verification?:string[]}. checkpoint replaces the saved position: {summary:string, currentFocus?:string, nextActions?:string[], criterionEvidence?:[{criterionId:string,evidence:string}]}. add_milestone: {title:string, description?:string, dependsOn?:string[], acceptanceCriteria?:string[]}. update_milestone: title/description:string, dependsOn/evidence/linkedTodoIds:string[], status:pending|in_progress|blocked|completed. record_decision: {decision:string}, reason in top-level rationale. record_risk: {description:string,impact:string,mitigation:string,status?:open|mitigated|accepted}. record_question: {question:string,status?:open|resolved,answer?:string}. revise: title/objective/background/approach:string; scope/nonGoals/constraints/verification:string[]; acceptanceCriteria:[{id:string,text:string}]; risks/openQuestions: complete native object arrays, preserving IDs." })),
  rationale: Type.Optional(Type.String({ description: "Required reason for revise, record_decision, pause, resume, complete, archive, and restore" })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1, description: "Optional conflict guard. Omit to mutate the latest saved revision under serialization. A supplied stale revision is rejected." })),
}, { additionalProperties: false });

export const WORKPLAN_DESCRIPTION = "Manage durable branch-aware project specifications and recovery state. Use recover to restore the goal, constraints, current position, decisions, and next actions after compaction or other context loss.";
export const WORKPLAN_PROMPT_SNIPPET = "Preserve and recover durable goals, milestones, decisions, and evidence";
export const WORKPLAN_GUIDELINES = [
  "Use workplan for the project goal, constraints, saved position, decisions, and recovery. It works independently of Chrono. Use todo for immediate executable actions.",
  "Revise existing sections when direction changes. Use checkpoint to replace the saved position and next actions, not append obsolete guidance. Earlier revisions remain history. Omitted planId uses the active plan; omitted expectedRevision uses its latest saved revision.",
  'Common calls: create with content:{title:"Task",objective:"Desired result",approach:"Method",scope:["In scope"],verification:["Check result"]}; checkpoint with content:{summary:"Saved progress",currentFocus:"Current work",nextActions:["Next step"]}.',
  "When [workplan state] names an active plan and the current goal or position is not already clear, call workplan recover before substantial planning or execution. Always do this after compaction, session restore, or branch change.",
  "Record a workplan checkpoint with currentFocus and nextActions after a major phase and before a pause or handoff. Preserve useful code locations, unresolved work, external waits, and approval gates. Keep project purpose, approach, and reasons in the plan. Do not treat linked todo IDs as synchronized state.",
  "At a meaningful task or direction change, save the checkpoint before requesting compaction through an available, permitted request_compaction tool. A routine milestone, checkpoint, or temporary wait does not by itself warrant compaction. Workplan does not trigger compaction automatically.",
  "Pause and archive preserve unfinished work, not completion. Use list/read/recover to find saved archives. Restore requires an archived plan ID and rationale, preserves contents, and never activates a plan. An explicit expectedRevision must match. Recover its saved guidance and approval gates before a separate permitted resume. Saved context is not new permission.",
  "The first restore write requires a restore-compatible Workplan reader thereafter, including for complete transfer checkpoints. Do not roll back to a reader that rejects restore revision records.",
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
