# @grounded/pi-workplan

Detailed session-tree execution specifications for Pi.

Workplan stores objectives, scope, milestones, criteria, decisions, risks, questions, checkpoints, evidence, and revision history. It follows the active branch.

Milestones do not replace the separate todo tool. Todo IDs are unverified external references. The packages do not read or change each other's state.

Workplan has no file export or import. Use `workplan(read)` and then call the separate reviewed `write` tool when explicit file output is required.

Do not store passwords, keys, tokens, cookies, private keys, or other secrets in workplans.
