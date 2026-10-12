#!/usr/bin/env bash
# Runs the Go test suite inside a Linux container (the agent's production OS) with the repo
# mounted read-only. Usage: scripts/test-linux.sh [go test args...]   e.g. -tags integration ./...
#
# Integration tests need the Docker socket and a data root whose path is identical inside and
# outside the test container (bind sources resolve on the Docker daemon host).
set -euo pipefail
export MSYS_NO_PATHCONV=1
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then repo="$(cygpath -w "$repo")"; fi
IT_ROOT="${BF_IT_DATA_ROOT:-/var/lib/blockforge-it}"
GO_IMAGE="${GO_IMAGE:-golang:1.27}"
args=("$@")
[ ${#args[@]} -eq 0 ] && args=(./...)
exec docker run --rm --network host \
  -v "$repo:/repo:ro" \
  -v bf-gomod:/go/pkg/mod -v bf-gocache:/root/.cache/go-build \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$IT_ROOT:$IT_ROOT" \
  -e BF_IT_DATA_ROOT="$IT_ROOT" -e BF_IT_PAPER -e BF_IT_PAPER_VERSION -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local \
  -w /repo/services/node-agent \
  "$GO_IMAGE" go test "${args[@]}"
