# @grounded/pi-tasks

Visible branch-aware Pi task plans with dependencies, external wait reasons, cycle validation, transactional mutations, and session-tree persistence. Use `blockedBy` for task dependencies. Use `waitReason` for an external condition, and set it to an empty string to clear the wait.

The persistent widget has two saved sizes:

- `compact` shows one summary row and the current useful task.
- `plan` shows up to five unfinished tasks and a count for hidden tasks.

Run `/todos` or `/todos full` to open the complete scrollable overlay. Run `/todos compact` or `/todos plan` to change and save the widget size. `Ctrl+Shift+U` toggles the two widget sizes. The overlay supports Up, Down, Page Up, Page Down, Home, End, Escape, and Ctrl+C.
