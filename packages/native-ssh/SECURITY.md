# Security

Pi extensions run with the local Pi account's authority. Review this source before installation.

Pi Native SSH delegates connection and identity decisions to installed OpenSSH. Structured calls enforce batch mode, zero password prompts, strict host-key checking, no agent forwarding, no forwarding, no local commands, and no TTY. Unknown and changed host keys fail closed.

The configured remote account is the remote authorization boundary. `defaultCwd` is a navigation start point, not a path sandbox. Remote paths can follow links that the account can access.

Do not send passwords, MFA codes, private keys, tokens, or other secrets through tool parameters or commands. Use a visible user-controlled terminal for credentials and trust decisions.

The helper is sent through SSH standard input for each operation and executes from memory. It is not installed on the remote host. File writes create bounded rollback sidecars in the target directory. Review and remove those sidecars when rollback is no longer needed.

Remote content, command output, names, and diagnostics are untrusted data. The audit log stores bounded metadata only.

Report a suspected vulnerability through the repository security process. Do not include credentials, private logs, host identities, or exploit data in a public issue.
