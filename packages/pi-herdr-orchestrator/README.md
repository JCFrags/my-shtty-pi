# Pi Herdr Orchestrator and Agent Board

- Purpose: Run direct Herdr subagents and keep the Agent Board opener commands.
- Status: M07 legacy implementation pruned
- Pi entrypoint: `dist/extensions/pi-herdr-orchestrator-v2.js`
- Root tool: `orchestrate`
- Managed-child tool: `subagent_channel`
- Board commands: `/agent-board` and `/pi-herd`
- Load form: compiled-loaded
- Build/check commands: `npm run typecheck` and `npm run build`

The package contains only the direct-Herdr entrypoint, its runtime closure, and the minimum Agent Board opener. Legacy broker, provider, model-intelligence, scheduler, and state implementations remain available through Git history and preserved branches. The runtime has no package dependencies and makes no broker requests.
