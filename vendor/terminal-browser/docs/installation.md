# Installation, updates, and rollback

[Product guide](../README.md) · [Development](development.md) · [Pi adapter](../pi-extension/README.md)

Use reviewed artifacts from a `terminal-browser-vVERSION` release in
`JCFrags/my-shtty-pi`. This is a separate product release namespace. Do not use
an upstream curl installer, Homebrew package, or `terminal-browser upgrade`.
The latter is disabled for managed installations.

## Requirements

- Fresh managed installation currently supports Linux x64. Source build branches
  for other platforms are not equivalent to installer acceptance.
- First installation needs Node and Python 3.11 or newer, `tar`, and `sha256sum`.
  It does not need a checkout, pnpm, Pi, or Herdr. The retained artifact manager
  uses its bundled Electron runtime for Node on later updates.
- The browser needs the host's Linux graphics/system libraries and a real TTY
  with working Kitty graphics protocol support. See [support limits](../README.md#supported-environments-and-limits).
  An SSH host or a piped shell is not automatically a visible browser terminal.
- Put the selected CLI directory on `PATH`. The default is `$HOME/.local/bin`.

## Fresh CLI-only installation

Download the release assets from the trusted repository release into a new local
directory: the installer archive, platform runtime archive, platform manifest,
and `SHA256SUMS`. Use one release's matching files. The example version below is
`0.1.1`; replace it only with the version whose assets you reviewed.

Checksums detect transfer changes. They do not authenticate a publisher if the
checksum file came from an untrusted source. Review the release source before
executing its installer.

```sh
sha256sum -c SHA256SUMS
tar -xzf terminal-browser-installer-0.1.1.tar.gz
MANAGER="$PWD/terminal-browser-installer/install.sh"
INSTALL="$HOME/.local/share/terminal-browser-managed"
"$MANAGER" init "$INSTALL"
"$MANAGER" stage "$PWD/terminal-browser-0.1.1-linux-x64.tar.gz" "$PWD/manifest-linux-x64.json" "$INSTALL"
```

The installer archive includes `install.sh`, its manager/verifier/extractor,
`LICENSE`, and `SOURCE.md`. No source checkout is needed. `init` creates a private
installation receipt and a fresh state namespace. By default it selects only the
CLI and creates no Pi package, Herdr plugin, or skill declaration. It refuses
occupied selections rather than deleting them. For an existing installation, use
the reviewed [adoption procedure](#adopt-an-existing-installation).

`stage` validates the outer checksum, runtime pins, complete file inventory, and
safe archive paths. It returns an artifact ID and retains the immutable bundle.
It changes no active selection and starts no browser. Keep the archive and its
matching outer manifest.

After reviewing the intended selection, activate the returned artifact ID:

```sh
"$MANAGER" activate "$INSTALL" ARTIFACT_ID
terminal-browser doctor --json
```

Activation changes launch selections, not loaded processes. It starts no browser,
does not resume control, and does not reload Pi or Herdr. Do not continue after an
installer refusal. A selected link, successful build, or empty diagnostic error
list is not proof of visible rendering or loaded-process activation.

To use an alternate CLI destination, pass an absolute path to `init`:

```sh
"$MANAGER" init "$INSTALL" --cli "$HOME/.local/bin/terminal-browser"
```

Use this instead of the earlier `init`, not to reconfigure an already initialized
root. The installation receipt is the owner of future selection changes.

## Optional skill, Pi, and Herdr

Choose optional destinations during fresh `init`. Every path must be absolute.
Do not supply an option merely because its host happens to be installed.

| Option | Selected integration |
| --- | --- |
| `--skill /absolute/skills/terminal-browser` | Link the selected release's `skills/default/terminal-browser`. This gives CLI-first instructions and does not register tools. |
| `--pi-settings /absolute/pi/settings.json` | Add the optional Pi adapter package to that settings file. Pi remains a separate host application. |
| `--herdr-registry /absolute/herdr/plugins.json --herdr-link /absolute/terminal-browser-herdr` | Select the prebuilt Herdr plugin and its persisted registry entry. Both options are required together. |

For CLI-first instructions in Pi without native tools:

```sh
"$MANAGER" init "$INSTALL" --skill "$HOME/.agents/skills/terminal-browser"
```

Use an empty/unoccupied skill selection. Do not replace an existing managed or
hand-edited skill with a blind copy. Other agents can load the same generated skill
through their own supported discovery path. Launch does not install skills, edit
terminal configuration, or run setup.

For the optional five Pi tools, include `--pi-settings` instead, or combine it
with the desired skill destination. The package contains only the adapter, not a
Pi host. Pi's package filters can disable its extension with `extensions: []`;
loading the CLI skill alone does not activate native tools. See the
[adapter guide](../pi-extension/README.md) for exact paths and host checks.

When Pi is selected, activation writes the new absolute versioned package source
at the existing package index and preserves object filters/unrelated settings.
Do not use a stable symlink as proof that Pi loaded a new module. Reload only an
idle session with a safe draft state and the required user approval.

When Herdr is selected, activation changes only the matching registry entry and
launch link. It retains the plugin order and enabled flag, uses the retained
`plugin_root`/`manifest_path`, and installs the prebuilt descriptor without the
checkout build step. Herdr may save no `build` property instead of `build: []`;
these are equivalent. A changed nonempty build plan still refuses. Refresh an
already running registration only after successful activation, using Herdr's
supported same-ID plugin link command. The installer does not call a running
Herdr API or reload it. A persisted selection is not a loaded-registration claim.

## Adopt an existing installation

Do not use fresh `init` to replace an existing profile, CLI, skill, or host
registration. Inspect the current installation and create an owner-only JSON
receipt for exactly the paths and namespace it uses. Do not infer these paths
from the current shell's XDG defaults.

```json
{
  "schemaVersion": 1,
  "namespace": "terminal-browser-1234abcd",
  "paths": {
    "dataHome": "/example/user/.local/share",
    "stateHome": "/example/user/.local/state",
    "cacheHome": "/example/user/.cache",
    "runtimeHome": "/run/user/UID",
    "appData": "/example/user/.config",
    "interopState": "/example/user/.local/state/terminal-browser-interop",
    "interopShare": "/example/user/.local/share/terminal-browser-interop"
  },
  "selection": {
    "cli": "/example/user/.local/bin/terminal-browser",
    "piSettings": null,
    "piSource": null,
    "herdr": null,
    "herdrRegistry": null,
    "herdrSource": null
  }
}
```

Replace the namespace and all example paths with inspected values. All path
fields are absolute, except an enabled `piSource`: it must match the exact existing
Pi `packages` source, including a relative source when present. Use `null` for
`piSource` only when adding a new package to selected Pi settings. For enabled
Herdr adoption, `herdrSource` pins the exact existing local 0.2.0 plugin root, or
is `null` only when the plugin is not registered. Keep disabled integrations null.
An optional `skill` path must be a reviewed selection, not an occupied directory
to remove. Preserve every unrelated installation namespace.

```sh
chmod 600 /absolute/installation-receipt.json
"$MANAGER" configure "$INSTALL" /absolute/installation-receipt.json
"$MANAGER" stage /absolute/runtime.tar.gz /absolute/manifest-linux-x64.json "$INSTALL"
"$MANAGER" activate "$INSTALL" ARTIFACT_ID
```

Use the runtime archive's original filename from its manifest. The generic name
above stands for that exact file. Profiles, database/WAL files, caches, and download
history stay in place. The installer does not copy live state. A locked or uncertain
profile is refused; no temporary or numbered profile is substituted.

## Update and rollback

The 0.1.0 retained manager can refuse valid artifacts because Electron treats
`.asar` files as virtual directories. To update from 0.1.0, use the reviewed
0.1.1 bootstrap installer for staging and activation, then keep the new retained
manager. Do not edit files inside a retained artifact.

After installation, use the retained manager, with no checkout. The new bootstrap
and retained managers read both legacy schema 1 artifacts and schema 2 artifacts.
Old artifact managers cannot read schema 2 artifacts or nullable-integration
receipts. If you roll the runtime back to an older artifact, keep using the newer
manager for later operations. Do not change the manager path back with the runtime.

```sh
MANAGER="$INSTALL/releases/ARTIFACT_ID/terminal-browser/scripts/install.sh"
"$MANAGER" stage /absolute/next-runtime.tar.gz /absolute/next-manifest.json "$INSTALL"
"$MANAGER" activate "$INSTALL" NEW_ARTIFACT_ID
"$MANAGER" status "$INSTALL"
"$MANAGER" rollback "$INSTALL"
```

Use the reviewed release's exact archive filename. Repeated stage/activation is
safe. Retained releases and scoped activation backups provide rollback. There is
no destructive release cleanup. Rollback validates selected paths and changes
only this installation's links and selected host entries. It preserves unrelated
later settings changes. Changed selections or Pi package order can cause a safe
refusal. Rollback does not change a currently loaded daemon or extension.

An interrupted activation/rollback retains a private transaction. Inspect `status`,
then explicitly run `"$MANAGER" recover "$INSTALL"`. Recovery refuses a live or
unknown manager-lock owner and changed integration selections. It reverses an
uncommitted operation or confirms a completed selection while preserving unrelated
later settings. Repeating recovery is safe. It starts/resumes no browser.
SIGKILL recovery tests do not establish power-loss durability.

## Verify and replace loaded processes safely

A daemon and Pi extension retain their startup artifact, protocol, and process
start identity. `doctor --json` reports candidates, next-launch selections, and
observed loaded identities separately. It does not scan page content, open/migrate
the database, prepare graphics, repair sockets, or run setup. Graphics remains
unknown without a visible terminal check. Internal Chromium pixels are not such
a check.

Pi receipt diagnostics use bounded reads of the retained receipt directory.
`pi.receipts.complete` separates complete inspection from unreadable records,
uncertain identity, or ambiguous reload order. Only boot/start-matched processes
with an unambiguous latest receipt are live. A selected path or partial scan
does not prove all-session convergence. A disabled optional host is not a missing
required component.

Doctor also reports bounded profile-lock identity/PID and separate socket state.
A PID-only lock does not identify its owner's boot/process start. A missing PID
or socket does not authorize deletion. Check process visibility, current profile
users, and unchanged lock identity before proposing a separate approved recovery.
Handled initialization failures release the held profile claim. Abrupt process
death can leave a lock. Startup refuses it and does not delete it automatically.

Replacing a shared daemon loses open tabs and transient browser state. Obtain
its complete metadata-only inventory, then get approval for that exact set:

```sh
terminal-browser daemon-status > /absolute/approved-daemon-status.json
terminal-browser shutdown --expect /absolute/approved-daemon-status.json
```

The daemon rechecks process/build/session identity and refuses a new-session race.
Legacy, unresponsive, or uncertain processes need separate inspection, not a
guessed PID kill or socket deletion. No command is replayed and no browser
reopens automatically. After an approved stop, launch deliberately and verify
the new loaded identity plus actual visible use. Report integration, activation,
and practical verification separately.
