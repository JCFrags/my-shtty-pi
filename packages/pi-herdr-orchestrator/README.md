# Pi Herdr Orchestrator and Agent Board

- Purpose: Run direct Herdr subagents and keep the Agent Board opener commands.
- Status: M06 local hard cutover
- Pi entrypoint: `dist/extensions/pi-herdr-orchestrator-v2.js`
- Root tool: `orchestrate`
- Managed-child tool: `subagent_channel`
- Board commands: `/agent-board` and `/pi-herd`
- Load form: compiled-loaded
- Build/check commands: `npm run typecheck` and `npm run build`

The production build emits only the direct-Herdr entrypoint and its runtime closure. Legacy broker source remains preserved for history and rollback, but it is excluded from `dist` and cannot be discovered through the package manifest. New root and child orchestration make no broker requests.
