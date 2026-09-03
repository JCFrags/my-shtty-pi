# M00 containment timeline

This timeline records only bounded, reproducible project events. It does not reproduce session content, credentials, raw diagnostics, or private paths.

| Date | Event | Boundary/result |
| --- | --- | --- |
| 2026-09-02 | Original M00 containment | Clean execution clone selected; original worktree and live installation excluded from edits. P1 exposure classification recorded; no P2 material or P3 surface confirmed. |
| 2026-09-02 | M00 baseline and test recovery | `BASELINE_SHA` selected as `eb9742c318a76eeaf753e87a620fae83ca9048d1`; 55 historical test files retained and 54 runnable. No runtime deployment or settings change. |
| 2026-09-02 | M00 publication | Baseline commit `1887c77b39c42fb0b5d35b38baac94aff13465e9` pushed on `work/chrono-v3-m00-baseline`; PR #30 opened as draft. |
| 2026-09-03 | M00-A1 public review authorization | Repository identity and public access were verified after explicit authorization. No history rewrite, branch rewrite, release, package publication, deployment, or runtime change occurred. |
| 2026-09-03 | R1 preflight | PR #30 retargeted to `rebuild/chrono-memory-v3`; merge-base equals the frozen baseline parent and the comparison excludes `packages/pi-project-glance/`. |
| 2026-09-03 | R1 scanner/baseline correction | Fail-closed scanner, frozen baseline verifier, root allowlists, correction tests, and all-ref CI workflow edits were made in the execution clone only. |
| 2026-09-03 | R1 local gate checkpoint | Targeted syntax, correction tests, all-ref privacy scan, and static root verification passed. Full validation, push, CI confirmation, and independent project-lead review were pending at this checkpoint. |
| 2026-09-03 | R1 final validation and independent review | Commit `8e02568fb1a15a9db6c30e8c494531dd13a6094d` was pushed normally; both push and pull-request CI runs passed, the evidence count and synthetic timing checks were corrected, and independent read-only review found no blocking defect. Explicit M00 acceptance remains pending; M01 remains blocked. |

The timeline is not an M00 acceptance record and does not authorize M01.
