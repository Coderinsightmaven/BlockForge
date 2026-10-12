# syntax=docker/dockerfile:1
# BlockForge node agent image: static Go binary on distroless (no shell, no package manager).
# Build context: repository root (Dockerfile.dockerignore admits only services/node-agent)
#   docker build -f infra/containers/node-agent/Dockerfile -t blockforge/node-agent:dev .
ARG GO_IMAGE=golang:1.27

FROM ${GO_IMAGE} AS build
WORKDIR /src
COPY services/node-agent/go.mod services/node-agent/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY services/node-agent/ ./
ARG VERSION=0.1.0
ARG COMMIT=dev
ARG TARGETOS=linux
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath \
      -ldflags "-s -w -X github.com/blockforge/node-agent/internal/version.Version=${VERSION} -X github.com/blockforge/node-agent/internal/version.Commit=${COMMIT}" \
      -o /out/blockforge-agent ./cmd/blockforge-agent \
 && /out/blockforge-agent version

FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.title="blockforge-node-agent" \
      org.opencontainers.image.description="BlockForge node agent (Docker workload driver, telemetry, sandboxed file operations)" \
      org.opencontainers.image.source="services/node-agent"
COPY --from=build /out/blockforge-agent /usr/local/bin/blockforge-agent
# The compose file runs the agent as the workload UID (default 1000) with the Docker socket's group.
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/blockforge-agent"]
CMD ["run"]
