#!/usr/bin/env bash
# Install (or refresh) the Bill & Credit Tracker desktop entry into the
# current user's applications directory. After running this once, Billtracker
# appears in your application menu and can be launched from the Activities
# overview / Dash without opening a terminal.
#
# Idempotent: safe to run again after moving the repo to a new location.
#
# Usage:
#   ./scripts/install-desktop.sh           # install for current user
#   ./scripts/install-desktop.sh --remove  # uninstall

set -euo pipefail

# Resolve the repo root from this script's location, regardless of cwd.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

TEMPLATE="$SCRIPT_DIR/Billtracker.desktop.template"
DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DEST_FILE="$DEST_DIR/billtracker.desktop"
LAUNCHER="$SCRIPT_DIR/billtracker.sh"
ICON="$REPO_ROOT/client/public/icons/icon-512.png"

case "${1:-}" in
  -h|--help)
    sed -n '2,12p' "$0"
    exit 0
    ;;
  --remove|-r)
    if [ -f "$DEST_FILE" ]; then
      rm -f "$DEST_FILE"
      echo "[install-desktop] removed $DEST_FILE"
      command -v update-desktop-database >/dev/null 2>&1 \
        && update-desktop-database "$DEST_DIR" 2>/dev/null || true
    else
      echo "[install-desktop] nothing to remove (no file at $DEST_FILE)"
    fi
    exit 0
    ;;
  "")
    : # default: install
    ;;
  *)
    echo "[install-desktop] unknown argument: $1" >&2
    echo "Usage: $0 [--remove]" >&2
    exit 2
    ;;
esac

# Sanity checks.
if [ ! -f "$TEMPLATE" ]; then
  echo "[install-desktop] template not found at $TEMPLATE" >&2
  exit 1
fi
if [ ! -f "$LAUNCHER" ]; then
  echo "[install-desktop] launcher script missing at $LAUNCHER" >&2
  exit 1
fi
if [ ! -f "$ICON" ]; then
  echo "[install-desktop] icon missing at $ICON" >&2
  echo "                  run \`node scripts/generate-icons.mjs\` first" >&2
  exit 1
fi

# Make sure the launcher is executable. Some archive tools (zip extraction in
# Files / unzip without -K) drop the +x bit; restore it here so the desktop
# entry actually fires.
if [ ! -x "$LAUNCHER" ]; then
  chmod +x "$LAUNCHER"
  echo "[install-desktop] restored +x on $LAUNCHER"
fi

mkdir -p "$DEST_DIR"

# Render template -> destination. We use awk (not sed) because the repo path
# may contain characters that would need escaping in sed (most commonly '/',
# but also '&' and '|'). awk gsub handles the literal substitution cleanly.
awk -v repo="$REPO_ROOT" '{ gsub(/\{\{REPO_PATH\}\}/, repo); print }' \
  "$TEMPLATE" > "$DEST_FILE"
chmod 644 "$DEST_FILE"

echo "[install-desktop] installed: $DEST_FILE"
echo "[install-desktop] repo path: $REPO_ROOT"

# Refresh the desktop database so the new entry appears immediately in menus.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DEST_DIR" 2>/dev/null || true
  echo "[install-desktop] desktop database refreshed"
else
  echo "[install-desktop] (update-desktop-database not found; the menu may"
  echo "                  pick up the entry on next login)"
fi

# Validate the entry against the freedesktop.org spec, when available. Helps
# catch typos in the template. We deliberately don't fail the whole install
# on a warning — Ubuntu's desktop-file-utils is sometimes pickier than the
# launchers that read the file.
if command -v desktop-file-validate >/dev/null 2>&1; then
  if ! desktop-file-validate "$DEST_FILE"; then
    echo "[install-desktop] (warnings above are non-fatal)"
  fi
fi

echo
echo "Look for \"Bill & Credit Tracker\" in your application menu."
echo "To uninstall: ./scripts/install-desktop.sh --remove"
