# Provenance

Pi Native SSH 1.0.0 evolves the locally accepted `pi-native-remote-readonly` 0.3.0 implementation.

The accepted base supplied the strict framed helper protocol, native read/list/find/grep result handling, OpenSSH host-key policy, bounded transport, cancellation, controller state, and private audit design. This package adds native command, write, edit, upload, download, and rollback behavior.

The original `pi-herdr-ssh` 0.1.0 proposal was used as design reference only. Its shipped source was not copied into this package. The proposal is MIT-licensed. Pi's installed 0.84.1 documentation and official SSH extension example defined the native operation interfaces.

Private acceptance evidence, SSH configuration, host details, logs, sessions, downloaded archives, and staging provenance records are not included.
