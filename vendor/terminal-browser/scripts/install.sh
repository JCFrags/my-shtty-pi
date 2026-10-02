#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
if [ -f "$HERE/../build-manifest.json" ] && [ -x "$HERE/../electron/electron" ]; then
  # Validate physical archive files, not Electron's virtual ASAR entries.
  export ELECTRON_RUN_AS_NODE=1 ELECTRON_NO_ASAR=1
  exec "$HERE/../electron/electron" "$HERE/install-manager.mjs" "$@"
fi
exec node "$HERE/install-manager.mjs" "$@"
