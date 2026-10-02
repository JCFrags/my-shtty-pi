#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")}"
CHANNEL="${2:-dev}"
OUT="${TERMINAL_BROWSER_RELEASE_OUT:-$ROOT/dist-release}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
if [ -n "$(ls -A "$OUT")" ]; then
  echo "choose an empty TERMINAL_BROWSER_RELEASE_OUT; existing artifacts and build workspaces are not overwritten" >&2; exit 1
fi
WORK="$(mktemp -d "$OUT/.build-XXXXXX")"
STAGE="$WORK/terminal-browser"
trap 'echo "build workspace: $WORK" >&2' EXIT

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) TARGET=linux-x64 ;;
  *) echo "standalone releases currently support Linux x64 only" >&2; exit 1 ;;
esac
node -e 'if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(process.argv[1]) || !/^[a-z][a-z0-9-]*$/.test(process.argv[2])) throw Error("invalid version or channel"); if (process.argv[2] !== "dev" && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(process.argv[1])) throw Error("release version must be SemVer")' "$VERSION" "$CHANNEL"

node "$ROOT/scripts/dist-manifest.mjs" source "$ROOT" "$WORK/source.json"
if [ "$CHANNEL" != dev ]; then
  node -e 'if(require(process.argv[1]).dirty) throw Error("published releases require clean source")' "$WORK/source.json"
fi
node -e 'const fs=require("fs"); if(!fs.readFileSync(process.argv[1]).equals(fs.readFileSync(process.argv[2]))) throw Error("installed pnpm lock differs; prepare locked dependencies before building")' "$ROOT/pnpm-lock.yaml" "$ROOT/node_modules/.pnpm/lock.yaml"
mkdir -p "$STAGE"/{bin,cli/dist,browser/dist,browser/native,assets/fonts,scripts,pi-extension/dist,herdr-plugin,metadata,licenses} "$WORK/build-home"
NATIVE_TARGET="${TERMINAL_BROWSER_NATIVE_TARGET:-$WORK/native}"
mkdir -p "$NATIVE_TARGET"
NATIVE_TARGET="$(cd "$NATIVE_TARGET" && pwd -P)"
case "$NATIVE_TARGET/" in "$ROOT/engine/target/"*) echo "release must not use the development native target directory" >&2; exit 1 ;; esac
# Rust flags do not cover C/C++ dependencies such as tree-sitter.
CARGO_SOURCE="${CARGO_HOME:-$HOME/.cargo}"
NATIVE_MAP="-ffile-prefix-map=$HOME=build-home -ffile-prefix-map=$ROOT=terminal-browser -ffile-prefix-map=$CARGO_SOURCE=cargo -ffile-prefix-map=$NATIVE_TARGET=native-build"
(cd "$ROOT/engine" && CARGO_TARGET_DIR="$NATIVE_TARGET" \
  RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=build-home --remap-path-prefix=$ROOT=terminal-browser --remap-path-prefix=$CARGO_SOURCE=cargo --remap-path-prefix=$NATIVE_TARGET=native-build" \
  CFLAGS="${CFLAGS:-} $NATIVE_MAP" CXXFLAGS="${CXXFLAGS:-} $NATIVE_MAP" \
  cargo build --locked -p pixel-node --release)
cp "$NATIVE_TARGET/release/libpixel_node.so" "$STAGE/browser/native/pixel.node"

cd "$ROOT"
"$ROOT/scripts/bundle.sh" "$ROOT/cli/src/main.ts" "$STAGE/cli/dist/main.js"
"$ROOT/scripts/bundle.sh" "$ROOT/browser/src/main.tsx" "$STAGE/browser/dist/main.js"
"$ROOT/scripts/bundle.sh" "$ROOT/scripts/test/runtime-smoke.ts" "$STAGE/browser/dist/runtime-check.js"
"$ROOT/pi-extension/node_modules/.bin/tsc" -p "$ROOT/pi-extension/tsconfig.json" --outDir "$STAGE/pi-extension/dist"
printf 'export const launchMode = "bundle";\n' > "$STAGE/pi-extension/dist/launch-mode.js"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));delete p.scripts;delete p.devDependencies;fs.writeFileSync(process.argv[2],JSON.stringify(p,null,2)+"\n")' "$ROOT/pi-extension/package.json" "$STAGE/pi-extension/package.json"
cp "$ROOT/herdr-plugin/"*.sh "$STAGE/herdr-plugin/"
node -e 'const fs=require("fs");const text=fs.readFileSync(process.argv[1],"utf8"); const result=text.replace(/\[\[build\]\][\s\S]*?(?=\[\[)/g,""); if(result===text) throw Error("missing Herdr build block"); fs.writeFileSync(process.argv[2],result)' "$ROOT/herdr-plugin/herdr-plugin.toml" "$STAGE/herdr-plugin/herdr-plugin.toml"
cat > "$STAGE/herdr-plugin/launch.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
self="$(readlink -f "${BASH_SOURCE[0]}")"
root="$(cd "$(dirname "$self")/.." && pwd -P)"
exec "$root/bin/terminal-browser" "$@"
EOF
cp "$ROOT/scripts/apparmor.sh" "$ROOT/scripts/dist-manifest.mjs" "$ROOT/scripts/install-manager.mjs" "$ROOT/scripts/extract-dist.py" "$ROOT/scripts/install.sh" "$ROOT/scripts/install-local.sh" "$STAGE/scripts/"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
cp "$ROOT/pnpm-lock.yaml" "$ROOT/upstreams.lock.json" "$ROOT/copy-provenance.json" "$STAGE/metadata/"
cp "$ROOT/engine/Cargo.lock" "$STAGE/metadata/Cargo.lock"
env -i PATH="$PATH" HOME="$WORK/build-home" XDG_CONFIG_HOME="$WORK/build-home/config" XDG_DATA_HOME="$WORK/build-home/data" XDG_STATE_HOME="$WORK/build-home/state" XDG_CACHE_HOME="$WORK/build-home/cache" XDG_RUNTIME_DIR="$WORK/build-home/runtime" TERMINAL_BROWSER_APPDATA="$WORK/build-home/appdata" TERMINAL_BROWSER_INTEROP_DIR="$WORK/build-home/interop" PI_CODING_AGENT_DIR="$WORK/build-home/pi" TERMINAL_BROWSER_SKILL_OUT="$STAGE/skills" "$ROOT/scripts/generate-skill.sh"
cp "$ROOT/assets/fonts/JetBrainsMono-Regular.ttf" "$ROOT/assets/fonts/LICENSE.txt" "$STAGE/assets/fonts/"
cp -R "$ROOT/assets/blocking" "$STAGE/assets/blocking"
mkdir -p "$STAGE/licenses/notices"
cp -R "$ROOT/assets/licenses/easylist" "$ROOT/assets/licenses/ghostery-adblocker" "$STAGE/licenses/notices/"
mkdir -p "$STAGE/assets/react-grab"
REACT_GRAB="$(node -e 'console.log(require.resolve("react-grab/dist/index.global.js",{paths:[process.argv[1]]}))' "$ROOT/browser")"
cp "$REACT_GRAB" "$STAGE/assets/react-grab/index.global.js"
"$ROOT/scripts/fetch-electron.sh" --dest "$STAGE/electron"

ELECTRON_EXE="electron/electron"
cat > "$STAGE/bin/terminal-browser" <<EOF
#!/bin/sh
SELF="\$0"
while [ -L "\$SELF" ]; do
  LINK="\$(readlink "\$SELF")"
  case "\$LINK" in
    /*) SELF="\$LINK" ;;
    *) SELF="\$(dirname -- "\$SELF")/\$LINK" ;;
  esac
done
ROOT="\$(CDPATH= cd -- "\$(dirname -- "\$SELF")/.." && pwd -P)"
export TERMINAL_BROWSER_DIST_ROOT="\$ROOT"
export ELECTRON_RUN_AS_NODE=1
exec "\$ROOT/$ELECTRON_EXE" "\$ROOT/cli/dist/main.js" "\$@"
EOF
chmod +x "$STAGE/bin/terminal-browser" "$STAGE/herdr-plugin/launch.sh"
node "$ROOT/scripts/dist-seal.mjs" prepare "$ROOT" "$STAGE" "$WORK/source.json" "$VERSION" "$CHANNEL" "$TARGET"
ID="$(node "$ROOT/scripts/dist-seal.mjs" seal "$ROOT" "$STAGE" "$WORK/source.json")"
mkdir "$OUT/$ID"
mv "$STAGE" "$OUT/$ID/terminal-browser"
STAGE="$OUT/$ID/terminal-browser"
SEALED_VERSION="$(cat "$STAGE/VERSION")"
TARBALL="$OUT/terminal-browser-$SEALED_VERSION-$TARGET.tar.gz"
tar -czf "$TARBALL" -C "$OUT/$ID" terminal-browser
node "$ROOT/scripts/dist-seal.mjs" archive "$STAGE" "$TARBALL" "$OUT/manifest-$TARGET.json"
node "$ROOT/scripts/dist-manifest.mjs" verify "$STAGE" "$OUT/manifest-$TARGET.json"
BOOTSTRAP="$WORK/terminal-browser-installer"
mkdir "$BOOTSTRAP"
cp "$STAGE/scripts/"{install.sh,install-manager.mjs,dist-manifest.mjs,extract-dist.py} "$STAGE/LICENSE" "$STAGE/SOURCE.md" "$BOOTSTRAP/"
INSTALLER="$OUT/terminal-browser-installer-$SEALED_VERSION.tar.gz"
tar -czf "$INSTALLER" -C "$WORK" terminal-browser-installer
(cd "$OUT" && sha256sum "$(basename "$TARBALL")" "manifest-$TARGET.json" "$(basename "$INSTALLER")" > SHA256SUMS)
du -h "$TARBALL" "$INSTALLER"
