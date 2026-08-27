# @grounded/pi-workplan

Durable session-tree project specifications and recovery state for Pi.

## Purpose

Use `todo` for the immediate execution queue. Todo answers, “What must I do next in this turn or short phase?”

Use `workplan` for the durable project contract. Workplan records the user-approved goal, boundaries, approach, milestones, acceptance criteria, decisions, risks, questions, checkpoints, evidence, and revision history. It follows the active session branch and survives repeated Pi compaction because the extension rebuilds state from branch events.

The tools do not synchronize state. A workplan milestone can hold an inert todo ID reference, but the reference does not verify or change either item.

## Recovery after context loss

The automatic context line contains only plan IDs, counts, and a recovery marker. It does not expose stored plan prose.

When the marker says `recovery=required`, call:

```json
{ "action": "recover", "planId": "WP1" }
```

`recover` returns a bounded orientation view. It includes the goal, scope, non-goals, constraints, approach, current checkpoint, current or ready milestones, next actions, outstanding criteria, unresolved risks and questions, recent decisions, and verification steps. It omits revision history. Use `read` when the complete immutable plan is needed.

A recovery remains current only while its tool result is model-visible and its revision matches the active plan. Compaction, session restore, branch change, or a later plan mutation makes recovery required again.

## Visible tool results

Workplan does not hide a durable mutation behind an ID-only receipt. Each successful mutation returns a human-readable plan summary and the complete changed record or section. Creation returns the complete initial plan. `list` and `status` include plan titles, objectives, states, and milestone information. The structured tool-result details still contain the compact machine receipt and event for exact replay.

Automatic context stays prose-free. When no plan is active, it reports retained, completed, archived, draft, and paused plan state. A draft or paused plan includes a recovery directive so it cannot disappear behind `active=none` during compaction.

Normal mutation output is bounded at 48 KiB. If an unusually large result exceeds that bound, Workplan reports exact truncation and preserves the complete output in its private temporary output artifact.

## Checkpoints

Record a checkpoint after a major phase and before a pause or handoff. Include the current position and explicit next actions:

```json
{
  "action": "checkpoint",
  "planId": "WP1",
  "expectedRevision": 12,
  "content": {
    "summary": "The storage migration is verified.",
    "currentFocus": "Update callers to use the new API.",
    "nextActions": ["Update the CLI caller.", "Run the integration tests."],
    "criterionEvidence": [{ "criterionId": "WP1-C1", "evidence": "Migration test passed." }]
  }
}
```

If the plan changes after a checkpoint, `recover` marks that checkpoint as historical and infers next actions from current milestone state. This prevents stale checkpoint actions from silently becoming the current plan.

## Main payload shapes

JSON property and section names use camelCase.

- `create`: `{title, objective, approach, background?, scope?, nonGoals?, constraints?, acceptanceCriteria?: string[], verification?}`
- `add_milestone`: `{title, description?, dependsOn?, acceptanceCriteria?}`
- `update_milestone`: one or more of `{title, description, dependsOn, status, evidence, linkedTodoIds}`
- `record_decision`: `{decision}` plus top-level `rationale`
- `record_risk`: `{description, impact, mitigation, status?}`
- `record_question`: `{question, status?, answer?}`
- `checkpoint`: `{summary, currentFocus?, nextActions?, criterionEvidence?}`
- `revise`: top-level `section`, its replacement value in `content`, and top-level `rationale`

Mutations other than `create` require `planId` and `expectedRevision`. Legacy snake_case section names are normalized before validation.

A branch can have at most 16 open plans and retain at most 64 plans. Completed and archived plans do not consume the open-plan limit.

## Storage and privacy

Workplan stores explicit text in Pi session JSONL tool-result details. Requested `read` and `recover` output is model-visible. Do not store passwords, keys, tokens, cookies, private keys, or other secrets in workplans.

Workplan has no file export or import. Use `workplan(read)` and then call a separate reviewed `write` tool when explicit file output is required.
