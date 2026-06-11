@echo off
REM Bill & Credit Tracker launcher (Windows).
REM
REM Behaviour:
REM   1. cd into the repo (the script's parent directory).
REM   2. If node_modules is missing, run `npm install`.
REM   3. If dist\index.html is missing, run `npm run build`.
REM   4. Start `npm start` and open http://localhost:<PORT> in the default browser.
REM
REM Configure via environment variables (set before running):
REM   PORT     API + UI port (default 3000)
REM   HOST     Bind address (default 127.0.0.1)
REM
REM Usage:
REM   double-click this file, or run `scripts\billtracker.bat` from a terminal.
REM
REM Requires Node.js 20.19+ on PATH (https://nodejs.org/).

setlocal EnableExtensions EnableDelayedExpansion

REM Resolve repo root (script lives in repo\scripts\).
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.." >nul
set "REPO_DIR=%CD%"

if "%PORT%"=="" set "PORT=3000"
if "%HOST%"=="" set "HOST=127.0.0.1"
if "%BILLTRACKER_OPEN_BROWSER%"=="" set "BILLTRACKER_OPEN_BROWSER=1"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: 'node' not found in PATH.
  echo Install Node.js 20.19+ from https://nodejs.org/
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: 'npm' not found in PATH.
  pause
  exit /b 1
)

if not exist "node_modules\.package-lock.json" (
  echo [billtracker] Installing dependencies (this only happens the first time^)...
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo [billtracker] Building client...
  call npm run build
  if errorlevel 1 (
    echo ERROR: build failed.
    pause
    exit /b 1
  )
)

REM Open the browser ~2s after the server starts (best-effort).
if "%BILLTRACKER_OPEN_BROWSER%"=="1" (
  start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://%HOST%:%PORT%/"
)

set "NODE_ENV=production"
echo [billtracker] Starting on http://%HOST%:%PORT%  (Ctrl+C to stop)
call npm start

popd >nul
endlocal
