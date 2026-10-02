# Pi Agent Context

This source-loaded extension supplies a bounded date, operating-system, architecture,
and shell snapshot. It refreshes at session start/reload, compaction, model change,
tree navigation, or `/context-refresh`, not on every user turn. It registers no model
tools.

## Install

Use the full retained checkout described in [installation](../../docs/installation.md).
Set `REPO` to its absolute path, then register the package once:

```sh
pi install "$REPO/packages/pi-agent-context"
```

Local `pi install` registers source without copying it or installing dependencies.
Keep `extensions/index.ts` and `extensions/snapshot.ts` together. No build or
package-local dependency installation is required for runtime use. The installed Pi
loader supplies the Pi and TUI imports.

The manifest declares Pi/TUI `>=0.84.0 <0.85.0` and its development lock pins 0.84.1.
Registration on a newer host does not establish complete compatibility. Do not
change that range or install a second host copy merely to make registration pass.
Verify the commands and snapshot boundaries on the intended host.

## Use and checks

- `/context-refresh` inserts a fresh model-visible snapshot without starting a turn.
- `/context-audit` saves a local report of prompt inputs, active/hidden tools, and
  approximate token costs. It does not send that report to the model.
- `/context-audit prompt` also includes the effective system prompt. Keep this
  potentially private report out of public logs and Git.

No configuration file, credentials, or service is required. Environment facts come
from the local system. The shell description appears only when `bash` is active.

From the repository root, stage intended changes before current verification:

```sh
npm run verify -- --product pi-agent-context
```

`DEPLOYED.sha256` and `verify:history` describe the original imported baseline, not
current installation health. Existing sessions need a safe reload to load a changed
source. Preserve managed jobs and unsent drafts during that step.
