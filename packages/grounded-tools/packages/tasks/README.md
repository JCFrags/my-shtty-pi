# @grounded/pi-tasks

Visible branch-aware Pi task plans with dependencies, external wait reasons, cycle validation, transactional mutations, and session-tree persistence. Use `blockedBy` for task dependencies. Use `waitReason` for an external condition, and set it to an empty string to clear the wait.

The persistent widget has two saved sizes:

- `compact` shows one summary row and the current useful task.
- `plan` shows up to five unfinished tasks and a count for hidden tasks.

Run `/todos` or `/todos full` to open the complete scrollable overlay. Run `/todos compact` or `/todos plan` to change and save the widget size. `Ctrl+Shift+U` toggles the two widget sizes. The overlay supports Up, Down, Page Up, Page Down, Home, End, Escape, and Ctrl+C.

## Read-only provider contract

Todo exposes a same-process Pi event-bus contract. It remains the local plan and is not an orchestrator task authority.

- `pi-todo:request-summary-v1` request: `{ "requestId"?: string }`
- `pi-todo:summary-v1` response: `{ "version": 1, "requestId"?: string, "snapshot": ... }`
- `pi-todo:summary-changed-v1` notification: `{ "version": 1, "snapshot": ... }`

The snapshot is serializable and bounded. Its exact shape is:

```json
{
  "version": 1,
  "currentUsefulTask": { "id": "T1", "text": "...", "status": "pending", "waitReason"?: "..." },
  "unfinishedTasks": [{ "id": "T1", "text": "...", "status": "pending", "waitReason"?: "..." }],
  "countsByState": { "pending": 0, "in_progress": 0, "blocked": 0, "done": 0 },
  "externalWaits": [{ "id": "T1", "reason": "..." }],
  "planSize": 0
}
```

`unfinishedTasks` and `externalWaits` contain at most five entries. Task text and wait reasons are capped at 240 characters. The snapshot has no mutation callback and no full history. Todo emits `summary-changed-v1` after each committed mutation and answers requests after session startup. Event listeners are removed on session shutdown and reload.
