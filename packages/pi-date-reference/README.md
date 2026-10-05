# Pi date reference

Adds one `local_date_reference` system-prompt section with the Pi host's local date and IANA time zone. The reference stays fixed for the context. It is not a live clock, an SSH-target observation, or the user's physical location.

```text
Local date reference: YYYY-MM-DD
Local time zone: Area/City
This reference is fixed for this context. Query the clock when the actual current date or time matters.
This describes the Pi host, not an SSH target or the user's physical location.
```

## Install and use

Use Node.js 24.18.0 or later and Pi 0.99.1. The tested host range is `>=0.99.1 <0.100.0`. Pi supplies the host modules. This package needs no dependency installation or build.

```sh
pi install "$PWD/packages/pi-date-reference"
```

Follow the repository's [scoped activation procedure](../../docs/activation.md). Preserve other registrations. Do not enable Pi Agent Context. Reload existing sessions only when their work, jobs, and editor drafts permit it.

`/date-reference` shows the saved reference without refreshing it. Before the first agent request, it reports that initialization is pending. The package registers no model tool.

## Context boundaries and recovery

The first agent request initializes a reference for a new root context. Successful committed compaction initializes another reference. The compaction entry's timestamp supplies the capture instant, so a delayed request still uses the boundary's local date. An unavailable time zone is `unknown`.

Ordinary user/tool turns, midnight, model changes, failed or refused compaction, extension reload, session resume, and return to an existing context do not refresh the reference. A new context with unchanged date and zone has identical section text. No exact time or context ID enters the prompt.

Small versioned custom entries retain the reference in Pi's existing session tree. They are not model-visible messages. Recovery first uses the active branch. Navigation to a checkpoint before its metadata child can recover a record with that exact root/compaction ID from the session's entries. It never imports a different context's state. There is no external database, timer, watcher, snapshot message, or automatic model request.

## Public hook integration

`before_agent_start` sets the named prompt section, after Pi's stable instructions. `turn_start` sees committed boundary-draft compactions before request-context admission. Native `session_compact` handles committed manual/automatic compactions too. Startup does not append metadata because a compaction owner can still be checking a provisional replacement session's freshness.

A read-only `context_with_system` transform updates only this named section in the outgoing system messages. This covers the first automatic continuation when Pi still holds the previous run's prompt options. It preserves every unrelated section, opaque content, tool declaration, message position, and timestamp. It never appends session entries after a compaction owner's request-context admission. It does not retain private prompt objects or force a whole-prompt replacement.

Prefix-cache reuse depends on the host/provider's projection and cache availability. Stable section text avoids ticking-clock changes. It does not guarantee cache hits. Compaction already changes the context projection.

## Verification and return

```sh
npm --prefix packages/pi-date-reference run syntax
npm --prefix packages/pi-date-reference test
```

The two focused checks cover metadata recovery and owned-section projection. An installed Pi 0.99.1 offline scenario also exercised root initialization, fixed ordinary turns, and the first boundary-draft continuation with selected Chrono V4 admission. The request transform kept the admitted session leaf unchanged. Late virtual-model compaction is covered by the host's awaited native `session_compact` event, but that routed path was not exercised. Another extension's whole-prompt override can remove named sections.

Required repository CI remains the merge gate. Loader selection and safe loaded-session use are separate activation checks. No provider/cache-performance measurement is claimed.

To disable the package, remove only its exact registration, preserve all session entries and unrelated settings, then reload safely. Original source is recoverable from accepted Git history. Do not restore a whole older settings file or remove historical references.
