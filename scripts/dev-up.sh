#!/usr/bin/env bash
# Starts the local control plane and (with --tunnel) the SSH reverse tunnel to the test node as detached
# processes. Logs: .data/control-plane.log, .data/tunnel.log. Stop with: scripts/dev-down.sh
# Shell equivalent of dev-up.ps1 (bash 3.2 compatible).
#
# Env: BF_TUNNEL_PORT  node-side tunnel port (default 18081; the agent's control-plane URL must use the same
#                      port — the Windows workstation may still hold 18080 on the node)
#      BF_TUNNEL_HOST  ssh destination (default game@10.10.10.240)
#      BF_CP_PORT      control-plane listen port (default 8080)
#
# Each process is started as the leader of its own process group (set -m) and its own pid is recorded, so
# dev-down.sh can stop the whole tree (npm exec -> tsx -> node). Refuses to start over a live recorded process
# or an occupied port, and waits until the control plane accepts connections.
set -euo pipefail
usage() { echo "usage: $0 [--tunnel]" >&2; exit 2; }
tunnel=0
case "${1:-}" in
  "") ;;
  --tunnel) tunnel=1 ;;
  *) usage ;;
esac
[[ $# -le 1 ]] || usage

root="$(cd "$(dirname "$0")/.." && pwd -P)"
data="$root/.data"
mkdir -p "$data"
tunnel_port="${BF_TUNNEL_PORT:-18081}"
tunnel_host="${BF_TUNNEL_HOST:-game@10.10.10.240}"
cp_port="${BF_CP_PORT:-8080}"

alive() { kill -0 "$1" 2>/dev/null; }
listening() { lsof -t -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# Refuse to start over a live recorded process; drop stale pid files.
check_pidfile() {
  local f="$data/$1.pid" pid
  [[ -f "$f" ]] || return 0
  pid="$(tr -cd '0-9' <"$f")"
  if [[ -n "$pid" ]] && alive "$pid"; then
    echo "$1 already running (pid $pid, $f); stop it with scripts/dev-down.sh first" >&2
    exit 1
  fi
  rm -f "$f"
}
check_pidfile control-plane
[[ $tunnel -eq 1 ]] && check_pidfile tunnel
if listening "$cp_port"; then
  echo "port $cp_port is already in use (pid $(lsof -t -iTCP:"$cp_port" -sTCP:LISTEN | head -1)); not starting" >&2
  exit 1
fi

export DATABASE_URL="postgres://blockforge:blockforge-dev-only@127.0.0.1:55432/blockforge"
export VICTORIA_METRICS_URL="http://127.0.0.1:58428"
export AGENT_URL="http://127.0.0.1:$tunnel_port"
export LOG_LEVEL="info"
export LISTEN_PORT="$cp_port"

set -m # background jobs get their own process group (pgid = pid)

cd "$root/apps/control-plane"
nohup npx tsx --conditions=@blockforge/source src/main.ts >"$data/control-plane.log" 2>&1 &
cp_pid=$!
cd "$root"
echo "$cp_pid" >"$data/control-plane.pid"

# Wait until the control plane listens, it exits, or it logs a fatal error.
for _ in $(seq 1 120); do
  if ! alive "$cp_pid"; then
    echo "control plane exited during start-up; last log lines:" >&2
    tail -n 20 "$data/control-plane.log" >&2
    kill -TERM -- "-$cp_pid" 2>/dev/null || true # leftovers of its process group
    rm -f "$data/control-plane.pid"
    exit 1
  fi
  if grep -q '"level":60' "$data/control-plane.log" 2>/dev/null; then
    echo "control plane logged a fatal error (pid $cp_pid still recorded; stop it with scripts/dev-down.sh):" >&2
    grep '"level":60' "$data/control-plane.log" | tail -n 5 >&2
    exit 1
  fi
  listening "$cp_port" && break
  sleep 0.5
done
if ! listening "$cp_port"; then
  echo "control plane (pid $cp_pid) is not listening on :$cp_port after 60 s; see $data/control-plane.log" >&2
  exit 1
fi
msg="control plane pid $cp_pid listening on 127.0.0.1:$cp_port"

if [[ $tunnel -eq 1 ]]; then
  nohup ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -R "127.0.0.1:$tunnel_port:127.0.0.1:$cp_port" "$tunnel_host" >/dev/null 2>"$data/tunnel.log" &
  tunnel_pid=$!
  echo "$tunnel_pid" >"$data/tunnel.pid"
  sleep 3 # ExitOnForwardFailure: a refused forward ends ssh within a moment
  if ! alive "$tunnel_pid"; then
    echo "tunnel exited (port $tunnel_port taken on the node, or ssh failed); $data/tunnel.log:" >&2
    cat "$data/tunnel.log" >&2
    rm -f "$data/tunnel.pid"
    echo "control plane (pid $cp_pid) keeps running; stop it with scripts/dev-down.sh" >&2
    exit 1
  fi
  msg="$msg, tunnel pid $tunnel_pid (node 127.0.0.1:$tunnel_port -> :$cp_port)"
fi
echo "$msg"
