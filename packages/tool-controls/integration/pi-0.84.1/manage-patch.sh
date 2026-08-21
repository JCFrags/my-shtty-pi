#!/usr/bin/env bash
set -euo pipefail

ACTION=${1:-verify}
: "${PI_ROOT:?Set PI_ROOT to the exact pi-coding-agent-0.84.1 package directory}"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BACKUP_DIR=${TOOL_CONTROLS_PI_BACKUP_DIR:-$PI_ROOT/.tool-controls-patch-backup-0.84.1}
ORIGINAL=$SCRIPT_DIR/original-sha256.txt
PATCHED=$SCRIPT_DIR/patched-sha256.txt
PATCH=$SCRIPT_DIR/pi-0.84.1-tool-controls.patch

verify_manifest() {
  local base=$1 manifest=$2
  (cd "$base" && sha256sum --quiet -c "$manifest")
}

copy_manifest_files() {
  local source=$1 destination=$2 manifest=$3
  while read -r _hash file; do
    mkdir -p "$destination/$(dirname "$file")"
    cp -a "$source/$file" "$destination/$file"
  done < "$manifest"
}

case "$ACTION" in
  verify)
    if verify_manifest "$PI_ROOT" "$PATCHED" >/dev/null 2>&1; then
      echo "Tool Controls Pi patch is active."
    elif verify_manifest "$PI_ROOT" "$ORIGINAL" >/dev/null 2>&1; then
      echo "Stock Pi 0.84.1 bytes are active."
    else
      echo "Pi bytes match neither the stock nor patched manifest." >&2
      exit 1
    fi
    ;;
  install)
    if verify_manifest "$PI_ROOT" "$PATCHED" >/dev/null 2>&1; then
      echo "Tool Controls Pi patch is already active."
      exit 0
    fi
    verify_manifest "$PI_ROOT" "$ORIGINAL"
    rm -rf "$BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
    copy_manifest_files "$PI_ROOT" "$BACKUP_DIR" "$ORIGINAL"
    cp "$ORIGINAL" "$BACKUP_DIR/original-sha256.txt"
    if ! patch --batch --forward -d "$PI_ROOT" -p1 < "$PATCH"; then
      copy_manifest_files "$BACKUP_DIR" "$PI_ROOT" "$ORIGINAL"
      echo "Patch failed. Stock bytes were restored." >&2
      exit 1
    fi
    verify_manifest "$PI_ROOT" "$PATCHED"
    echo "Installed Tool Controls Pi patch. Rollback: $0 rollback"
    ;;
  rollback)
    verify_manifest "$PI_ROOT" "$PATCHED"
    verify_manifest "$BACKUP_DIR" "$ORIGINAL"
    copy_manifest_files "$BACKUP_DIR" "$PI_ROOT" "$ORIGINAL"
    verify_manifest "$PI_ROOT" "$ORIGINAL"
    echo "Restored stock Pi 0.84.1 bytes."
    ;;
  *)
    echo "Usage: $0 {verify|install|rollback}" >&2
    exit 2
    ;;
esac
