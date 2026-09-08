# Pi Herdr Orchestrator

Direct Herdr orchestration for Pi, with authenticated broker configuration.

- Pi entry point: `dist/extensions/pi-herdr-orchestrator.js` (compiled-loaded).
- Root tool: `orchestrate`. Managed-child tool: `subagent_channel`.
- `/agent-settings` configures broker model policy, endpoint limits, scoring, and optional foundation refresh. It requires Pi TUI mode and an available authenticated broker with a writable configuration file.
- Direct Herdr spawning retains its existing policy. It does **not** consume broker model settings. Saving settings does not change direct `orchestrate` spawn routing.
- The Herdr manifest keeps plugin ID `pi.herdr.orchestrator` and the broker startup hook. It declares no managed panes.

## Build and test

Requires Linux, Node.js >=22.19.0, npm, and Pi (for the real TUI component test).

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run typecheck
npm run build
npm test
```

Pi supplies its canonical peer packages at extension load time. No alternate TUI package is bundled. `dist/` is generated and is not a deployed-byte contract. Build copies the checked-in schemas, profiles, and workflows into `dist/`.

Tests cover exact root/child registration, real Pi settings rendering and explicit save/cancel behavior, M10 channel ordering and recovery, strict historical event replay, and packaged broker startup/authentication/status/doctor/settings persistence against a disposable fake Herdr environment seeded with a historical event. They do not prove live Herdr acceptance or deploy anything.

The isolated broker test is `node --test checks/disposable-broker.test.mjs`. It creates its own socket, executable, HOME, XDG directories, and configuration. It invokes `bin/pi-herdr-orchestrator broker startup`, `broker status`, `doctor --json`, and `broker stop` only under that temporary environment. Do not copy the stop invocation into a live environment.

## Source provenance

- Broker, CLI, authentication, scheduler, state, results, Herdr adapter, model intelligence, schemas, profiles, and workflows were recovered from this repository's exact source import `a65b18a4021e22ef05aaa5bce20a28ea2ff8149b`. Later undeployed broker changes were not imported. UI-only routes, ephemeral UI projections, and obsolete Pi adapters were removed. Profiles defer model, provider, and thinking selection to runtime policy.
- All six `src/orchestrator/*.ts` modules and `checks/m10-reliability.mjs` come unchanged from production commit `3c87f445f788d460554999a5b5d01a627d7c0bcc`.
- The settings component and retained shared policy code come from feature commit `864712b8ee0fc004d271535566d7a5124145828f`; the component now imports canonical Pi TUI. The new command uses short-lived authenticated broker requests instead of registering a second agent lifecycle.
- `bin/pi-herdr-orchestrator` was copied unchanged from deployment content ID `cc04bfe9a978e12f5b3f0e54e3cebd30d4555f99f5e9fda25cbb1f18ffbaf764`. It loads the rebuilt local CLI; it does not reference that deployment path.
- Existing MIT attribution is preserved in `LICENSE`.

`src/state/historical-actor.ts` retains one exact retired actor identifier for persisted event replay only. This is a deliberate compatibility exception, not a live principal or route. EventStore accepts it only when reading existing events; new appends and live hello validation reject it. Event hashes, payload validation, and snapshot authentication are unchanged. Synthetic fixtures verify that historical logs remain writable and that packaged broker startup remains healthy.

## Activation boundary

Herdr 0.8.2 source at `9eb521456ac0d19d3ab3d9d7cea3cca10baa8a4c` updates the registry entry when `plugin link` uses an existing ID. It does not restart the broker or close existing panes. Startup hooks run at server start or handoff import, not at link time. Recheck this behavior when Herdr changes.

Relinking this manifest updates future plugin discovery but does not replace an already running broker. `broker startup` reuses a healthy existing broker. A live broker replacement requires a separate, explicit maintenance decision. Keep the previous package root and plugin registration available for rollback; no activation or rollback is performed by the build or test commands.
