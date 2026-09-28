# Pi Tool Controls

- Purpose: Provide mouse-first tool-output controls for later host compatibility work.
- Status: inactive
- Pi entrypoint(s): `./extensions/tool-controls.ts`
- Load form: source-loaded when explicitly activated
- Build/check command: `npm run typecheck`
- Deployment hash verification command: `node ../../scripts/verify-deployed-baseline.mjs --product pi-tool-controls`

## Pure presentation library

`pi-tool-controls/presentation` is a separate ESM library with structural TypeScript declarations. Importing it does not import or activate the inactive bulk-controls extension. The existing `pi.extensions` registration is unchanged.

`createToolPresentation({ call, result })` returns only `renderShell: "self"`, `renderCall`, and `renderResult`. `call(args, context)` returns a short title. `result(savedResult, options, context)` returns display copies:

- `summary`: one status row, with optional semantic `tone`.
- `notices`: priority rows before excerpts. Each notice is bounded to one visual row. If the budget cannot show all notices, a separate row gives the omitted-notice count.
- `lines`: saved excerpts, wrapped at the current render width.
- `omitted`: evidence exists outside the preview.
- `quiet`: suppress the collapsed body, not the call or expanded view.

The component uses one call row and at most five collapsed or nine expanded result rows. It adds a raw JSONL export cue on every expanded view and clipped result preview. The cue counts within the budget. Pi's preceding separator and separate image rendering do not. Tabs and terminal control sequences are normalized only in display copies. Owners must provide concise status/notice labels and honest omission flags, preserve warning priority, and avoid mutating arguments or results. Do not set `quiet` on warning, error, or partial states.

The library performs no registration, execution, filesystem/network access, event handling, or state persistence. Domain rules stay with each tool owner. It is not a result transformer, inspector, transcript grouper, or execution wrapper. See [Grounded's display and raw-evidence instructions](../grounded-tools/README.md#compact-human-tool-display) for the first consumer and privacy limits.
