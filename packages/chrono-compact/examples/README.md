# Offline example

This example uses the included `synthetic-session.jsonl` fixture. The fixture is fabricated public-safe content. It contains no real session data.

From this package directory, run:

```bash
npm run build
node dist/src/cli.js compact examples/synthetic-session.jsonl \
  --target 2500 \
  --hint "Preserve the public API restriction." \
  --out examples/synthetic-replay.md \
  --details examples/synthetic-plan.json
```

`npm run build` creates the source-only checkout's local `dist/src/cli.js` output. The generated replay and plan are local outputs and are not part of this source tree. The exact command uses the package script and CLI options declared in `package.json` and `src/cli.ts`.
