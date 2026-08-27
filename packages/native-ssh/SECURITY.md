# Security

Pi extensions run with the local Pi account's authority. Review this source before installation.

Pi Native SSH delegates connection and identity decisions to installed OpenSSH. Structured calls enforce batch mode, zero password prompts, strict host-key checking, no agent forwarding, no forwarding, no local commands, and no TTY. Unknown and changed host keys fail closed.

The configured remote account is the remote authorization boundary. `defaultCwd` is a navigation start point, not a path sandbox. Remote paths can follow links that the account can access.

Do not send passwords, MFA codes, private keys, tokens, or other secrets through tool parameters or commands. Use a visible user-controlled terminal for credentials and trust decisions.

The one-shot helper is sent through SSH standard input for each operation and executes from memory. The persistent session helper is sent once for each SSH session and also executes from memory. Neither helper is installed on the remote host. Persistent file-resource reads and commits are bounded to 2 MiB. Exact text and file search require remote `rg` and `fd`; their structured output and hit counts are bounded. File writes create rollback sidecars in the target directory. Review and remove those sidecars when rollback is no longer needed.

A persistent session requires an exact configured target. The first session for each target in one Pi runtime requires a visible confirmation. Headless use fails closed until an approved RPC confirmation path exists. The session does not accept an arbitrary destination, use the active route implicitly, or fall back to a local shell. It uses one non-PTY OpenSSH child and one remote Bash process. The remote Bash keeps its working directory, variables, and functions until close. Do not depend on stale state when a one-shot command is sufficient.

Remote content, command output, names, and diagnostics are untrusted data. Malformed frames, sequence mismatches, excess output, unexpected diagnostics, and unclean disconnects close only the affected session. Cancellation sends an interrupt to the remote shell process group. If the command does not settle within the grace period, the provider closes the SSH session. A remote file-resource abort also taints and closes the session because the synchronous remote helper cannot safely reuse a late resource frame.

Persistent commits compare canonical path identity, existence, and the raw SHA-256 digest immediately before replacement. They use a same-directory temporary file and atomic rename. This replacement does not preserve a prior hard-link set. Rollback restores the prior bytes and mode through the shared sidecar names, but it does not restore hard-link topology. Grounded file operations must report this limit rather than claim topology rollback.

The audit log stores bounded metadata only. Persistent sessions also keep exact stdout and stderr chunks in a separate private local mode-`0600` JSONL log. The session provider does not copy the local Pi environment into the remote Bash process.

Report a suspected vulnerability through the repository security process. Do not include credentials, private logs, host identities, or exploit data in a public issue.
