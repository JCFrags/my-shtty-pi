# Herdr Agent State

This source-loaded extension reports Pi lifecycle state and native session identity
to Herdr. It is separate from sidebar/title presentation and Dialog's blocking
question signals. Orchestration depends on this reporting in a real Pi terminal,
not just on successful factory registration.

## Install and ownership

Use the full retained checkout described in [installation](../../docs/installation.md).
Set `REPO` to its absolute path. Register this package only if the same extension is
not already loaded through Herdr's integration or automatic extension discovery:

```sh
pi install "$REPO/packages/herdr-agent-state"
```

Load exactly one copy. Do not combine the package registration with a same-source
`herdr-agent-state.ts` automatic alias. Inspect the complete resource inventory
before removing or replacing any existing registration.

The extension imports only Node's `net` module. It needs no build, package-local npm
installation, token, or settings file. Local `pi install` does not copy source.
Keep the selected checkout until no process or rollback needs it.

The source is marked as Herdr-managed integration version 9. Reinstalling or
updating Herdr's integration can replace its managed file. Review the resulting
source and registrations rather than editing a managed file in place or loading a
second reporter beside it.

## Runtime and verification

Herdr supplies `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` to its Pi
process. Reporting is inactive outside that environment. Do not invent those values
or copy another pane's identity. Launch Pi through the intended Herdr integration.

The reporter reads the native session identity from Pi's active session manager.
Verify that the intended Pi pane reports its actual saved session and lifecycle
state. A factory-only loader has not started a session and cannot establish this.
Sidebar metadata or title text is not a substitute for native identity reporting.

From the repository root, stage intended changes before current verification:

```sh
npm run verify -- --product herdr-agent-state
```

`DEPLOYED.sha256` and `verify:history` describe the original imported baseline.
Existing sessions need a safe reload for a source change. Preserve managed jobs and
unsent editor drafts. Keep previous code available until loaded-session adoption and
rollback ownership are resolved.
