# Bill & Credit Tracker

A locally-hosted personal finance app for tracking recurring bills and credit/loan payments. All data lives in a SQLite file on your machine — nothing leaves your computer.

## Stack

- **Backend:** Node.js 20+, Express, better-sqlite3, Helmet, rate limiting
- **Frontend:** Vanilla ES modules + Vite (dev server with HMR)
- **Database:** SQLite (WAL mode, foreign keys, automatic backup rotation)

## Project layout

```
billtracker/
├── server/              # Express API + SQLite layer
│   ├── index.js         # App entry, middleware, routes wiring
│   ├── db.js            # SQLite connection + migrations + auto-backup + pingDb
│   ├── logger.js        # Tiny zero-dep structured logger
│   ├── migrate.js       # Migration runner (server/migrations/NNN_*.sql)
│   ├── migrations/      # 001_init.sql, 002_version_columns.sql, ...
│   ├── middleware/
│   │   ├── error.js         # Centralized error handler, HttpError class
│   │   ├── validate.js      # Tiny dependency-free request validator
│   │   ├── request-id.js    # Per-request id + child logger
│   │   ├── access-log.js    # Structured HTTP access log
│   │   └── concurrency.js   # If-Match / ETag helpers
│   └── routes/
│       ├── bills.js     # CRUD + cycle payment toggle (optimistic concurrency)
│       ├── credits.js   # CRUD + monthly payment toggle (optimistic concurrency)
│       ├── settings.js  # Currency, full export/import, reset
│       └── health.js    # Liveness + readiness with DB ping
├── client/              # Frontend (PWA: offline + installable)
│   ├── index.html       # Lean shell
│   ├── public/          # PWA manifest, icons, service worker (copied to dist/)
│   ├── styles/          # main / components / responsive
│   └── src/
│       ├── main.js          # Bootstrap + tab routing + SW registration
│       ├── api.js           # Storage shim (delegates to remote or local)
│       ├── api-network.js   # Fetch wrapper (sends If-Match for writes)
│       ├── storage/         # local-store (IndexedDB) + remote-store + selector
│       ├── state.js         # In-memory cache + pub/sub
│       ├── format.js        # Money/date helpers, escapeHtml, CSV (with formula-injection guard)
│       ├── cycle.js         # Bill cycle logic (Monthly/Quarterly/Annually)
│       ├── credit-math.js   # Simple + monthly add-on interest
│       ├── modules/         # dashboard / bills / credits / settings
│       └── ui/              # modal / toast / confirm
├── scripts/             # Launchers (.sh / .bat), .desktop template + installer, icon generator
├── tests/               # node --test suites + harness (isolated temp DBs)
├── data/                # SQLite database + rotating backups (gitignored)
├── vite.config.js
├── .env.example         # Documented configuration knobs
└── package.json
```

## Setup

Requires **Node.js 20 or newer**.

```bash
npm install
```

`better-sqlite3` will compile a small native binding on install (~30s).

## Run (development)

```bash
npm run dev
```

This starts:
- the API on `http://localhost:3000`
- the Vite dev server on `http://localhost:5173` (with `/api/*` proxied to the API)

Open <http://localhost:5173>.

You can also run them individually:

```bash
npm run dev:server    # just the API
npm run dev:client    # just the frontend (requires API running)
```

## Run (production-style build)

```bash
npm run build         # builds client into dist/
npm start             # serves dist/ + API together on port 3000
```

Open <http://localhost:3000>.

## One-click launchers

The `scripts/` directory contains thin wrappers that handle dependency install, client build, and starting the server. They are the easiest way to start the app on a fresh checkout.

**Ubuntu / macOS:**

```bash
./scripts/billtracker.sh
```

The script checks Node.js is present (≥18.19), runs `npm install` if `node_modules/` is missing, runs `npm run build` if `dist/index.html` is missing or older than the client sources, then starts the server and opens the browser. Set `BILLTRACKER_OPEN_BROWSER=0` to skip auto-open.

To get an Ubuntu desktop entry, run the bundled installer once:

```bash
npm run install:desktop
```

That resolves the absolute path of the repo, fills in `scripts/Billtracker.desktop.template`, writes it to `~/.local/share/applications/billtracker.desktop`, and refreshes the desktop database. After it completes, "Bill & Credit Tracker" shows up in your application menu and search. To remove it later: `npm run uninstall:desktop`.

The installer is idempotent — re-run it after moving the repo to a new location.

**Windows:**

Double-click `scripts\billtracker.bat` (or run it from a terminal). It performs the same first-run install + build, then starts the server and opens your default browser. Right-click → *Send to* → *Desktop (create shortcut)* to put it on your desktop.

## Mobile (PWA, offline-capable)

The client is a Progressive Web App. Once the laptop server has been served at least once, the app installs to your phone's home screen and runs offline using an in-browser IndexedDB store.

### Architecture

- The PWA shell (HTML/CSS/JS, fonts, icons, service worker) is cached on the phone after the first load.
- On boot the app probes `/api/health`. If the API answers, the app uses the laptop's SQLite database. If not (offline, different LAN, or API loopback-only), it transparently falls back to a per-device IndexedDB store.
- Each device's local store is independent. To move data between devices, use **Settings → Export JSON** on the source device and **Import JSON** on the target.

### Initial install (laptop on the same LAN)

1. On the laptop, start the server bound to the LAN, but keep the unauthenticated API restricted to loopback. Copy `.env.example` to `.env` and set:

   ```
   HOST=0.0.0.0
   BILLTRACKER_ALLOW_NETWORK=1
   BILLTRACKER_HOST_ALLOWLIST=<laptop-lan-ip>:3000
   # Do NOT set BILLTRACKER_API_LAN unless you understand the trade-off.
   ```

   Find your LAN IP with `hostname -I | awk '{print $1}'` (Linux) or check the network panel.

2. Run the launcher (`./scripts/billtracker.sh`) or `npm start`.

3. On the phone, open `http://<laptop-lan-ip>:3000/` in Chrome (Android) or Safari (iOS). The phone loads the static shell + caches it via the service worker. Because the API is loopback-only, the in-app health probe returns 403 and the client switches to local IndexedDB mode (a small **Local** badge appears in the header).

4. Use **Add to Home Screen** in the browser menu to install. From then on the icon launches the app full-screen, even with the laptop powered off.

5. To carry your data over: on the laptop, *Settings → Export JSON*; transfer the file to the phone (e.g. via cloud or messaging); on the phone, *Settings → Import JSON*.

### Why is the API loopback-only by default on LAN?

The API has no authentication. Anyone on your LAN could otherwise wipe or read your data via a single HTTP request. The PWA design avoids that risk by giving every device its own offline store. If you have a single trusted LAN and explicitly want every device to share the laptop's database, set `BILLTRACKER_API_LAN=1` and accept that anyone on that LAN has full read/write access.

### iOS caveats

- iOS 16+ supports installable PWAs and IndexedDB persistence works in standalone mode.
- iOS Safari may evict PWA storage if the app is unused for several weeks. Export your data periodically.
- Older iOS versions or private-browsing tabs may have IndexedDB disabled; the app shows a warning if persistence is unavailable.

## Production deployment (supervisor)

`npm start` starts the process in the foreground and **does not auto-restart on crash**. The server intentionally exits with code `1` on uncaught exceptions / unhandled rejections, expecting a supervisor to bring it back up. For a long-running install, wrap it with `systemd` (or `pm2`, `runit`, `launchd`, etc.).

Minimal systemd unit (`/etc/systemd/system/billtracker.service`):

```ini
[Unit]
Description=Bill & Credit Tracker
After=network.target

[Service]
Type=simple
User=billtracker
WorkingDirectory=/opt/billtracker
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=127.0.0.1
# Uncomment to expose on the LAN (no auth — read the security model first):
# Environment=HOST=0.0.0.0
# Environment=BILLTRACKER_ALLOW_NETWORK=1
# Environment=BILLTRACKER_HOST_ALLOWLIST=billtracker.lan
# Optionally allow LAN clients to talk to /api/* (default keeps it loopback-only):
# Environment=BILLTRACKER_API_LAN=1
StandardOutput=journal
StandardError=journal

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/billtracker/data

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now billtracker
journalctl -u billtracker -f       # follow structured JSON logs
```

The structured logger emits one JSON object per line on stdout, which `journald` ingests cleanly. Use `journalctl -u billtracker -o cat | jq` for ad-hoc queries.

## Data & backups

- Database file: `data/billtracker.db`
- On every server start, a snapshot is copied to `data/backups/billtracker-<timestamp>.db`. The newest 7 backups are retained.
- Use **Settings → Export JSON** to grab a portable backup any time. **Import JSON** replaces the entire database with the file's contents.

## Security model

This app has **no authentication**. The default deployment binds to `127.0.0.1` so only the local user can reach it. The following measures are in place:

- **Loopback by default.** The server *refuses to start* on a non-loopback `HOST` unless you also set `BILLTRACKER_ALLOW_NETWORK=1`, which acknowledges that you are exposing an unauthenticated CRUD API to your network.
- **LAN split.** Even when the server binds to `0.0.0.0`, the unauthenticated `/api/*` routes stay loopback-only by default — phones on the LAN can still load the PWA shell, but the in-app health probe returns 403 and the client falls back to its IndexedDB store. Set `BILLTRACKER_API_LAN=1` only on a trusted LAN where you want every device to share the laptop's database.
- **Host-header allow-list** mitigates DNS-rebinding attacks against `127.0.0.1`. Configure additional names via `BILLTRACKER_HOST_ALLOWLIST=`.
- **Helmet** sets strict security headers including a CSP that disallows inline scripts.
- **Rate limiting**: 300 writes/min/IP globally, plus a stricter 10/5min/IP cap on the destructive `/api/settings/{import,reset,export}` endpoints.
- **All SQL is parameterized** (no string concatenation). Migrations run inside transactions.
- **Optimistic concurrency** via `If-Match` / `ETag` on every mutating endpoint prevents stale tabs from silently overwriting each other.
- **Every request body is validated** against an explicit schema before touching the DB. The `/import` endpoint validates every row up front and aborts before deleting anything if the payload is malformed.
- **Centralized error handler** never leaks stack traces to clients.
- **Structured access logs** with per-request IDs (echoed via `X-Request-Id`) for forensics.
- **Foreign keys enforced**; payment rows cascade on bill/credit delete.
- **All rendered HTML in the client** is built from `escapeHtml`-wrapped values; no inline `onclick` attributes; CSV exports prefix risky cells (`= + - @`) with a single quote to neutralize spreadsheet formula injection.

## Features

**Bills**
- Recurrence: Monthly / Quarterly (with anchor month) / Annually (with due month)
- Per-cycle paid status (so a bill paid in Jun 2026 is independent of Jul 2026)
- Color coded: green=Paid, red=Overdue, yellow=Due in ≤3 days, blue=Upcoming
- Search by name / category / notes
- CSV export

**Credits**
- Two interest models:
  - *Simple*: `Total = P × (1 + r/100 × years)` (annual %)
  - *Monthly add-on*: `Total = P + (P × r/100 × months)` (monthly %)
- Monthly installment = Total / months
- End date auto-derived from start + term, with day-of-month clamped (Jan 31 + 1mo = Feb 28/29)
- Per-month payment log; click to toggle paid/unpaid
- Progress is **payment-based** (paid/total), with secondary time-based readout
- Search, CSV export

**Settings**
- Currency symbol (default ₱)
- Full JSON export/import (with per-row validation on import)
- Reset all data

## Environment variables

See [`.env.example`](./.env.example) for the full list with comments.

- `PORT` — API port (default `3000`)
- `HOST` — bind address (default `127.0.0.1`)
- `BILLTRACKER_ALLOW_NETWORK` — must be `1` if `HOST` is non-loopback (no auth!)
- `BILLTRACKER_HOST_ALLOWLIST` — comma-separated extra Host header values to accept
- `BILLTRACKER_API_LAN` — set to `1` to allow non-loopback clients to call `/api/*` (use on trusted LAN only)
- `BILLTRACKER_LOG_LEVEL` — `debug` / `info` / `warn` / `error` / `silent`
- `BILLTRACKER_DATA_DIR` — override SQLite data directory (used by tests)
- `SHUTDOWN_TIMEOUT_MS` — graceful-shutdown timeout (default `10000`)
- `NODE_ENV` — `production` makes the API also serve the built `dist/`

## Tests

```bash
npm test          # runs the node:test suites under tests/
npm run audit     # runtime-dep vulnerability scan
```

Tests boot an isolated Express app with a fresh temp SQLite database per run via the harness in `tests/helpers/route-harness.js`, so they never touch your real `data/` directory.

## Troubleshooting

- **"API unavailable" on first load:** make sure `npm run dev` (or `npm run dev:server`) is running.
- **`better-sqlite3` install failure:** ensure you have a working C++ toolchain (`build-essential` on Debian/Ubuntu, Xcode CLI on macOS).
- **Port 3000 already in use:** run with `PORT=3100 npm run dev:server`. Update the proxy target in `vite.config.js` if you do.
