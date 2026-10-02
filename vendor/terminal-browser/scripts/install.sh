#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
if [ -f "$HERE/../build-manifest.json" ] && [ -x "$HERE/../electron/electron" ]; then
  export ELECTRON_RUN_AS_NODE=1
  exec "$HERE/../electron/electron" "$HERE/install-manager.mjs" "$@"
fi
exec node "$HERE/install-manager.mjs" "$@"
