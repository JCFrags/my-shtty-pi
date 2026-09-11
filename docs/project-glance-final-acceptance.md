# Final Project Glance acceptance

## User result

The user accepted the final candidate on September 11, 2026. Undismissed updates, their text and counts, CURRENT, and the History count survived pane close/reopen and a Pi `/reload`. Individual cards and the History section expanded and collapsed correctly. The user explicitly accepted collapsed cards and collapsed History on reopening as the desired quiet startup, not lost data.

The unanswered Q-5 test produced one dismissal notice. The Q-6 sample answer was received without an automatic assistant response. The final question disappeared after delivery, leaving no QUESTIONS box. Questions are not a permanent scrollable question archive. History contains dismissed update cards, not old question cards.

A computer restart was not repeated for this candidate. Earlier restart observations are historical evidence, not a new restart test. No current user question clock was accelerated.

## Verification

- Independent local review completed. Corrections addressed branch checkout recovery, stale initial-page races, and work accounting during question editing.
- A real-pane check exposed a manual page gate. The correction passed a 100-card test and actual forward/backward scrolling across 25-card boundaries, including evicted-page recovery.
- Glance: 151 tests, 150 passed, zero failed, one existing opt-in live-doctor skip. The separately selected candidate's direct doctor subsequently passed.
- Root unit tests: 18 passed. Affected Dialog/Workplan checks: 23 passed.
- Full clean locked root verification passed for all 16 supported products. The earlier Chrono readiness failure was resolved by the separately protected PR66 correction, not waived or retried unchanged.
- Historical verification passed: 261 hashes and 15 manifests. Package dry-run passed with 42 files.
- Isolated clean build, link, real-pane smoke, unlink, relink, and rollback registration cleanup passed without production changes.
- Selected candidate loader, selected production loader, and direct doctor passed. Actual parent relay and pane used the new archive protocol and retained candidate launcher.

## Storage and expiry

The permanent owner-only SQLite archive has no age or size retention cap. See [archive operations](../packages/pi-project-glance/docs/archive.md) for location, selected-session migration, backup, restore, error handling, and compatible rollback.

The initial explicitly selected parent-session import recovered 164 eligible updates and 14 legacy dismissals, with zero reported gaps or conflicts. This result covers that selected source, not every private session. The two other explicitly selected owning sessions also completed import, covering one and two branches respectively. Both reported zero new items, zero new legacy dismissals, zero gaps, and zero conflicts because their eligible updates were already captured. No unrelated sessions were scanned.

Automatic unanswered expiry requires both 30 minutes of eligible observed active-tool time and three meaningful normally settled runs by the same agent on the same branch. A meaningful run has a successful write/edit or Todo/Workplan mutation, or at least three eligible successful read/search/navigation calls. Overlapping intervals count once, with five minutes maximum per tool and 64 unique spans per run. Idle time, unknown activity, polling, failures, other agents, and work completed while the question is being edited do not earn credit. Submitted answers and blocking/authorization questions do not expire through this heuristic. Dismissal and expiry are not resolution, approval, or a default selection.

## Release status

[Functional PR70](https://github.com/JCFrags/my-shtty-pi/pull/70) merged as `4157a4feadec1a82c7742f9ac94918579e926014`, tree `8d3085700f550e233154b6430e76eb85ee267b45`. [Required PR CI](https://github.com/JCFrags/my-shtty-pi/actions/runs/34631456752) and [resulting-main CI](https://github.com/JCFrags/my-shtty-pi/actions/runs/34632673577) passed. The earlier start-record main run failed a footer fixture's object-identity assertion; it was not retried unchanged or represented as passing.

A retained release was built from that exact merged source with locked dependencies. All 100 recorded source files matched Git. Its 37 Glance build files and the affected Dialog/core files matched the user-accepted candidate. Build SHA-256 identities:

- Glance extension: `b49112de1c2660007b323413e95d3a479eb165e95f6050c4e35bcede83ae5adf`.
- Glance pane entrypoint: `41e0b829df9a461591bc20412976e00823a8a05f391df42762e8e9c58f77494f`.
- Private source/build manifest: `8c55e8bb13d57d47bc89ea42997cede296d107cbadec3b984217ebdfa73d5d04`.

Both sharing owners acknowledged the narrow selection window. Only the existing Glance/Dialog package slots, their aliases, and the same-ID Glance plugin registration changed. Selected-loader surface parity, the scoped rollback check, and an online archive backup integrity check passed. The selected doctor passed with the actual retained provider root. An initial invocation used the wrong provider root and correctly refused its identity check; no product code was changed for that correction.

All three in-scope parent sessions adopted the release through one coordinated supported reload each. Each retained its process/session identity. Each actual `/project-glance` command launched the exact-main pane launcher. The two verification-only panes were closed to restore their owners' prior layout; the integration user's replacement pane remains open. Authenticated relays for all three reported the permanent archive ready. Existing unanswered questions, accepted answers, and archive data were preserved. Browser startup receipts independently matched its unchanged selected artifact. Chrono policy, source selection, stores, and independent development remain outside this release's acceptance.

The browser lead's one final read-only verification passed: 100 source files, 37 build files, selected roots, rollback availability, all three owner reload/launcher receipts, archive-ready relays, and the current pane. Interactive acceptance was not repeated. The generic doctor still labels existing-runtime activation unverified by design; the actual reload and command receipts establish adoption. The browser lead released Glance coordination ownership with no remaining window or work.

The final documentation checkpoint is `project-glance-final-2026-09-11`. Publish this new immutable tag only after the protected evidence merge and its resulting-main CI pass. Later documentation-only main commits do not require rebuilding or reloading unchanged runtime inputs. Public evidence excludes private paths, session identifiers, card text, and diagnostic payloads. Retained release roots, backups, and failed-check evidence remain private rollback assets.
