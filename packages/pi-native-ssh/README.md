# Pi Native SSH

- Purpose: Provide explicit native SSH session and transfer tools.
- Status: active canonical
- Pi entrypoint(s): `src/index.ts`
- Load form: source-loaded

## Fresh checkout preparation

Use a retained full checkout and register only this package:

```sh
pi install "$REPOSITORY/packages/pi-native-ssh"
```

Set `REPOSITORY` to the absolute checkout path first. Local registration does not copy source or prepare dependencies. This package has no local dependency lock or build command. Pi supplies its `@earendil-works/pi-coding-agent` and `typebox` imports to the source-loaded entrypoint. Keep the package's `.mjs` modules and both Python helper files beside that entrypoint.

The manifest declares Pi `>=0.84.1 <0.84.3` and Node `>=22.19.0`. Registration on a newer Pi does not establish runtime compatibility. Do not widen the declared range or change SSH trust to make a loader check pass.

Remote operations use `/usr/bin/ssh` on the local host and `python3` on the remote host. Targets need working non-interactive OpenSSH authentication and already trusted host keys. The transport enables strict host-key checking, disables password prompts and forwarding, and does not enroll a new host key. OpenSSH configuration, host trust, and remote account permissions remain the authority boundary, not a package sandbox.

## Private configuration

The factory requires a private version-2 configuration even when no SSH target is configured. The default path is `$XDG_CONFIG_HOME/pi-native-ssh/config.json`, or `$HOME/.config/pi-native-ssh/config.json` when `XDG_CONFIG_HOME` is unset. `PI_NATIVE_SSH_CONFIG` selects an explicit path. Use an absolute path, an owner-only parent directory, and an owned regular non-symlink file with mode `0600`.

For a fresh isolated no-route check, this value permits loading without connecting to a host:

```json
{"version":2,"targets":{},"audit":{"enabled":false,"path":null,"maxBytes":4096},"limits":{"commandTimeoutMs":1000,"maxTransferBytes":1024}}
```

Do not overwrite an existing configuration with this example. Never copy real credentials or authorization records into source or a test fixture. Adding a target requires explicit confirmation of the OpenSSH and remote-account boundary. A no-route loader check does not verify an SSH connection, session, or transfer.

## Agent workflow

For repeated commands or file operations on a configured remote host, prefer a persistent SSH session. Ordinary local and one-shot commands still use `bash`. Keep shell SSH available when the native workflow cannot support the task.

1. Call `session({"action":"capabilities"})`. The SSH capability includes a sorted `targetAliases` array. This read-only call does not connect or change routing. It returns aliases only, not SSH destinations, account names, or private configuration.
2. Select an exact alias from that array. An alias is not necessarily the SSH hostname. An empty array means that no target is configured. Do not guess another name or add a target without approval.
3. Call `session({"action":"open","backend":"ssh","target":"ALIAS","cwd":"/"})`. Replace `ALIAS` with a discovered alias and choose the required absolute working directory. The existing visible first-session confirmation still applies. Native SSH sessions do not support PTY or terminal input.
4. Pass the returned `sessionId` to `bash` for commands, or to Grounded `read`, `edit`, `write`, and `local_search` for remote file operations. These calls use that explicit session. Opening a session does not activate `/remote` routing or change calls that omit `sessionId`.
5. Close the session with `session({"action":"close","sessionId":"SESSION_ID"})` when the work is complete. Replace `SESSION_ID` with the returned ID.

An invalid SSH session target fails before connection or confirmation. The error lists configured aliases, or states that none are configured. It does not select a replacement target automatically.

`ssh_transfer` remains available for bounded upload, download, and remote-write rollback. Its target argument also uses configured aliases. The human `/remote list` command remains available. A `/remote` route change is separate from an explicit Grounded session.

## Checks and activation

From the full checkout root, `npm run verify:static` checks the supported indexed source. The old `verify-deployed-baseline.mjs` command verifies a historical Git baseline, not current installation or loaded use.

Follow the repository [activation procedure](../../docs/activation.md) for complete registration comparison, safe reload, and scoped rollback. Preserve live SSH sessions, transfer recovery records, private configuration, and audit data. A package-path change alone does not update running Pi sessions.
