# Stage 1 environment

- Capture date (local): `2026-09-01`
- OS: Fedora Linux 44 (Workstation Edition)
- Kernel: `7.1.10-200.fc44.x86_64`
- Architecture: `x86_64`
- Working directory: `$HOME`
- Git repository root for working directory: none
- Pi command: `$HOME/.local/bin/pi`
- Resolved Pi executable: `$HOME/.local/bin/pi`
- Pi version: `0.84.2`
- Node version: `v24.18.0`
- Git version: `2.55.0`
- Installed Pi source: `$HOME/.local/lib/pi-agent-orchestration/pi-coding-agent-0.84.2`
- Current relevant Pi PID during discovery: `5111`
- Current-process resource flags: none found (`-e`, `--extension`, package URL, and local resource flags were absent)

## Sanitized `pi list`

```text
User packages:
  packages/pi-progressive-tools
    $HOME/.pi/agent/packages/pi-progressive-tools
  packages/pi-agent-context
    $HOME/.pi/agent/packages/pi-agent-context
  $HOME/.pi/agent/deployments/pi-grounded-tools/0.1.0/afa7977ae759947d3fbc905e0b2beef3d4f0b51c663365614b7ab368aef62c66
    $HOME/.pi/agent/deployments/pi-grounded-tools/0.1.0/afa7977ae759947d3fbc905e0b2beef3d4f0b51c663365614b7ab368aef62c66
  $HOME/.agents/projects/pi-chrono-compaction/implementation/chrono-v2-infinite-memory-005-correction-020/active-project
    $HOME/.agents/projects/pi-chrono-compaction/implementation/chrono-v2-infinite-memory-005-correction-020/active-project
  $HOME/.pi/agent/deployments/pi-herdr-orchestrator/0.1.0/cc04bfe9a978e12f5b3f0e54e3cebd30d4555f99f5e9fda25cbb1f18ffbaf764
    $HOME/.pi/agent/deployments/pi-herdr-orchestrator/0.1.0/cc04bfe9a978e12f5b3f0e54e3cebd30d4555f99f5e9fda25cbb1f18ffbaf764
  $HOME/.pi/agent/deployments/pi-native-ssh/1.0.0/edadf023051a5b349e6884fc911fa8b02105c1cd8dde58d15f7c17c20229bf2a
    $HOME/.pi/agent/deployments/pi-native-ssh/1.0.0/edadf023051a5b349e6884fc911fa8b02105c1cd8dde58d15f7c17c20229bf2a
  ../../Projects/my-shtty-pi/packages/herdr-status
    $HOME/Projects/my-shtty-pi/packages/herdr-status
  ../../Projects/my-shtty-pi/packages/files-ui
    $HOME/Projects/my-shtty-pi/packages/files-ui
  $HOME/.pi/agent/deployments/pi-signal-board/0.1.0/e599df249d8c5514fc24e2ec3b614b6315ac46cb6f5585594f34d17dd5b2d32f
    $HOME/.pi/agent/deployments/pi-signal-board/0.1.0/e599df249d8c5514fc24e2ec3b614b6315ac46cb6f5585594f34d17dd5b2d32f
  ../../PI_PROJECT_STAGING/projects/pi-pixel-cua/wayland-redesign/product
    $HOME/PI_PROJECT_STAGING/projects/pi-pixel-cua/wayland-redesign/product
```

## Resolution authority

The audit used the installed Pi 0.84.2 implementation, especially `dist/core/resource-loader.js`, `dist/core/package-manager.js`, and `dist/core/extensions/loader.js`. Resolution was performed offline without loading an extension or starting a second side-effecting Pi session. TypeScript entrypoints are loaded through Pi's Jiti loader. Project package settings precede global package settings; no project settings file existed for `$HOME`.
