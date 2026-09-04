# Pi Herdr Orchestrator and Agent Board

- Purpose: Run direct Herdr subagents and keep the Agent Board opener commands.
- Status: canonical production implementation
- Pi entrypoint: `dist/extensions/pi-herdr-orchestrator.js`
- Root tool: `orchestrate`
- Managed-child tool: `subagent_channel`
- Board commands: `/agent-board` and `/pi-herd`
- Load form: compiled-loaded
- Build/check commands: `npm run typecheck` and `npm run build`

The package contains the direct-Herdr entrypoint, its runtime closure, and the minimum Agent Board opener. `list` returns bounded current-agent snapshots, `inspect` adds at most eight recent run summaries, and `collect` remains the non-destructive path for any historical result. Legacy broker, provider, model-intelligence, scheduler, and state implementations remain available through Git history. The runtime has no package dependencies and makes no broker requests.

The canonical rename intentionally retains the existing registry schema, durable event/result formats, topology values, environment keys, and `pi-herdr-orchestrator-v2` state directory. Existing domains and live agents therefore remain recoverable after deployment.
