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

The initial explicitly selected parent-session import recovered 164 eligible updates and 14 legacy dismissals, with zero reported gaps or conflicts. This result covers that selected source, not every private session. Other in-scope sessions require their own migration and adoption receipts.

Automatic unanswered expiry requires both 30 minutes of eligible observed active-tool time and three meaningful normally settled runs by the same agent on the same branch. A meaningful run has a successful write/edit or Todo/Workplan mutation, or at least three eligible successful read/search/navigation calls. Overlapping intervals count once, with five minutes maximum per tool and 64 unique spans per run. Idle time, unknown activity, polling, failures, other agents, and work completed while the question is being edited do not earn credit. Submitted answers and blocking/authorization questions do not expire through this heuristic. Dismissal and expiry are not resolution, approval, or a default selection.

## Release status

Hands-on acceptance is complete. Protected functional integration, resulting-main CI, exact-main deployment, all in-scope runtime adoption, and the immutable final release checkpoint remain pending. Candidate selection and one loaded parent do not establish installation-wide completion. Final release evidence will record those outcomes before project closure.
