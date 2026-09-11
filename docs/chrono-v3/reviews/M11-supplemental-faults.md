# M11 supplemental fault evidence

Status: bounded supplemental qualification completed against implementation commit `0dd1fe745cee6aeca5e2c1c292fed85a1dcd4920`, based exactly on `fac5d3566339b8ac51379c1703bcb1347e768d8b`. This report covers only three previously open M11 charter rows. It is not an M11 pass or another scale campaign.

## Boundary and admission

The harness used real disposable synthetic JSONL files and task-owned catalog, capsule, and search stores. Every contained call omitted `schedulerDirectory` and requested one slot. The calls therefore used the existing production host-wide admission and its default one-slot policy. The harness did not create a second capacity pool or nest an isolated scheduler under another lease.

Only harness-created contained children received `SIGKILL`. No shared owner, daemon, live agent, provider, active campaign, service, or machine state was changed. The root and result stayed owner-only outside the repository. The successful root remains retained; it contains only synthetic task data.

Limits were one admitted worker, three repeated deaths, 128 MiB V8 heap, 256 MiB worker memory, 256 KiB response, 30-second per-worker deadline, 128 MiB total task disk, and two-minute task wall time. The custom killed worker had an 8 MiB source-read cap. Public catalog workers retained their existing 16 MiB worker allowance and 8 MiB response-accounted source-read ceiling. Actual task disk was 374,301 bytes and actual wall time was 25,931 ms.

## Exercised facts

### Repeated worker death and released admission

Three separately identified contained workers killed themselves with `SIGKILL`. Each public bounded-worker result was `worker-crashed`. After each death, a new task-owned healthy worker acquired the same host-wide one-slot admission and returned successfully. Its measured queue wait was 585 ms, 600 ms, and 595 ms. Later catalog, capsule, and search workers also acquired the same admission. This proves released task admission without making a global zero-residue claim while unrelated work can be active.

### Kill during an actual transaction

A contained task worker reused the proven catalog fault seam. It wrapped the real `CatalogSqlite` statement whose SQL starts with `INSERT INTO events`, performed the native statement run inside `executeCatalogRequest`, and killed itself immediately after that run but before the catalog transaction completed.

The committed record count remained 1 after death. A normal public catalog worker then ingested exactly one pending record, and the next retry ingested zero. The complete synthetic source SHA-256 remained identical before kill, after kill, and after retry:

`a2ec558cad0578e158215282f137700322521c40adcbedfb544510a057ef0dbb`

This is process-kill transaction rollback evidence. It is not device power-loss or system-reboot evidence.

### Designated abandoned fork and sibling isolation

One source contained a common root, a sibling leaf designated abandoned by the harness, and a selected active leaf. Both views remained independently readable from one catalog and one capsule store:

- selected catalog view: `fork-root`, `fork-active`;
- abandoned catalog view: `fork-root`, `fork-abandoned`;
- selected capsule event sequences: 1, 3;
- abandoned capsule event sequences: 1, 2.

The selected active search returned one active-marker hit and zero abandoned-marker hits. The complete fork source SHA-256 was unchanged before and after catalog, capsule, and search work:

`be54365e00596783c97e9b00966ae2e5ee439702e18193b74625ad6b24c48d02`

The catalog has no branch-lifecycle field. “Abandoned” is therefore the harness designation for the unselected sibling, not a stored lifecycle-state claim.

## Checks and hashes

One focused compile/contract command passed 2/2 tests. One supplemental execution completed all three scenarios. No broad suite or full-scale campaign ran.

- Safe aggregate result SHA-256: `069e6fcebcfbf1685c6ce645f35c6156a8905f5d60a1a9dce73e756136e034e4`.
- Harness SHA-256: `8f2a95de800e78f7315577b39d1290dfc3cbd6c81b4b54b4112328e87d0758c9`.
- Contract test SHA-256: `f25f365576ebe4c8d6944a338b52782f73dba48613a1d74c43cc9f82ed3cc98d`.
- Generated fault worker SHA-256: `b2f36761aa3cacf4abb6af9843ae70be7b43468366d950880f80c232752f52fb`.
- Reused `better-sqlite3@12.9.0` native binding SHA-256: `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`.

## Limits and remaining gaps

No Pi process participated, so main Pi RSS is unavailable. Script RSS is not reported as Pi RSS. Segment-only read bytes were not measured or inferred. No provider or continuation-quality check ran. No process restart or system reboot ran, and process death is not a reboot. The supplemental run does not repeat or replace the M11 concurrency and billion-token scale matrix. Parent integration, applicable continuous integration, and later qualification invocation remain separately controlled.
