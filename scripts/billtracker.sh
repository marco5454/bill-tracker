#!/usr/bin/env bash
# Bill & Credit Tracker launcher (Ubuntu/Linux/macOS).
#
# Behaviour:
#   1. cd into the repo (the script's parent directory).
#   2. If node_modules is missing, run `npm install`.
#   3. If dist/ is missing or older than the newest source file, run `npm run build`.
#   4. Start `npm start` and open http://localhost:<PORT> in the default browser.
#
# Configure via environment variables, .env, or by editing this file:
#   PORT                       API + UI port (default 3000)
#   HOST                       Bind address (default from .env, else 127.0.0.1)
#   BILLTRACKER_OPEN_BROWSER   "0" disables the auto-open
#
# This launcher does not override HOST/PORT/etc. when set in your .env file.
#
# Usage:
#   bash scripts/billtracker.sh
#   ./scripts/billtracker.sh        # if executable
#
# To make a desktop entry on Ubuntu, run: npm run install:desktop
# (template lives at scripts/Billtracker.desktop.template)

set -euo pipefail

# Resolve repo root (script lives in repo/scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

# Read .env (if present) so we can show the right URL when opening the browser.
# The server itself loads .env via dotenv; we only source it here for display.
if [ -f ".env" ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"
OPEN_BROWSER="${BILLTRACKER_OPEN_BROWSER:-1}"

# --- Pre-flight checks -------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 'node' not found in PATH." >&2
  echo "Install Node.js 20.19+ from https://nodejs.org/ or via your package manager." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18.19 or newer required (found $(node -v))." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: 'npm' not found in PATH." >&2
  exit 1
fi

# --- Install dependencies on first run --------------------------------------

if [ ! -d "node_modules" ] || [ ! -f "node_modules/.package-lock.json" ]; then
  echo "[billtracker] Installing dependencies (this only happens the first time)..."
  # Prefer reproducible installs when a lockfile exists.
  if [ -f "package-lock.json" ]; then
    npm ci
  else
    npm install
  fi
fi

# --- Build the client if missing or stale -----------------------------------

needs_build=0
if [ ! -f "dist/index.html" ]; then
  needs_build=1
else
  # Stale if any client source is newer than dist/index.html.
  if [ -n "$(find client -type f -newer dist/index.html -print -quit 2>/dev/null)" ]; then
    needs_build=1
  fi
fi

if [ "$needs_build" = "1" ]; then
  echo "[billtracker] Building client..."
  npm run build
fi

# --- Open browser shortly after server starts -------------------------------

if [ "$OPEN_BROWSER" = "1" ]; then
  URL="http://${HOST}:${PORT}"
  if [ "$HOST" = "0.0.0.0" ]; then URL="http://127.0.0.1:${PORT}"; fi
  ( sleep 2
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$URL" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then
      open "$URL" >/dev/null 2>&1 || true
    fi
  ) &
fi

# --- Run the server ----------------------------------------------------------

echo "[billtracker] Starting on http://${HOST}:${PORT}  (Ctrl+C to stop)"
exec npm start
