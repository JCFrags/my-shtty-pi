# @grounded/pi-process

Exact-output process and session tools for Pi.

- `bash` runs a stateless command. It supports complete logs, explicit yielding, background work, input, interruption, termination, and optional PTY use.
- `process` controls commands returned by Grounded `bash`.
- `session` manages explicit persistent shell sessions. Stateless `bash` remains the default.

The current Grounded Session Service stage supports local non-PTY and PTY `open`, `list`, `status`, `input`, `interrupt`, and `close`. Use `capabilities` to inspect available providers. A separately loaded Native SSH package can register one non-PTY SSH provider. PTY input accepts literal UTF-8 text or canonical padded base64 bytes while a structured command is running. `bash.sessionId` runs one serialized command in an explicit local or SSH session. Omit it for unchanged stateless behavior.

When `bash.sessionId` is present, do not provide `cwd`, `background`, `yieldMs`, or `pty`; the session already owns those properties. Session command timeout and Pi cancellation still apply.

One Pi extension runtime owns one in-memory registry. It permits at most four live sessions. A local session preserves its shell environment, functions, and working directory without changing Pi's working directory. Commands and session-aware file operations serialize within each session. Grounded Process publishes operation service v1 for accepted local compatibility and side-by-side operation service v2 for provider-neutral file resources. Grounded Files uses this boundary without owning or importing a second live registry. A private framed control channel reports completion; prompt text is never parsed. Non-PTY stdout and stderr stay separate. PTY output uses one merged `terminal` stream. Both forms use mode-`0600` JSONL logs. The persistent PTY bridge needs Python 3, uses a fixed 80-by-24 terminal, and disables terminal echo by default. Exact input means exact bytes are written to the PTY; terminal line discipline or an application can still transform them. Reload, shutdown, session replacement, fork, and successful tree navigation close all owned sessions and process groups.
