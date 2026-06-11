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
├── client/              # Frontend
│   ├── index.html       # Lean shell
│   ├── styles/          # main / components / responsive
│   └── src/
│       ├── main.js          # Bootstrap + tab routing
│       ├── api.js           # Fetch wrapper (sends If-Match for writes)
│       ├── state.js         # In-memory cache + pub/sub
│       ├── format.js        # Money/date helpers, escapeHtml, CSV (with formula-injection guard)
│       ├── cycle.js         # Bill cycle logic (Monthly/Quarterly/Annually)
│       ├── credit-math.js   # Simple + monthly add-on interest
│       ├── modules/         # dashboard / bills / credits / settings
│       └── ui/              # modal / toast / confirm
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

## Data & backups

- Database file: `data/billtracker.db`
- On every server start, a snapshot is copied to `data/backups/billtracker-<timestamp>.db`. The newest 7 backups are retained.
- Use **Settings → Export JSON** to grab a portable backup any time. **Import JSON** replaces the entire database with the file's contents.

## Security model

This app has **no authentication**. The default deployment binds to `127.0.0.1` so only the local user can reach it. The following measures are in place:

- **Loopback by default.** The server *refuses to start* on a non-loopback `HOST` unless you also set `BILLTRACKER_ALLOW_NETWORK=1`, which acknowledges that you are exposing an unauthenticated CRUD API to your network.
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
