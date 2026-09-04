# M00 containment timeline

This timeline records only bounded, reproducible project events. It does not reproduce session content, credentials, raw diagnostics, or private paths. Each entry names the source class used; a date-only entry does not claim an exact time.

| Date/time | Event | Source class | Boundary/result |
| --- | --- | --- | --- |
| 2026-09-02 | North-star charter established | Charter document metadata | The byte-preserved north-star records September 2, 2026 as its establishment date. It remains unchanged and does not authorize release or deployment. |
| 2026-09-03T05:24:49Z | Original M00 containment began | User-provided containment report | Clean execution clone selected; original worktree and live installation excluded from edits. P1 exposure classification recorded; no P2 material or P3 surface confirmed. |
| 2026-09-03T07:16:05Z | M00 baseline commit created | Git commit metadata | Baseline commit `1887c77b39c42fb0b5d35b38baac94aff13465e9` was created on `work/chrono-v3-m00-baseline`; no runtime deployment or settings change. |
| 2026-09-03T07:17:51Z | PR #30 opened | GitHub pull-request metadata | PR #30 was opened as draft against `rebuild/chrono-memory-v3`; no merge or release occurred. |
| 2026-09-03 | M00-A1 public-review authorization | Recorded governance decision | Repository identity and public access were verified after explicit authorization. No history rewrite, branch rewrite, release, package publication, deployment, or runtime change occurred. |
| 2026-09-03 | R1 preflight and correction | Git state and review records | PR #30 was retargeted to `rebuild/chrono-memory-v3`; merge-base equals the frozen baseline parent and the comparison excludes `packages/pi-project-glance/`. R1 corrections were made in the execution clone only. |
| 2026-09-03 | Directing-assistant project-lead review 1 | Review record | Review 1 requested changes. Local secondary reviews performed during R1 were advisory and did not grant acceptance. |
| 2026-09-03 | R1 push and CI evidence | GitHub Actions metadata and review records | R1 correction commits were pushed normally and the recorded push and pull-request runs succeeded. This was not M00 acceptance and did not authorize M01. |
| 2026-09-03 | Directing-assistant project-lead review 2 | Review record and current instruction | Review 2 requested R2-F001 through R2-F010. The current correction tree addresses those findings and is ready for directing-assistant project-lead re-review. |
| 2026-09-03 | R2 local validation and publication preparation | Local command records | Scanner, baseline, ChronoCompact, and root gates passed against synthetic or sanitized inputs only. No runtime/live/original-worktree change occurred. |
| 2026-09-03 | R2 push and CI evidence | GitHub Actions metadata | Commits `9057c1a`, `c074fe9`, and `fd596f6` were pushed normally. Runs `33816038570`/`33816041445` passed for `c074fe9`; runs `33817442403`/`33817446062` passed for validation target `fd596f6`. This is not M00 acceptance and does not authorize M01. |

The timeline is not an M00 acceptance record and does not authorize M01. M00 remains unaccepted until the directing assistant records an explicit decision after reviewing the corrected pushed head.
