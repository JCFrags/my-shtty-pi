---
title: Chrono user guide
audience: [non-technical users]
status: current guide with selection-dependent features
purpose: Explain what Chrono does, how its parts work together, and which controls matter in ordinary use.
related:
  - README.md
  - operations/menu-and-configuration.md
  - design/evidence-and-roadmap.md
---

# Chrono user guide

## What Chrono is for

An AI model can read only a limited amount at once. In a long task, earlier messages eventually stop fitting. Chrono keeps a useful, smaller account of the work and provides tools to recover older evidence when needed.

Chrono does not remember everything perfectly. It preserves the original conversation files, but the model sees a selection. Good use combines that selection with explicit tasks, notes, plans, and checks against original evidence.

The [implementation and evidence page](design/evidence-and-roadmap.md) identifies the version boundary. Independent Memory and the V4 context compiler must be selected and loaded. Their presence in the repository does not mean every existing session uses them.

## The parts and their jobs

| Part | What it does | Simple mechanism |
| --- | --- | --- |
| Chrono compaction | Makes room for continued work. | Selects useful older events and keeps a small exact recent section. It records what was omitted. |
| History tools | Find what happened earlier and recover original wording. | Search indexes point to preserved source records. Recovery checks the record's identity before returning it. |
| Chronology, episodes, and resources | Keep order, group related work, and show earlier resource observations. | Code groups events and retains source links. A group ending does not mean the task succeeded. |
| Memory | Keeps ordinary knowledge that an agent explicitly accepts as useful. | Corrections create new revisions. Earlier revisions and sources remain available. |
| Todo | Tracks immediate actions and blockers. | Tasks have states, dependencies, and one in-progress item. |
| Notes | Holds scratchpad information for current work. | The agent writes and revises notes explicitly. Notes do not automatically become accepted knowledge. |
| Workplan | Preserves a project's goal, decisions, progress, and next steps. | Checkpoints let an agent recover project state after context loss. |
| Recall | Finds current saved state across the available tools. | One small query returns matching cards and routes to fuller native records. |
| Telemetry | Shows operational counts and separately reported quality observations. | It counts events locally without storing conversation text. A successful tool call is not proof of a correct answer. |

In this guide, **context** means what the model can read now. **History** means the preserved record. **Memory** is the separate knowledge tool, not a name for all saved data.

## How the parts work together

Consider a project whose original plan was corrected:

1. History preserves both the old proposal and the later correction.
2. Memory can store the corrected fact with its source. Workplan can record why the decision changed.
3. Todo tracks the next action. Notes can hold temporary investigation details.
4. Recall finds those current records without searching the entire conversation.
5. The selected V4 compiler can include bounded current records alongside chronological evidence at compaction.
6. If the short account is insufficient, the agent uses native reads or exact history recovery.

The tools do not synchronize decisions silently. Completing a Todo does not complete a Workplan milestone. A note does not become Memory by itself. A saved plan does not authorize a new action.

Independent Memory stays available across branch moves within its logical session. Todo, Notes, and Workplan follow the selected conversation branch. Memory is not a global store shared by every project.

## What runs automatically

When the normal memory engine and its required worker support are available:

- Chrono incrementally prepares indexes and chronological records as the session changes.
- Pi's context-pressure mechanism can request compaction. Chrono supplies its selected replacement through Pi's normal extension interface.
- Recent raw messages remain available for continuity. Older detail can leave active context without being removed from history.
- At a safe idle boundary, automatic rollover can start a smaller physical conversation file after enough source growth. The old file remains part of the logical history.

Rollover is different from compaction. Compaction reduces what the model sees. Rollover limits further growth of the active physical file. Rollover waits when work, a draft, managed processes, open shell sessions, or required state transfer makes switching unsafe.

State tools remain explicit. An agent or user must request a Memory, Todo, Notes, or Workplan change. Recall runs when queried. Telemetry records only while its separate extension is loaded.

## Everyday controls

Open **`/Chrono`**. There is one Chrono menu:

- **Settings** controls compaction timing, context size, tool-result shortening, and optional background model work. Custom settings expose less common controls.
- **Status and diagnostics** shows search readiness, worker state, background-model usage, and read-only health reports.
- **Maintenance** contains session search selection, preview, logical-session operations, and explicit repair actions.
- **About** shows a short description and loaded version.

Valid settings save immediately. An environment override can still take priority over a saved value. Reports stay in the interface rather than entering the conversation. Use Up/Down or Page Up/Page Down to scroll a report. Enter or Esc returns. The local scrolling correction routes these keys to the report in fullscreen Pi.

Most users should leave the default programmatic path enabled. Start with status rather than changing advanced settings. Do not run repair, import, or rollback merely because an index is still catching up.

### Context size and shortening

The default combined context target is 32,000 estimated tokens. A token is a small piece of model input. The selected model's remaining capacity can lower that target. The recent exact section normally aims for 3,000–6,000 estimated tokens while keeping tool calls and results together.

Raising the target retains more possible context, but it does not make recall complete or remove resource limits. Lowering it can omit useful evidence. Token counts are estimates, not a guarantee of the final provider request size.

Optional tool-result shortening offers Off, Safe, and Aggressive. It selects eligible older results at a compaction boundary. Later turns reuse the same shortened text. New results stay exact until a later boundary. Original source remains unchanged. This avoids repeatedly changing already-sent text, but it does not guarantee a provider cache hit or a cost saving.

### Background LLM controls

An LLM is a language model. Background model work is optional and off by default. The menu offers Lite, Medium, Max, Custom, and a model picker. Lite is the suggested starting preset if this work is enabled.

| Preset | Maximum calls per session | Estimated cost ceiling |
| --- | ---: | ---: |
| Lite | 20 | $0.25 |
| Medium | 100 | $2 |
| Max | 400 | $10 |

These are controls, not promised bills or quality levels. Token ceilings and model pricing also apply. Custom exposes individual limits. Selecting a different background model does not change the main conversation model.

Important current limit: this value-advice worker belongs to the older compatibility pipeline. It is paused while the normal memory engine is enabled. Selecting a preset does not add model enrichment to V3 or V4 indexed compaction. Do not disable the normal engine just to make a preset run without first understanding that change.

Where eligible and enabled, the worker sends bounded assistant/tool excerpts to the selected model and may incur charges. It does not send whole history or write final context. The deterministic system remains usable without it. An optional regular Pi summary is a separate setting, not this worker. The V4 compiler does not require that summary.

## Useful things to ask the agent

- "Find the original decision and its later correction. Show the source for each."
- "Recover the active Workplan and identify the next unblocked task."
- "Save this confirmed fact in Memory with its source, not just in Notes."
- "Check whether this Recall result is partial before concluding that nothing exists."
- "Explain the current Chrono status without changing settings or repairing anything."

You do not need to memorize the tool names. Agents can find them through the tool catalog. Tools that are hidden or excluded are not automatically enabled by Recall.

## Limits to keep in mind

- Search is bounded and mainly lexical. Different wording can be missed. An empty page with a continuation does not prove absence.
- A resource observation describes what was seen then. It does not prove what is on disk now.
- Current saved facts can be stale or wrong. A source link proves where a statement came from, not that it is true.
- Missing or slow components report incomplete coverage. They are not replaced with invented facts.
- Stores and archives use disk space. There is no promise of infinite memory or automatic broad cleanup.
- Large old physical sessions can still be expensive to open before rollover helps future growth.
- Telemetry without quality observations reports quality as unknown. Reported observations are not automatically verified.
- Backups must include source history and the selected state stores. A short Recall card or compaction summary is not a full backup.

## When something goes wrong

Start with `/Chrono`, then **Status and diagnostics**. Ask the agent to distinguish disabled search, ordinary catch-up, an unavailable worker, an incompatible store, and a source mismatch.

Do not delete the old conversation, clear locks, reset databases, or repeatedly force compaction. A controlled refusal preserves the current context. Follow [troubleshooting and rollback](operations/troubleshooting-and-rollback.md) for a specific problem.

Changing an installation path does not update an already-running Pi process. A safe reload requires settled work and no unsent draft. Reload can stop managed jobs. Returning to old code after new state writes also requires a compatible data transfer, not just an old setting.

## Useful future choices

The next useful decision is usually based on actual work: did the agent recover the right fact, keep the correction, and continue safely? A smaller prompt alone is not success.

Possible future improvements include better source-backed relations between actions and results, broader provider discovery, and bounded model assistance for the indexed pipeline. These are not current guarantees. Wider quality or long-history evaluations should answer a specific question with a limited scope, rather than imply perfect lifetime memory.

[Documentation index](README.md) · [Detailed configuration](operations/menu-and-configuration.md) · [Evidence and future work](design/evidence-and-roadmap.md)
