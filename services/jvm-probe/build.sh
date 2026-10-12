#!/usr/bin/env bash
# Reproducible build of the BlockForge JVM probe inside eclipse-temurin:21-jdk.
#   - javac --release 8   → runs on Java 8 … 25+
#   - jar --date fixed    → byte-identical jar for identical sources and JDK
# Output: services/node-agent/internal/jvmprobe/jvm-probe.jar (+ .sha256), embedded by the agent.
set -euo pipefail
export MSYS_NO_PATHCONV=1
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../node-agent/internal/jvmprobe"
JDK_IMAGE="${JDK_IMAGE:-eclipse-temurin:21-jdk}"
src="$here"; dst="$out"
if command -v cygpath >/dev/null 2>&1; then src="$(cygpath -w "$here")"; dst="$(cygpath -w "$out")"; fi
docker run --rm -v "$src:/src:ro" -v "$dst:/out" -w /tmp "$JDK_IMAGE" sh -euc '
  mkdir -p classes
  javac --release 8 -nowarn -encoding UTF-8 -d classes $(find /src/src -name "*.java" | sort)
  find classes -exec touch -d "1980-01-01T00:00:02Z" {} +
  jar --create --file /out/jvm-probe.jar --manifest /src/MANIFEST.MF --date=1980-01-01T00:00:02Z -C classes .
  java -version 2>&1 | head -1
'
( cd "$out" && sha256sum jvm-probe.jar > jvm-probe.jar.sha256 && cat jvm-probe.jar.sha256 )
echo "JDK image: $(docker image inspect --format '{{index .RepoDigests 0}}' "$JDK_IMAGE" 2>/dev/null || echo "$JDK_IMAGE")"
