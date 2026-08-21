# Herdr Status compatibility acceptance

Date: 2026-08-21

## Accepted runtime

- Pi: 0.84.1
- Herdr: 0.8.2
- Herdr official Pi integration: v8
- Package: `pi-herdr-status` 0.1.0

## Real acceptance result

The package passed direct acceptance in one disposable Herdr pane. The run loaded the installed package through Pi's normal package discovery. It did not use Pixel CUA.

The run verified these results:

- A real model turn reported the selected model and context percentage.
- A real Bash tool call reported `tool=bash` and a concise activity summary.
- A real write followed by a read reported one changed file.
- Turn and summary tokens changed with the Pi event lifecycle.
- Active reports used a 15,000 ms TTL.
- Report sequence values increased strictly, including across `/reload`.
- Three consecutive injected metadata failures activated one warning and exponential backoff.
- Reporting recovered after the metadata transport became healthy.
- `/herdr-status` showed healthy and failed transport states without private transport details.
- Session shutdown cleared all six tokens owned by `user:pi-rich-status`.
- The official `herdr:pi` session identity and semantic lifecycle state did not change while display metadata failed.

The focused fake-CLI suite also passed. It covers capability detection, argument construction, sanitization, ordering, retry behavior, and shutdown clearing.

## Ownership result

Herdr Status owns display metadata only. Herdr's official Pi integration still owns session identity and semantic `idle`, `working`, and `blocked` state. The package does not call `pane report-agent` or `pane report-agent-session`.

## Installation and rollback

Install from a reviewed local checkout with:

```sh
pi install /absolute/path/to/packages/herdr-status
```

Remove the same local package with:

```sh
pi remove /absolute/path/to/packages/herdr-status
```

Restore any prior Herdr sidebar row block from its protected configuration backup, then run:

```sh
herdr config check
herdr server reload-config
```

The 15-second TTL also bounds stale display metadata if Pi cannot run normal shutdown clearing.

## Release boundary

This acceptance validates compatibility with the exact runtime pair above. It does not publish the package to npm and does not make a general installation recommendation.
