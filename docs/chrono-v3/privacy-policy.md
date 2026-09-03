# M00 privacy and publication policy

## Repository state

`JCFrags/my-shtty-pi` is currently a public repository for the explicitly authorized M00-R1 review. Public visibility does not make private session data, credentials, raw diagnostics, or owner-only evidence publishable. The earlier public interval remains incident history; changing visibility does not claim that earlier copies were retracted.

Before every push, pull request update, or final publication report, verify the exact repository identity and public state through an authenticated API check:

```sh
gh repo view JCFrags/my-shtty-pi --json nameWithOwner,visibility,isPrivate,isFork
```

The expected identity is `JCFrags/my-shtty-pi`, `visibility=PUBLIC`, `isPrivate=false`, and `isFork=false`. A mismatch blocks publication. This check is separate from the content scanner. No force push, history rewrite, release, package publication, deployment, or M01 work is permitted as part of M00-R1.

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
node scripts/verify-chrono-v3-privacy.mjs --self-test --worktree --index --all-refs
npm run verify
```

The CI invocation additionally requires public-review event identity and uses an explicit full-ref fetch. For a local deployment comparison, run the baseline verifier without `--allow-missing-live`. CI uses `--allow-missing-live` because it has no local Pi installation. The verifier prints hashes and bounded metadata, never source history or session content.

The privacy verifier scans current worktree bytes, staged index bytes, Git objects in requested history/ranges, and all fetched refs. It includes non-ignored untracked files, excludes the private evidence directory through Git's ignore rules, uses bounded/no-follow reads, and reports only relative file names, categories, safe object prefixes, and line numbers. Historical fixture allowances are exact path-plus-blob matches for the recorded safe objects and do not suppress worktree or index scanning.

A finding, unscanned input, unsafe file type, malformed event, identity mismatch, or unexplained correction artifact blocks publication. The known exposure classification is P1 for limited historical metadata and CI metadata; no P2 credential or private session material and no P3 surface were confirmed.
