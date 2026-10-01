# Orchestration maintenance

Read [README.md](README.md) for portable setup, [docs/architecture.md](docs/architecture.md) for ownership and source routing, and [docs/operations.md](docs/operations.md) for waits, activation, and recovery. Root [verification](../../README.md#verification), [package registry](../../package.json), and [CI workflow](../../.github/workflows/verify.yml) govern repository delivery.

- Keep the direct-Herdr root `orchestrate` and exact managed-child `subagent_channel` surfaces. Do not restore the broker, `/agent-settings`, scheduler, or presentation panes.
- Preserve registry/channel/result formats, explicit result collection, assignment checks, native-session child binding, and direct legacy migrations. State is not disposable build output.
- Build from a full checkout with its own sibling `pi-tool-controls/presentation` dependency. Keep Tool Controls inactive. Do not reuse or modify another installation's dependency tree.
- Local Pi registration does not install dependencies, copy source, or build the compiled entrypoint. Herdr children use their configured Pi command and defaults, not the parent's current model or one-off extension flags. Agent State must report native session identity in TUI mode.
- Keep portable docs free of machine-specific release roots. Use generic variables for selected paths. Do not confuse static source inspection, factory inventory, or fake-Herdr tests with real TUI lifecycle acceptance.
- Install the root lock before the package lock. Run package typecheck, build, and existing tests for scoped implementation. Stage intended inputs before root verification. Use focused checks rather than add broad test campaigns.
- Activation and production cleanup are separate from code edits. Preserve unrelated registrations, active work, editor drafts, historical state, and compatible recovery roots. Follow scoped activation and exact ownership checks.
