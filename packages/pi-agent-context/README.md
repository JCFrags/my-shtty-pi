# Pi Agent Context

A small Pi extension that supplies cache-conscious environment grounding and makes Pi's effective context observable.

## Snapshot behavior

The extension sends one hidden, model-visible context snapshot on the first agent prompt. It does **not** update the snapshot on ordinary user turns.

A fresh snapshot is added only at a context boundary:

- New, resumed, forked, or reloaded session.
- Compaction.
- Model change.
- Session-tree navigation.
- Explicit `/context-refresh`.

The snapshot contains:

- Current local calendar date in `YYYY-MM-DD` form. It does not contain local or UTC clock time.
- Operating system, kernel, and architecture.
- Pi bash shell, current working directory, and non-persistent-call behavior when bash is active.

The snapshot does not include Git branch, revision, dirty count, or divergence. Those values change often and can invalidate an otherwise reusable provider prompt-cache prefix. Agents can inspect Git when a task needs current repository state.

The model-visible snapshot bytes are stable for the same date when its necessary environment facts are unchanged. The date changes at the next local calendar date. Mutable facts should still be checked directly when exact current state matters.

## Cache boundary

Pi builds the system prompt before this extension adds the snapshot as a hidden conversation message. The system prompt, project instructions, security rules, skill catalog, active tool prompt text, tool schemas, and working directory form the reusable prefix when their bytes do not change.

User messages, assistant messages, tool calls, and tool results are turn-local conversation content. They extend the prefix and are not expected to stay the same across different tasks. The snapshot is also conversation content. Pi stores an exact capture timestamp in the custom message's extension-only `details` for the private audit. Pi's LLM conversion sends the snapshot content but omits those `details`, so the exact timestamp does not enter the provider prompt.

Necessary changes still invalidate part of the cache. Examples include a different working directory, changed project instructions, a different active tool set, a model change, compaction, and a requested context refresh. This extension does not remove or weaken those inputs.

## Commands

### `/context-audit`

Adds a TUI-only session entry summarizing:

- Effective system-prompt size.
- Loaded context files and skills.
- Prompt snippets and guidelines.
- Active and hidden tool-definition costs.
- Latest context snapshot and refresh policy.

The report is not sent to the model.

Use `/context-audit prompt` to include the exact effective system-prompt text in that private report.

### `/context-refresh`

Explicitly append a fresh snapshot without triggering a model turn.

## Why this is separate from Progressive Tools

Progressive Tools owns capability discovery and lazy tool activation. Pi Agent Context owns environmental facts and context observability. Neither reimplements Pi's native provider tool-loading behavior.

## Local check

```bash
npm test
```
