#!/usr/bin/env bash
# Stops the processes started by scripts/dev-up.sh (and the web dev server if .data/web.pid exists).
#
# A recorded pid is only signalled when the process is verifiably this checkout's: control plane = command
# contains src/main.ts and its working directory is <checkout>/apps/control-plane; tunnel = an `ssh … -R …`
# to BF_TUNNEL_HOST; web = vite with a working directory inside the checkout. The whole process tree is
# stopped (process group when the process leads one, else the process and its descendants). A pid file is
# removed only when the process is gone (or was already dead); otherwise it is kept and the exit status is 1.
# Env: BF_CP_PORT (default 8080), BF_TUNNEL_HOST (default game@10.10.10.240). Bash 3.2 compatible.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd -P)"
data="$root/.data"
cp_port="${BF_CP_PORT:-8080}"
tunnel_host="${BF_TUNNEL_HOST:-game@10.10.10.240}"
status=0

alive() { kill -0 "$1" 2>/dev/null; }
cmd_of() { ps -o command= -p "$1" 2>/dev/null; }
cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }
pgid_of() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }

# matches <name> <pid>: the process is this checkout's <name>.
matches() {
  local cmd cwd
  cmd="$(cmd_of "$2")"
  cwd="$(cwd_of "$2")"
  case "$1" in
    control-plane) [[ "$cmd" == *src/main.ts* && "$cwd" == "$root/apps/control-plane" ]] ;;
    tunnel) [[ "$cmd" == ssh\ * && "$cmd" == *" -R "* && "$cmd" == *"$tunnel_host"* ]] ;;
    web) [[ "$cmd" == *vite* && ( "$cwd" == "$root" || "$cwd" == "$root/"* ) ]] ;;
    *) return 1 ;;
  esac
}

descendants() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do
    descendants "$c"
    echo "$c"
  done
}

# wait_gone <pids…>: up to 15 s; 0 when every pid is gone.
wait_gone() {
  local t
  for _ in $(seq 1 30); do
    local left=""
    for t in "$@"; do alive "$t" && left="$left $t"; done
    [[ -z "$left" ]] && return 0
    sleep 0.5
  done
  echo "  still running after SIGTERM:$left" >&2
  return 1
}

# stop_group <pgid>: TERM every member of the process group (the leader may already be gone).
stop_group() {
  local members
  members="$(pgrep -g "$1" 2>/dev/null | tr '\n' ' ')"
  kill -TERM -- "-$1" 2>/dev/null
  # shellcheck disable=SC2086
  wait_gone $members
}

# stop_proc <pid>: TERM the process and its descendants.
stop_proc() {
  local targets
  targets="$(descendants "$1" | tr '\n' ' ')$1"
  # shellcheck disable=SC2086
  kill -TERM $targets 2>/dev/null
  # shellcheck disable=SC2086
  wait_gone $targets
}

# stop_tree <pid>: the whole group when the process leads one (dev-up.sh starts each with set -m), else its tree.
stop_tree() {
  if [[ "$(pgid_of "$1")" == "$1" ]]; then stop_group "$1"; else stop_proc "$1"; fi
}

for name in control-plane tunnel web; do
  f="$data/$name.pid"
  [[ -f "$f" ]] || continue
  pid="$(tr -cd '0-9' <"$f")"
  if [[ -z "$pid" ]] || ! alive "$pid"; then
    echo "$name: recorded pid ${pid:-?} is not running; removed stale $f"
    rm -f "$f"
    continue
  fi
  if ! matches "$name" "$pid"; then
    echo "$name: pid $pid is not this checkout's $name ($(cmd_of "$pid")); not signalled, $f kept" >&2
    status=1
    continue
  fi
  if stop_tree "$pid"; then
    echo "stopped $name ($pid)"
    rm -f "$f"
  else
    echo "$name ($pid) did not stop; $f kept" >&2
    status=1
  fi
done

# A control plane whose recorded pid was lost or stale (e.g. older dev-up.sh versions recorded an intermediate
# shell) still holds the port: stop it only if it is this checkout's control plane.
lpid="$(lsof -t -iTCP:"$cp_port" -sTCP:LISTEN 2>/dev/null | head -1)"
if [[ -n "$lpid" ]] && matches control-plane "$lpid"; then
  # Stop its whole process group (npm exec -> tsx -> node -> esbuild) only if every member runs in this
  # checkout's apps/control-plane; otherwise just the listener and its descendants.
  g="$(pgid_of "$lpid")"
  whole=no
  if [[ -n "$g" ]]; then
    whole=yes
    for m in $(pgrep -g "$g" 2>/dev/null); do
      [[ "$(cwd_of "$m")" == "$root/apps/control-plane" ]] || whole=no
    done
  fi
  if [[ "$whole" == yes ]]; then
    if stop_group "$g"; then echo "stopped orphaned control-plane process group ($g, listener $lpid)"; else status=1; fi
  else
    if stop_proc "$lpid"; then echo "stopped orphaned control-plane process ($lpid)"; else status=1; fi
  fi
fi
exit "$status"
