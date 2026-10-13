#!/usr/bin/env bash
# Stops the processes started by scripts/dev-up.sh (and the web dev server if .data/web.pid exists).
root="$(cd "$(dirname "$0")/.." && pwd)"
for name in control-plane tunnel web; do
  f="$root/.data/$name.pid"
  [[ -f "$f" ]] || continue
  id="$(cat "$f")"
  # npx/tsx start child node processes: stop the children first, then the parent.
  pkill -TERM -P "$id" 2>/dev/null
  kill -TERM "$id" 2>/dev/null && echo "stopped $name ($id)"
  rm -f "$f"
done
# A control-plane node process orphaned by its npx parent still holds :8080; stop it if it is ours.
if pid="$(lsof -t -iTCP:8080 -sTCP:LISTEN 2>/dev/null | head -1)" && [[ -n "$pid" ]]; then
  if ps -o command= -p "$pid" | grep -q "src/main.ts"; then
    kill -TERM "$pid" && echo "stopped orphaned control-plane process ($pid)"
  fi
fi
