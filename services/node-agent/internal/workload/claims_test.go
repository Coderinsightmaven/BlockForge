package workload

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/blockforge/node-agent/internal/config"
	"github.com/blockforge/node-agent/internal/protocol"
)

// TestEnsureRefusedDuringClaims: workload.ensure must not persist a new spec, create the data
// directory or touch the container while install / restore / backup hold the workload (review:
// agent backups #5). The claim check runs before any Docker call, so no daemon is needed here; the
// integration test TestEnsureVersusClaims covers the same against a real daemon.
func TestEnsureRefusedDuringClaims(t *testing.T) {
	images, err := config.NewImageAllowlist(config.DefaultImageAllowlist)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{ClaimInstall, ClaimRestore, ClaimBackup} {
		t.Run(kind, func(t *testing.T) {
			sb := newTestSandbox(t)
			d := &Driver{o: Options{NodeID: "5e0c2b9a-4d3e-4f5a-9b8c-7d6e5f4a3b2c", Sandbox: sb, Images: images, UID: 1000, GID: 1000},
				ws: map[string]*wstate{}}
			spec := testSpec()
			var release func()
			if kind == ClaimBackup {
				// Backup claims need no container inspection: take it through the real API.
				if release, err = d.Claim(context.Background(), spec.WorkloadID, ClaimBackup); err != nil {
					t.Fatal(err)
				}
			} else {
				w := d.state(spec.WorkloadID)
				w.mu.Lock()
				w.claims = map[string]bool{kind: true}
				w.mu.Unlock()
				release = func() { w.mu.Lock(); delete(w.claims, kind); w.mu.Unlock() }
			}
			defer release()
			// Concurrent ensures all answer BUSY (retryable) and change nothing.
			var wg sync.WaitGroup
			errs := make(chan error, 16)
			for i := 0; i < 16; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					_, err := d.Ensure(context.Background(), spec, nil)
					errs <- err
				}()
			}
			wg.Wait()
			close(errs)
			for err := range errs {
				pe, ok := protocol.AsError(err)
				if !ok || pe.Code != protocol.CodeBusy || !pe.Retryable {
					t.Fatalf("ensure during %s: %v", kind, err)
				}
			}
			if _, err := os.Stat(filepath.Join(sb.WorkloadBase(spec.WorkloadID), "spec.json")); !os.IsNotExist(err) {
				t.Fatal("spec persisted during an exclusive operation")
			}
			if _, err := os.Stat(sb.DataDir(spec.WorkloadID)); !os.IsNotExist(err) {
				t.Fatal("data directory created during an exclusive operation")
			}
		})
	}
}
