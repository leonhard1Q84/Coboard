#!/usr/bin/env bash
set -euo pipefail
COBOARD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COBOARD_MODE="${1:-run}"
case "$COBOARD_MODE" in run|--build-only|--preview|--debug|--logs|--telemetry|--verify) ;; *) echo "Usage: $0 [--build-only|--preview|--debug|--logs|--telemetry|--verify]" >&2; exit 2;; esac
# Refuse a restart while another instance could own unsaved screen annotations.
# Process inspection must succeed; a restricted sandbox must not be treated as "not running".
if [[ "$COBOARD_MODE" != '--build-only' ]]; then
  if ! COBOARD_PROCESSES="$(ps -axo comm=)"; then
    echo 'Cannot inspect running processes in this environment.' >&2
    exit 1
  fi
  COBOARD_PROCESS_PATTERN='/coboard-desktop$'
  if [[ "$COBOARD_MODE" == '--preview' ]]; then
    COBOARD_PROCESS_PATTERN='Coboard Ink Preview.app/Contents/MacOS/coboard-desktop$'
  fi
  if printf '%s\n' "$COBOARD_PROCESSES" | rg -q "$COBOARD_PROCESS_PATTERN"; then
    echo 'Save your work and quit Coboard before running this script.' >&2
    exit 1
  fi
fi
cd "$COBOARD_ROOT/apps/coboard-desktop"
COBOARD_BUILD_ARGS=(--bundles app --ci)
COBOARD_PROFILE=release
COBOARD_APP_NAME=Coboard
if [[ "$COBOARD_MODE" == '--debug' ]]; then
  COBOARD_BUILD_ARGS+=(--debug)
  COBOARD_PROFILE=debug
fi
if [[ "$COBOARD_MODE" == '--preview' ]]; then
  COBOARD_BUILD_ARGS+=(--config '{"identifier":"app.coboard.ink-preview","productName":"Coboard Ink Preview"}')
  COBOARD_APP_NAME='Coboard Ink Preview'
fi
npm run tauri -- build "${COBOARD_BUILD_ARGS[@]}" -- --locked
# Resolve Cargo's actual output directory, including CARGO_TARGET_DIR/config.
cd "$COBOARD_ROOT/apps/coboard-desktop/src-tauri"
COBOARD_TARGET_DIR="$(cargo metadata --locked --no-deps --format-version 1 | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => process.stdout.write(JSON.parse(s).target_directory));')"
COBOARD_APP="$COBOARD_TARGET_DIR/$COBOARD_PROFILE/bundle/macos/$COBOARD_APP_NAME.app"
# Verify the complete bundle, including its resource seal, before launching.
# A linker-signed Mach-O alone is not a valid signed application bundle.
/usr/bin/codesign --verify --deep --strict "$COBOARD_APP"
if [[ "$COBOARD_PROFILE" == release ]]; then
  node "$COBOARD_ROOT/script/check-app-size.mjs" "$COBOARD_APP"
fi
if [[ "$COBOARD_MODE" == '--build-only' ]]; then
  printf 'Built: %s\n' "$COBOARD_APP"
  exit 0
fi
if [[ "$COBOARD_MODE" == '--debug' ]]; then
  exec lldb -- "$COBOARD_APP/Contents/MacOS/coboard-desktop"
fi
/usr/bin/open -n "$COBOARD_APP"
case "$COBOARD_MODE" in
  --verify) sleep 2; pgrep -x coboard-desktop >/dev/null ;;
  --logs) exec /usr/bin/log stream --info --style compact --predicate 'process == "coboard-desktop"' ;;
  --telemetry) exec /usr/bin/log stream --info --style compact --predicate 'subsystem == "app.coboard.desktop"' ;;
esac
