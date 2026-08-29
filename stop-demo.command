#!/bin/bash
# ── Oilskin: demo shutdown ───────────────────────────────────────────────
# Double-click to stop everything start-demo.command launched.
# Safe to run any time — it only touches the two demo ports (8787, 8788)
# and the PID files under .demo/. Nothing else on your machine is affected.
set -u
cd "$(dirname "$0")" || exit 1

say()  { printf '\033[1;32m●\033[0m %s\n' "$*"; }

stopped=0

# 1 · PID files first (clean SIGTERM — the yield API handles it gracefully)
for name in yield web; do
  f=".demo/${name}.pid"
  if [ -f "$f" ]; then
    pid="$(cat "$f" 2>/dev/null)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && { say "Stopped ${name} (pid $pid)"; stopped=1; }
    fi
    rm -f "$f"
  fi
done

# 2 · Port sweep fallback (in case a process was started outside the pid files)
for port in "${YIELD_PORT:-8787}" 8788; do
  pids="$(lsof -ti tcp:"$port" 2>/dev/null)"
  if [ -n "$pids" ]; then
    for pid in $pids; do
      cmd="$(ps -o comm= -p "$pid" 2>/dev/null)"
      kill "$pid" 2>/dev/null && { say "Freed port $port (pid $pid, $cmd)"; stopped=1; }
    done
  fi
done

sleep 1
# 3 · Anything stubborn gets SIGKILL
for port in "${YIELD_PORT:-8787}" 8788; do
  pids="$(lsof -ti tcp:"$port" 2>/dev/null)"
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
done

if [ "$stopped" = 1 ]; then
  say "Demo is shut down. Logs kept in .demo/ if you want them; safe to delete."
else
  say "Nothing was running — already shut down."
fi
echo
