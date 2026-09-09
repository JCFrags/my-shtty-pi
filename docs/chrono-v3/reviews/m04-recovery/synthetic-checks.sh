#!/usr/bin/env bash
set -euo pipefail
umask 077
BASE=REDACTED_PRIVATE_PREPARATION_DIRECTORY
HELPER=$BASE/boot-recovery-m04.mjs
REPO=REDACTED_LOCAL_GIT_CHECKOUT
COMMIT=dcd91924dbcfc0c02489e04c3e163b33e2b08e86
PREFIX=packages/pi-chrono-compaction
RUNS=$BASE/synthetic-runs
RECEIPTS=$BASE/receipts

for stable in "$RUNS" "$RECEIPTS"; do
  if [[ ! -e $stable ]]; then mkdir -m 700 -- "$stable"; fi
  [[ -d $stable && ! -L $stable && $(stat -c '%u:%a' "$stable") == "$(id -u):700" ]]
done

# Every invocation and case root is allocated atomically. No fixed prior name is
# reused, reclaimed, or removed. There is intentionally no EXIT cleanup trap:
# any failure preserves this invocation's log and all of its exact fixtures.
WORK=$(mktemp -d "$RUNS/recovery-test-work-XXXXXXXX")
MISMATCH=$(mktemp -d "$RUNS/recovery-test-mismatch-XXXXXXXX")
PARTIAL=$(mktemp -d "$RUNS/recovery-test-partial-XXXXXXXX")
FRESH=$(mktemp -d "$RUNS/recovery-test-fresh-XXXXXXXX")
LOG=$WORK/synthetic-check.log
printf 'synthetic invocation root: %s\nfailure log: %s\n' "$WORK" "$LOG"
exec > >(tee "$LOG") 2>&1

mkdir -m 700 "$WORK/archive"
git -C "$REPO" archive "$COMMIT" "$PREFIX/package.json" "$PREFIX/dist/src" | tar -x -C "$WORK/archive"
PKG=$WORK/archive/$PREFIX
chmod -R u+rwX,go-w "$WORK/archive"

pass=0
assert_code_reason() {
  local expected_code=$1 expected_reason=$2; shift 2
  local out code
  set +e
  out=$("$@" 2>&1)
  code=$?
  set -e
  [[ $code -eq $expected_code ]]
  [[ $out == *"\"reason\":\"$expected_reason\""* ]]
  pass=$((pass+1))
}

# The candidate has no production apply path, even with an accepted package.
assert_code_reason 1 production-apply-disabled node "$HELPER" --package "$PKG" --apply

# Hidden policy/path overrides are refused before any namespace work.
assert_code_reason 1 environment-override-refused env PI_CHRONO_CATALOG_SHADOW=1 node "$HELPER" --package "$PKG" --check

# A byte mismatch against the git-derived 96-entry manifest refuses.
printf '\n' >> "$PKG/dist/src/user-config.js"
assert_code_reason 1 accepted-package-mismatch node "$HELPER" --package "$PKG" --check --synthetic-root "$MISMATCH"
git -C "$REPO" show "$COMMIT:$PREFIX/dist/src/user-config.js" > "$PKG/dist/src/user-config.js"
chmod 600 "$PKG/dist/src/user-config.js"

# Any occupied or partial namespace refuses and the foreign byte stays intact.
mkdir -m 700 "$PARTIAL/runtime"
printf 'preserve-me' > "$PARTIAL/runtime/foreign"
assert_code_reason 1 partial-or-foreign-namespace node "$HELPER" --package "$PKG" --apply --synthetic-root "$PARTIAL"
[[ $(cat "$PARTIAL/runtime/foreign") == preserve-me ]]
[[ ! -e "$PARTIAL/legacy" ]]
pass=$((pass+1))

# Fresh check uses accepted M04 APIs and reports recoverability without writing.
set +e
fresh_check=$(node "$HELPER" --package "$PKG" --check --synthetic-root "$FRESH" 2>&1)
fresh_code=$?
set -e
[[ $fresh_code -eq 2 && $fresh_check == *'"recoverableFresh":true'* && $fresh_check == *'"changed":false'* ]]
[[ ! -e "$FRESH/runtime" && ! -e "$FRESH/legacy" ]]
pass=$((pass+1))

# Synthetic apply is restricted to the new private namespace and verifies the
# actual accepted policy/gate/systemd APIs, all four units, and double scans.
apply_out=$(node "$HELPER" --package "$PKG" --apply --synthetic-root "$FRESH")
[[ $apply_out == *'"ready":true'* && $apply_out == *'"fixedUnitsInactive":true'* && $apply_out == *'"workersQuiescent":true'* && $apply_out == *'"productionApplyEnabled":false'* ]]
[[ $(stat -c %a "$FRESH/runtime" "$FRESH/legacy") == $'700\n700' ]]
[[ $(find "$FRESH/runtime" "$FRESH/legacy" -type f ! -perm 600 -print -quit) == '' ]]
[[ $(find "$FRESH/runtime" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | paste -sd, -) == admission.lock,legacy-gate.json,policy.json ]]
[[ $(find "$FRESH/legacy" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | paste -sd, -) == slot-0.json,slot-1.json,slot-2.json,slot-3.json ]]
pass=$((pass+1))

# Explicitly call the accepted gate's current-boot identity verifier. It checks
# the live boot ID and PID 1 start identity as well as all four inhibitors.
node --input-type=module - "$PKG" "$FRESH/runtime" "$FRESH/legacy" <<'NODE'
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [pkg, runtime, legacy] = process.argv.slice(2);
const gate = await import(pathToFileURL(join(pkg, 'dist/src/worker-runtime-legacy-gate.js')).href);
if (await gate.verifyLegacyAdmissionGate(runtime, legacy) !== true) process.exit(1);
NODE
pass=$((pass+1))

# Fresh-only behavior refuses an already initialized namespace and preserves it.
policy_before=$(sha256sum "$FRESH/runtime/policy.json" | cut -d' ' -f1)
assert_code_reason 1 occupied-namespace-refused node "$HELPER" --package "$PKG" --check --synthetic-root "$FRESH"
[[ $(sha256sum "$FRESH/runtime/policy.json" | cut -d' ' -f1) == "$policy_before" ]]
pass=$((pass+1))

# Static safety boundary: no stop, kill, gate removal, cleanup, or production enable.
! grep -Eq 'stopRuntimeNamespace|removeLegacyAdmissionGate|process\.kill|\brm\s*\(' "$HELPER"
grep -q "productionApplyEnabled === false" "$HELPER"
grep -q "production-apply-disabled" "$HELPER"
pass=$((pass+1))

# Publish a new collision-safe receipt. Never overwrite any earlier receipt.
RESULT=$(mktemp "$RECEIPTS/synthetic-check-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX.json")
printf '{"status":"passed","checks":%d,"acceptedCommit":"%s","manifestEntries":96,"productionApplyEnabled":false,"syntheticOnly":true,"currentBootIdentityApiVerified":true}\n' "$pass" "$COMMIT" > "$RESULT"
chmod 600 "$RESULT"
printf 'synthetic checks passed: %d\nreceipt: %s\n' "$pass" "$RESULT"

# Success-only cleanup. These four paths were created exclusively by this
# invocation; successful apply already rechecked all four units inactive.
rm -rf -- "$WORK" "$MISMATCH" "$PARTIAL" "$FRESH"
printf 'successful invocation fixtures removed\n'
