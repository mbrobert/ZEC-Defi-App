#!/bin/bash
# ── Oilskin: one-click live-demo launcher ────────────────────────────────
# Double-click this file (macOS opens it in Terminal), or run: bash start-demo.command
#
# It does everything:
#   1. checks Node is installed
#   2. installs dependencies on first run
#   3. builds the yield service on first run (or after changes)
#   4. loads .env if you have one (OPTIONAL — the demo runs keyless too)
#   5. starts the yield API on http://127.0.0.1:8787
#   6. serves the demo on   http://127.0.0.1:8788 and opens your browser
#
# To shut everything down: double-click stop-demo.command (or Ctrl+C is NOT
# needed — nothing runs in this window after launch).
set -u
cd "$(dirname "$0")" || exit 1

YIELD_PORT_DEFAULT=8787
WEB_PORT=8788
mkdir -p .demo

say()  { printf '\033[1;32m●\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m●\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; echo; echo "Press Enter to close."; read -r; exit 1; }

echo
echo "  OILSKIN — live demo"
echo "  ────────────────────"

# 1 · Node present?
command -v node >/dev/null 2>&1 || die "Node.js isn't installed (or isn't on PATH). Install it from https://nodejs.org (LTS) and run me again."
command -v npm  >/dev/null 2>&1 || die "npm isn't on PATH — it ships with Node.js; reinstall from https://nodejs.org."
say "Node $(node -v)"

# 2 · Dependencies (first run only)
if [ ! -d node_modules ]; then
  say "First run — installing dependencies (one time, ~a minute)…"
  npm install >> .demo/setup.log 2>&1 || die "npm install failed — see .demo/setup.log"
fi

# 3 · Build shared + yield if missing or stale
needs_build() {
  [ ! -f "$2" ] && return 0
  [ -n "$(find "$1" -name '*.ts' -newer "$2" 2>/dev/null | head -1)" ]
}
if needs_build packages/shared/src packages/shared/dist/index.js; then
  say "Building shared package…"
  npm run build -w @zyo/shared >> .demo/setup.log 2>&1 || die "shared build failed — see .demo/setup.log"
fi
if needs_build services/yield/src services/yield/dist/src/index.js; then
  say "Building yield service…"
  npm run build -w @zyo/yield >> .demo/setup.log 2>&1 || die "yield build failed — see .demo/setup.log"
fi

# 4 · Optional .env (Blockscout key etc.) — demo works without it
if [ -f .env ]; then
  set -a; . ./.env; set +a
  say "Loaded .env"
else
  warn "No .env found — that's fine: live rates run keyless. (.env only speeds up backfill.)"
fi
YIELD_PORT="${YIELD_PORT:-$YIELD_PORT_DEFAULT}"

# 5 · Yield API
if curl -sf "http://127.0.0.1:${YIELD_PORT}/healthz" >/dev/null 2>&1; then
  say "Yield API already running on :${YIELD_PORT} — reusing it"
else
  say "Starting yield API on :${YIELD_PORT}…"
  nohup node services/yield/dist/src/index.js > .demo/yield.log 2>&1 &
  echo $! > .demo/yield.pid
  ok=""
  for _ in $(seq 1 45); do
    if curl -sf "http://127.0.0.1:${YIELD_PORT}/healthz" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  [ -n "$ok" ] || die "Yield API didn't come up — see .demo/yield.log"
  say "Yield API is healthy"
fi

# 6 · Static server for the demo page (http:// avoids browser file:// quirks)
if ! curl -sf "http://127.0.0.1:${WEB_PORT}/simple.html" >/dev/null 2>&1; then
  if command -v python3 >/dev/null 2>&1; then
    say "Serving demo on :${WEB_PORT}…"
    nohup python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 --directory prototype > .demo/web.log 2>&1 &
    echo $! > .demo/web.pid
  else
    say "Serving demo on :${WEB_PORT} (via npx http-server)…"
    nohup npx --yes http-server prototype -a 127.0.0.1 -p "$WEB_PORT" -s > .demo/web.log 2>&1 &
    echo $! > .demo/web.pid
  fi
  for _ in $(seq 1 20); do
    curl -sf "http://127.0.0.1:${WEB_PORT}/simple.html" >/dev/null 2>&1 && break
    sleep 1
  done
fi

URL="http://127.0.0.1:${WEB_PORT}/simple.html"
case "$(uname -s)" in
  Darwin) open "$URL" ;;
  *) command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 ;;
esac

echo
say "Demo is up: $URL  (advanced build: http://127.0.0.1:${WEB_PORT}/index.html)"
say "Look for the LIVE chip next to the headline — that's the yield API feeding the page."
warn "Pool cards will say “pending backfill” until you run:  npm run backfill -- all"
warn "(that backfills the engine's on-chain history — takes a while, one time)"
say "To shut down cleanly: double-click stop-demo.command"
echo
