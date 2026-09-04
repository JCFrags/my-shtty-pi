# Pi Herdr Orchestrator and Agent Board

- Purpose: Run direct Herdr subagents and keep the temporary Agent Board opener commands.
- Status: M05 production pilot
- Pi entrypoint: `dist/extensions/pi-herdr-orchestrator-v2.js`
- Root tool: `orchestrate`
- Managed-child tool: `subagent_channel`
- Board commands: `/agent-board` and `/pi-herd`
- Load form: compiled-loaded
- Build/check commands: `npm run typecheck` and `npm run build`

The production entrypoint does not load the legacy broker orchestration extension. The legacy source and Agent Board plugin code remain in this package as rollback material, but they do not register, activate, intercept, or reconcile orchestration tools in the pilot.
