# Pi Pixel CUA Portal

This source-loaded extension provides pixel capture and input for one user-selected
native window in GNOME Wayland. It uses the desktop portal, PipeWire, and EIS, the
portal's input connection. It does not enumerate windows, use accessibility data,
read the clipboard, or fall back to X11 input.

## Runtime prerequisites

- Node.js `>=22.19.0` and an installed Pi host.
- Python `>=3.10` at `/usr/bin/python3`. The helper uses this exact interpreter,
  not an activated virtual environment.
- Python modules `dbus`, `gi`, and `PIL` (Pillow).
- GObject introspection namespaces `GLib 2.0`, `Gst 1.0`, `GstApp 1.0`, and
  `GstVideo 1.0`, plus GStreamer's `pipewiresrc` element.
- `libei.so.1` with the sender API used by the helper. The source uses libei 1.6
  event and capability definitions.
- A live GNOME Wayland desktop session with PipeWire and the GNOME desktop portal.
  The public portal and GNOME backend must both expose RemoteDesktop version 2 or
  newer and ScreenCast version 5 or newer. The helper requires matching capability
  masks of 7 for devices, sources, and cursor modes.

On Fedora, the relevant packages are `python3-dbus`, `python3-gobject`,
`python3-pillow`, `libei`, `gstreamer1-plugins-base`, `pipewire-gstreamer`,
`xdg-desktop-portal`, and `xdg-desktop-portal-gnome`. Install missing system packages
through the normal approved system maintenance procedure. npm does not supply them.
Other systems must provide the same Python modules, libraries, and portal behavior.

The portal must return one window stream, pointer and keyboard access, embedded
cursor capture, valid geometry, and an EIS mapping ID. Unsupported capabilities or
an incomplete grant fail without a fallback. A headless shell or an SSH session
without the user's desktop bus cannot provide this workflow.

## Install

Use the full retained checkout described in [installation](../../docs/installation.md).
Set `REPO` to its absolute path, then register the package once:

```sh
pi install "$REPO/packages/pi-pixel-cua"
```

No compiled build or package-local npm installation is required. Pi supplies the
Pi AI, coding-agent, and TypeBox imports. Local registration does not copy source or
prepare system dependencies. Keep `src/` and the sibling `helper/` directory intact.
The helper resolves `helper/server.py` from the extension's location and imports
`portal_backend.py` and `ei_sender.py` beside that file.

The extension needs no token or configuration file. It starts its Python helper on
first use, not during factory loading. A loader check therefore does not prove that
capture or input works.

## Consent and actual use

1. Call `cua_portal_start`. The user selects one window and grants pointer and
   keyboard access through the native portal dialog. The grant is not persistent.
2. Call `cua_portal_observe` before an action. It returns pixels and the latest
   guarded state identifier, not a document or accessibility tree.
3. Use `cua_portal_act` against that state. Clicks and keyboard actions require
   explicit Pi confirmation. Pointer moves use the current portal grant.
4. Call `cua_portal_stop` when finished. It releases input, closes the selected
   stream and portal session, and discards helper pixels.

`/pixel-cua-status` reports local helper state. `/pixel-cua-stop` and
`Ctrl+Shift+F12` provide emergency stop. Session shutdown also closes the helper.
Starting another grant requires a new visible selection. Verify actual capture and
an explicitly approved harmless action before claiming activation.

From the repository root, stage intended changes before current verification:

```sh
npm run verify -- --product pi-pixel-cua
```

`DEPLOYED.sha256` and `verify:history` describe the imported baseline, not current
runtime health. Preserve existing grants, jobs, sessions, and drafts during any
planned reload. Do not stop another session to test an installation.
