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

## Checks and activation

From the full checkout root, `npm run verify:static` checks the supported indexed source. The old `verify-deployed-baseline.mjs` command verifies a historical Git baseline, not current installation or loaded use.

Follow the repository [activation procedure](../../docs/activation.md) for complete registration comparison, safe reload, and scoped rollback. Preserve live SSH sessions, transfer recovery records, private configuration, and audit data. A package-path change alone does not update running Pi sessions.
