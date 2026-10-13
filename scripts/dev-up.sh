#!/usr/bin/env bash
# Starts the local control plane and (with --tunnel) the SSH reverse tunnel to the test node as detached
# processes. Logs: .data/control-plane.log, .data/tunnel.log. Stop with: scripts/dev-down.sh
# Shell equivalent of dev-up.ps1. BF_TUNNEL_PORT selects the node-side port (default 18080); the agent's
# control-plane URL must use the same port.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
data="$root/.data"
mkdir -p "$data"
port="${BF_TUNNEL_PORT:-18080}"

export DATABASE_URL="postgres://blockforge:blockforge-dev-only@127.0.0.1:55432/blockforge"
export VICTORIA_METRICS_URL="http://127.0.0.1:58428"
export AGENT_URL="http://127.0.0.1:$port"
export LOG_LEVEL="info"

(cd "$root/apps/control-plane" && nohup npx tsx --conditions=@blockforge/source src/main.ts \
  >"$data/control-plane.log" 2>&1 & echo $! >"$data/control-plane.pid")

if [[ "${1:-}" == "--tunnel" ]]; then
  nohup ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -R "127.0.0.1:$port:127.0.0.1:8080" game@10.10.10.240 >/dev/null 2>"$data/tunnel.log" &
  echo $! >"$data/tunnel.pid"
fi
echo "control plane pid $(cat "$data/control-plane.pid")${1:+, tunnel pid $(cat "$data/tunnel.pid" 2>/dev/null) (node port $port)}"
