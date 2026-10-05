# Pi Reload

One `reload-pi` agent tool, one `/reload+` operator menu, and one safety engine for the current interactive Pi session or local fleet. Reload uses Pi's native handler, not terminal input or a process restart. The installation package name remains `pi-self-reload`.

## Install

Requires Pi 0.99.1 or compatible later behavior, in TUI mode. Pi supplies the host modules. No build or package-local dependency installation is needed.

```sh
pi install "$PWD/packages/pi-self-reload"
```

Select only the package entrypoint. Do not also register `extensions/reload-all.ts`. Preserve unrelated package order and settings. Follow the [activation procedure](../../docs/activation.md). Source selection does not change code already loaded by a session.

Existing sessions need a safe initial native reload to load this version. The private bootstrap adapter accepts a safe request from the previous fleet engine and consumes its same-session handoff once. It does not add old public tool or command aliases. Unloaded, older, unavailable, and noninteractive sessions cannot participate in cooperative preparation. The extension does not type into those sessions or force them to join.

## Agent tool

The tool is `reload-pi`. Defaults are `action: "reload"`, `scope: "self"`, and `resume: true`.

```json
{"action":"reload"}
{"action":"reload","scope":"all"}
{"action":"reload","scope":"all","resume":false}
{"action":"status"}
{"action":"status","scope":"all"}
```

Use self scope for stale reloadable resources in this session. Use all scope only for an approved local rollout after installing the update. A push does not install it. Reload does not build packages, install dependencies, migrate state, repair unrelated failures, or certify resource health.

1. Save necessary task state and finish useful background jobs.
2. Call reload alone as the final action. Mixed and nested batches are refused.
3. The tool returns `terminate: true`. The native command waits for that exact successful result and native idle. It does not abort its own executing tool.
4. Fleet peers prepare and reload independently. The caller reloads after their outcomes are known or their bounded deadline ends.
5. By default, original unfinished tasks interrupted by this operation can resume once, after the native handler returns. Idle/completed tasks stay idle. `resume: false` disables continuation for every participant, not only the caller.
6. Check fresh loaded status and native diagnostics. A queued result is not completion. Never repeat an uncertain reload.

Status returns loaded version, instance ID, engine SHA-256, mode, and pending operation. All scope includes participants and unavailable-endpoint errors. Status does not reload or start a model request. Participant count is not total Pi process count.

## Operator menu

Run `/reload+` without arguments. Its TUI menu contains:

- Reload this session.
- Reload this session, do not resume.
- Reload all local sessions.
- Reload all local sessions, do not resume.
- Status and pending operations.

Cancel closes the menu without a change. The built-in `/reload` remains unchanged. The extension no longer registers `/self-reload` or `/reload-all`. Resolve this caller's open prompt before opening another menu.

## Cooperative preparation

An executing tool is not immediately skipped or interrupted. The engine waits for the entire batch's persisted result boundary. A safe peer can reload while another peer waits. A busy peer that finishes its task naturally does not gain a continuation.

If managed jobs, shell sessions, or a supported question wait block a peer, the engine can send a clearly labeled Pi Reload preparation message. An idle-but-blocked peer can start a preparation turn. The engine records the original active, idle, or waiting state before preparation. Preparation activity cannot turn an idle task into an unfinished task.

The preparation agent may use multiple calls to save state, settle useful jobs, or close unused task-owned shells. The first tool or turn end does not mean ready. The agent acknowledges the existing operation with its exact request ID:

```json
{"action":"ready","requestId":"00000000-0000-4000-8000-000000000000","outcome":"ready"}
{"action":"ready","requestId":"00000000-0000-4000-8000-000000000000","outcome":"finished"}
{"action":"ready","requestId":"00000000-0000-4000-8000-000000000000","outcome":"needs-attention","reason":"A useful job must remain running."}
```

Replace the example ID with the preparation message's ID. `finished` also declares the original task complete, which suppresses continuation. `needs-attention` preserves the session without reload. A successful ready result terminates that preparation run. The command still waits for its exact result, native idle, and fresh safety checks. Readiness never starts a second reload operation.

For a reported blocking `ask_user` or legacy `ask_user_question`, native abort can cancel the question-only wait to permit preparation. No other executing tool may accompany that exception. The saved conversation remains the source for re-asking. A reload-specific message states that Pi Reload cancelled the question, not the user. Cancellation provides no answer or approval. After reload, the default return message instructs only re-asking or re-entering the previous wait, not unrelated task work. No question store or suspend/restore subsystem is added. With continuation disabled, the session stays idle. Unknown prompts and approvals that cannot safely cancel remain protected and need attention.

## Safety and outcomes

- Preserve drafts, queued input, useful jobs, and user-owned resources. The engine never clears input, kills useful jobs, or relaunches them to pass a check. Other extensions can stop resources during `session_shutdown`.
- New input, session/tree changes, cancellation, or expiry prevent the affected pending reload or continuation. Accepted peers have independent identities and deadlines. Changing the coordinator's input does not resend or replace their requests.
- Preparation has a five-minute deadline. Each native stop/result wait has a 15-second limit. Cooperative sockets return a queued acknowledgement promptly. The coordinator polls only status, including the fresh endpoint after reload. It never retries preparation or reload after uncertainty.
- Expiry or refusal records a skipped outcome and ends the pending request. An active preparation receives a bounded-operation-ended message, not another reload. Useful executing calls can still settle normally. A missing fresh-runtime acknowledgement records unknown, never success.
- Fleet `last-result.json` contains identities, readiness phases, and outcomes, not conversation prompts. Process-local receipts remain bounded and available for status reconciliation after reload. They are not durable task state or permission to replay work.
- The optional `grounded:session-transition-readiness:v1` event reports managed process and shell-session counts. Missing or invalid owner data fails closed. This protocol and prompt events do not cover every third-party resource or core dialog. Inspect other session-owned work before use.
- Original-run interruption requires a captured live signal that this operation changes to aborted. A model-tool request instead requires its exact terminating result. Fresh continuation uses a one-shot process-local handoff after native handler return. It never replays after a restart or unrelated reload.

The private same-user Unix sockets work without Herdr. They do not cross machines or OS users. The default directory is `pi-reload-all-<uid>` below the OS temporary directory, mode `0700`, with sockets at `0600`. Set absolute `PI_RELOAD_ALL_DIR` before startup to partition a fleet. Each member must use the same directory. Do not remove a live coordinator's `fleet.lock`. After a crash, inspect its owner and prove that process is gone before removing only the stale lock.

## Implementation and checks

`extensions/index.ts` only re-exports the `reload-all.ts` factory. The factory owns the tool, menu, private queued-operation dispatch, readiness checks, sockets, and handoff. Internal command tokens are not user options.

Pi 0.99.1 requires `sendUserMessage(..., { expandPromptTemplates: true })` for intentional command dispatch. Only command contexts expose `waitForIdle()` and `reload()`. Lifecycle hooks never await their own idle boundary. After reload invalidates a runtime, old code uses only plain completion/receipt data, not its old `pi` or `ctx`.

After repository-root locked dependency preparation:

```sh
npm --prefix packages/pi-self-reload run syntax
npm --prefix packages/pi-self-reload test
```

The four focused checks cover dispatch/termination, stale contexts, independent multi-call preparation, persisted batch boundaries, fleet-wide no-resume, question-wait messaging, protected input/resources, and expiry. Exercise the changed behavior through installed Pi before activation. Factory inventory alone does not establish reload behavior.

See Pi's [extension documentation](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/extensions.md). Native Pi can catch late reload errors without rethrowing them. Require the `Reloaded keybindings, extensions, skills, prompts, themes, and context files` notification and available diagnostics when exposed. Fresh factory identity, native handler return, and resource health are separate evidence.
