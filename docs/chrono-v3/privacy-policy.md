# M00 privacy and publication policy

## Repository state

`JCFrags/my-shtty-pi` is a private repository. Prior public reachability is retained as incident history; changing visibility does not claim that earlier copies were retracted. Verify the repository is private before every push, pull request, or final publication report:

```sh
gh repo view JCFrags/my-shtty-pi --json nameWithOwner,visibility,isPrivate,isFork
```

The expected identity is `JCFrags/my-shtty-pi`, `visibility=PRIVATE`, and `isPrivate=true`. No force push, history rewrite, release, package publication, deployment, or visibility change is permitted as part of M00.

## Never commit

- Pi session JSONL, session excerpts, or raw tool output;
- source-ledger, catalog, memory-store, scheduler, worker, or diagnostic artifacts;
- credentials, API keys, tokens, cookies, private keys, `.env` files, or credential URLs;
- home-directory inventories, absolute private paths, core dumps, or private benchmark manifests;
- deployed backup copies or local configuration files;
- `node_modules` or generated private evidence.

Owner-only evidence belongs under the ignored `.chrono-v3-private/` directory in the execution clone. That directory is not a project artifact and must not be staged.

## Allowed publication

Source, deterministic tests, synthetic fixtures, sanitized aggregate measurements, architecture documents, and reproducible verification tools may be committed. Synthetic JSONL is allowed only when it is clearly fabricated, contains no private paths or identifiers, and is covered by the privacy verifier.

The public test suite must never depend on the affected live session. It creates temporary synthetic data and removes it after each test.

## Required gates

Run these before a milestone commit and again before each push:

```sh
node scripts/verify-chrono-v3-privacy.mjs --self-test
npm run verify
```

For a local deployment comparison, run the baseline verifier without `--allow-missing-live`. CI uses `--allow-missing-live` because it has no local Pi installation. The verifier prints hashes and bounded metadata, never source history or session content.

The privacy verifier scans both current worktree bytes and staged index bytes. It includes non-ignored untracked files, excludes the private evidence directory through Git's ignore rules, and reports only relative file names and finding categories.

A finding that is not proven safe blocks publication. M00 has a P1 exposure classification from historical metadata and limited CI metadata, but no confirmed P2 credential or private session material.
