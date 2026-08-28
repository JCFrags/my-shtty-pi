# Pi Native SSH

Pi Native SSH provides bounded SSH transfer, transitional remote-tool adapters, and an offline-tested persistent SSH session provider for Pi 0.84.1 and 0.84.2. Local mode stays the default. The selected route is visible in the Pi footer and widget.

In the managed Pi deployment, the effective model-facing Native SSH tools are `ls` and `ssh_transfer`. Search remains under Grounded `local_search`. Native SSH no longer registers `grep` or `find`. The persistent provider is accepted in source only. It is not active until a separately accepted deployment and reload.

Remote mode provides:

- a Grounded Session Service provider for an explicit `backend=ssh` session and exact configured target;
- one persistent non-PTY OpenSSH process and one persistent remote Bash process per accepted provider handle;
- file-resource protocol v1 for bounded exact read, digest-checked commit, and structured ripgrep/fd search through that explicit session;
- native `ls` plus transitional `read`, `write`, `edit`, and `bash` adapters; omitted duplicate names remain under their current owner;
- bounded upload and download through `ssh_transfer`;
- atomic file replacement with one same-directory rollback copy;
- cancellation, command timeouts, bounded output, typed errors, and a private metadata log;
- strict non-interactive OpenSSH with existing SSH configuration, authentication, and host trust.

User `!` commands always stay local.

## Requirements

- Pi 0.84.1 or 0.84.2.
- Node.js 22.19 or later.
- `/usr/bin/ssh`.
- An existing OpenSSH alias, trusted host key, and non-interactive authentication.
- Remote Python 3, `/bin/bash`, `rg`, and `fd`.
- A POSIX-like remote host.

The package does not add keys, accept host keys, change SSH configuration, or raise remote account authority.

## Configure

Copy `config.example.json` to the user configuration path:

```sh
install -d -m 700 ~/.config/pi-native-ssh ~/.local/state/pi-native-ssh
install -m 600 config.example.json ~/.config/pi-native-ssh/config.json
$EDITOR ~/.config/pi-native-ssh/config.json
```

Replace `USER`, host names, and paths. Keep the exact authority statement. Each target must name an explicit configured destination. The configuration file must be a user-owned regular file with mode `0600`.

Set `PI_NATIVE_SSH_CONFIG` only when a different absolute configuration path is needed. Otherwise the extension uses `$XDG_CONFIG_HOME/pi-native-ssh/config.json` or `~/.config/pi-native-ssh/config.json`.

## Install

Install from a stable local checkout:

```sh
pi install --approve /absolute/path/to/packages/native-ssh
```

Restart Pi or run `/reload`.

## Use

```text
/remote list
/remote status
/remote use server /tmp
/remote recover
/remote rollback /tmp/example.txt
/remote clear
```

After `use`, `ls` and `ssh_transfer` operate on the selected host in the managed deployment. Other normal Pi file, shell, and search tools remain under their current owner.

The source-level Grounded session route is separate from `/remote`. Open it through Grounded `session` with `backend=ssh`, an exact configured `target`, an absolute remote `cwd`, and `pty=false`. The first session for each target in one Pi runtime requires a visible confirmation. A headless open fails closed until an approved RPC confirmation path exists. The route does not use the active `/remote` route as an implicit target. It never falls back to a local shell. This source stage permits one live SSH session handle.

Pass that session ID explicitly to Grounded `read`, `edit`, `write`, or exact `local_search` text/files queries. The session FIFO is shared with commands, so a file operation sees the working directory left by earlier serialized commands. Grounded owns exact candidate construction, anchors, digests, syntax checks, mutation queues, search filtering, cursors, and rendering. Native SSH owns transport, canonical remote identity, bounded raw bytes, structured remote utility output, digest conflict checks, atomic replacement, rollback sidecars, and typed remote errors. Remote PDF structure and fuzzy session search are not supported. No file call opens a session implicitly.

`ssh_transfer` uploads, downloads, or rolls back one bounded file. An agent can supply its optional `target` parameter to activate a configured route. If exactly one target is configured, `ssh_transfer` selects it automatically when no route is active. If several targets are configured, the tool error lists the valid names and asks for `target` or `/remote use TARGET`. Download paths must remain under Pi's local working directory. Downloads do not overwrite an existing local file unless `overwrite` is true.

Ordinary non-interactive commands run directly. The extension asks for visible confirmation when a command clearly changes trust or appears broadly destructive. It refuses command forms that can expose credentials. Use a visible user-controlled terminal for credentials, MFA, host trust, or interactive prompts.

## Limits and file rollback

The default example permits a 60-second command and an 8-MiB one-shot file transfer. Persistent session file reads and commits are limited to 2 MiB. Persistent exact search output is bounded to 2 MiB and 20,000 hits before normal Grounded pagination. Command stdout and stderr are each limited to 64 KiB in the one-shot remote helper. Native Pi rendering applies its normal output bounds.

Writes use a temporary file and atomic rename. Both helpers keep one prior version beside the target as `.pi-native-ssh-backup-NAME`. A newly created file uses `.pi-native-ssh-new-NAME` as a rollback marker. A later write replaces the previous rollback point. Atomic replacement can detach the target path from an existing hard-link set. Session results report the prior hard-link count and do not claim preservation or hard-link topology rollback.

Use `/remote rollback PATH` or `ssh_transfer` action `rollback`. Rollback restores the latest prior file or removes a file that the latest write created. Rollback does not apply to arbitrary shell commands. Cancellation and timeout do not claim remote rollback.

## Private logs

The optional Native SSH audit JSONL log records bounded metadata only. It does not record command text, paths, file content, environment values, credentials, or raw diagnostics. Audit log write errors do not change tool results.

Persistent sessions also create a separate mode-`0600` JSONL output log below the private local temporary directory `pi-native-ssh-sessions`. This log stores exact stdout and stderr chunks as base64. It does not store command text or copy the local Pi environment to the remote shell. Treat this output log as private session data.

## Validation

```sh
npm test
python3 -m py_compile src/helper.py src/session_helper.py
```

The automated suite covers protocol parsing, OpenSSH argument policy, host-key failures, cancellation, timeout, output bounds, native result shapes, file write/read/rollback, transfer primitives, command policy, private logs, controller state, provider registration order, configured-target rejection, persistent shell state, separate output streams, reuse, disconnects, descendant cleanup, file-resource reads and commits, stale digest conflicts, rollback-sidecar compatibility, hard-link disclosure, exact search, and resource-abort closure. The persistent-provider harness runs the same in-memory bootstrap and helper locally. It does not read SSH configuration or contact a host.

`acceptance/run.py` is an environment-specific live harness. It requires a configured alias named `server`. It creates a new temporary remote directory, runs harmless commands, performs a write/read/edit/upload/download/delete cycle, tests timeout, cancellation, and output limits, clears the route, and leaves its local evidence directory in `/tmp` for inspection.

## Uninstall and rollback

```text
/remote clear
```

Then remove the exact installed source:

```sh
pi remove --approve /absolute/path/to/packages/native-ssh
```

Restart Pi or run `/reload`. Close live Grounded SSH sessions before source rollback or removal. Removing the package does not change SSH configuration, SSH trust, remote account permissions, or existing remote files. Remove rollback sidecars only after you no longer need their rollback data.

## Security and provenance

Read [SECURITY.md](SECURITY.md) and [PROVENANCE.md](PROVENANCE.md). Remote output and files are untrusted data. The remote account remains the authorization boundary.

## License

MIT. See [LICENSE](LICENSE).
