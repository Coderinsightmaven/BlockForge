#!/usr/bin/env bash
# Serialises pnpm invocations across concurrently working agents (mkdir is atomic).
set -euo pipefail
LOCK="$(cd "$(dirname "$0")/.." && pwd)/.pnpm.lock.d"
for i in $(seq 1 600); do
  if mkdir "$LOCK" 2>/dev/null; then trap 'rmdir "$LOCK"' EXIT; exec_rc=0; pnpm "$@" || exec_rc=$?; exit $exec_rc; fi
  sleep 1
done
echo "timed out waiting for $LOCK" >&2; exit 1
