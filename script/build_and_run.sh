#!/usr/bin/env bash
set -euo pipefail
COBOARD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COBOARD_MODE="${1:-run}"
case "$COBOARD_MODE" in run|--preview|--debug|--logs|--telemetry|--verify) ;; *) echo "Usage: $0 [--preview|--debug|--logs|--telemetry|--verify]" >&2; exit 2;; esac
# Refuse a restart while another instance could own unsaved screen annotations.
# Process inspection must succeed; a restricted sandbox must not be treated as "not running".
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
cd "$COBOARD_ROOT/apps/coboard-desktop"
if [[ "$COBOARD_MODE" == '--preview' ]]; then
  npm run tauri build -- --debug --bundles app --config '{"identifier":"app.coboard.ink-preview","productName":"Coboard Ink Preview"}'
  COBOARD_APP="$COBOARD_ROOT/target/debug/bundle/macos/Coboard Ink Preview.app"
else
  npm run tauri build -- --debug --bundles app
  COBOARD_APP="$COBOARD_ROOT/target/debug/bundle/macos/Coboard.app"
fi
# Verify the complete bundle, including its resource seal, before launching.
# A linker-signed Mach-O alone is not a valid signed application bundle.
/usr/bin/codesign --verify --deep --strict "$COBOARD_APP"
if [[ "$COBOARD_MODE" == '--debug' ]]; then
  exec lldb -- "$COBOARD_APP/Contents/MacOS/coboard-desktop"
fi
/usr/bin/open -n "$COBOARD_APP"
case "$COBOARD_MODE" in
  --verify) sleep 2; pgrep -x coboard-desktop >/dev/null ;;
  --logs) exec /usr/bin/log stream --info --style compact --predicate 'process == "coboard-desktop"' ;;
  --telemetry) exec /usr/bin/log stream --info --style compact --predicate 'subsystem == "app.coboard.desktop"' ;;
esac
