# Pi Native SSH

Pi Native SSH routes Pi 0.84.1 built-in tools to one explicitly selected OpenSSH host. Local mode stays the default. The selected route is visible in the Pi footer and widget.

Remote mode provides:

- native `read`, `ls`, `find`, `grep`, `write`, `edit`, and `bash` tools;
- bounded upload and download through `ssh_transfer`;
- atomic file replacement with one same-directory rollback copy;
- cancellation, command timeouts, bounded output, typed errors, and a private metadata log;
- strict non-interactive OpenSSH with existing SSH configuration, authentication, and host trust.

User `!` commands always stay local.

## Requirements

- Pi 0.84.1.
- Node.js 22.19 or later.
- `/usr/bin/ssh`.
- An existing OpenSSH alias, trusted host key, and non-interactive authentication.
- Remote Python 3, `/bin/sh`, `rg`, and `fd`.
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

After `use`, the normal Pi file and shell tools operate on the selected host. `ssh_transfer` uploads, downloads, or rolls back one bounded file. An agent can supply its optional `target` parameter to activate a configured route. If exactly one target is configured, `ssh_transfer` selects it automatically when no route is active. If several targets are configured, the tool error lists the valid names and asks for `target` or `/remote use TARGET`. Download paths must remain under Pi's local working directory. Downloads do not overwrite an existing local file unless `overwrite` is true.

Ordinary non-interactive commands run directly. The extension asks for visible confirmation when a command clearly changes trust or appears broadly destructive. It refuses command forms that can expose credentials. Use a visible user-controlled terminal for credentials, MFA, host trust, or interactive prompts.

## Limits and file rollback

The default example permits a 60-second command and an 8-MiB file transfer. Command stdout and stderr are each limited to 64 KiB in the remote helper. Native Pi rendering applies its normal output bounds.

Writes use a temporary file and atomic rename. The helper keeps one prior version beside the target as `.pi-native-ssh-backup-NAME`. A newly created file uses `.pi-native-ssh-new-NAME` as a rollback marker. A later write replaces the previous rollback point.

Use `/remote rollback PATH` or `ssh_transfer` action `rollback`. Rollback restores the latest prior file or removes a file that the latest write created. Rollback does not apply to arbitrary shell commands. Cancellation and timeout do not claim remote rollback.

## Private audit log

The optional JSONL log records bounded metadata only. It does not record command text, paths, file content, environment values, credentials, or raw diagnostics. The log and its parent directory must be private. Log write errors do not change tool results.

## Validation

```sh
npm test
python3 -m py_compile src/helper.py
```

The automated suite covers protocol parsing, OpenSSH argument policy, host-key failures, cancellation, timeout, output bounds, native result shapes, file write/read/rollback, transfer primitives, command policy, private logs, and controller state.

`acceptance/run.py` is an environment-specific live harness. It requires a configured alias named `server`. It creates a new temporary remote directory, runs harmless commands, performs a write/read/edit/upload/download/delete cycle, tests timeout, cancellation, and output limits, clears the route, and leaves its local evidence directory in `/tmp` for inspection.

## Uninstall and rollback

```text
/remote clear
```

Then remove the exact installed source:

```sh
pi remove --approve /absolute/path/to/packages/native-ssh
```

Restart Pi or run `/reload`. Removing the package does not change SSH configuration, SSH trust, remote account permissions, or existing remote files. Remove rollback sidecars only after you no longer need their rollback data.

## Security and provenance

Read [SECURITY.md](SECURITY.md) and [PROVENANCE.md](PROVENANCE.md). Remote output and files are untrusted data. The remote account remains the authorization boundary.

## License

MIT. See [LICENSE](LICENSE).
