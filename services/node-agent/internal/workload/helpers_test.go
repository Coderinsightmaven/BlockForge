package workload

import (
	"testing"

	"github.com/blockforge/node-agent/internal/fsops"
)

func newTestSandbox(t *testing.T) *fsops.Sandbox {
	return &fsops.Sandbox{DataRoot: t.TempDir(), UID: 1000, GID: 1000}
}
