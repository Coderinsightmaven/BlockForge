//go:build integration && linux

package workload

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/moby/moby/client"

	"github.com/blockforge/node-agent/internal/protocol"
)

func ownerOf(t *testing.T, p string) (uint32, uint32) {
	t.Helper()
	fi, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	st := fi.Sys().(*syscall.Stat_t)
	return st.Uid, st.Gid
}

func (e *itEnv) install(id, script string, timeout time.Duration) (*protocol.WorkloadInstallResult, error) {
	return e.d.Install(context.Background(), &protocol.WorkloadInstallPayload{
		WorkloadID: id, Image: testImage, Entrypoint: "sh", Script: script, Env: map[string]string{"SERVER_JARFILE": "server.jar", "lower_key": "ok"},
		MemoryLimitBytes: 256 << 20, TimeoutMs: timeout.Milliseconds(),
	}, nil)
}

func TestInstallContainer(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id := newUUID()
	defer e.d.Remove(ctx, id, true)
	if _, err := e.d.Ensure(ctx, e.spec(id), nil); err != nil {
		t.Fatal(err)
	}
	data := e.sb.DataDir(id)

	// Success: runs as root with exactly the 5 capabilities and no-new-privileges, CRLF script
	// normalised, env passed, data chowned back to the workload user.
	script := "#!/bin/sh\r\necho installing as $(id -u)\r\ngrep -E '^(CapEff|NoNewPrivs):' /proc/self/status\r\n" +
		"echo \"jar=$SERVER_JARFILE lower=$lower_key\"\r\nmkdir -p /mnt/server/sub && echo data > /mnt/server/sub/f.txt\r\n" +
		"touch /mnt/install/tamper 2>/dev/null && echo SCRIPT_DIR_WRITABLE || echo script dir read-only\r\nexit 0\r\n"
	res, err := e.install(id, script, 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	tail := strings.Join(res.LogTail, "\n")
	t.Logf("install result: exit=%d duration=%dms timedOut=%v\n%s", res.ExitCode, res.DurationMs, res.TimedOut, tail)
	if res.ExitCode != 0 || res.TimedOut || res.DurationMs <= 0 {
		t.Fatalf("result %+v", res)
	}
	for _, want := range []string{"installing as 0", "CapEff:\t00000000000000cb", "NoNewPrivs:\t1", "jar=server.jar lower=ok", "script dir read-only"} {
		if !strings.Contains(tail, want) {
			t.Fatalf("log tail lacks %q", want)
		}
	}
	for _, p := range []string{filepath.Join(data, "sub"), filepath.Join(data, "sub", "f.txt")} {
		if uid, gid := ownerOf(t, p); uid != 1000 || gid != 1000 {
			t.Fatalf("%s owned by %d:%d after install", p, uid, gid)
		}
	}
	if lines, ok := e.logs.TailSource(id, protocol.LogSourceInstall, 100, -1); !ok || len(lines) == 0 {
		t.Fatal("install output not streamed as source=install")
	}
	if lines, _ := e.logs.Tail(id, 100, -1); len(lines) != 0 {
		t.Fatal("install output leaked into the workload log stream")
	}
	if _, err := e.cli.ContainerInspect(ctx, InstallContainerName(id), client.ContainerInspectOptions{}); err == nil {
		t.Fatal("install container not removed")
	}
	if st, _ := e.d.Status(ctx, id); st.State != protocol.StateCreated {
		t.Fatalf("install changed the workload state: %+v", st)
	}

	// Failure: exit code reported, ownership still fixed.
	res, err = e.install(id, "touch /mnt/server/failed-root-file\necho failing >&2\nexit 7\n", time.Minute)
	if err != nil || res.ExitCode != 7 || res.TimedOut {
		t.Fatalf("failing script: %v %+v", err, res)
	}
	if uid, _ := ownerOf(t, filepath.Join(data, "failed-root-file")); uid != 1000 {
		t.Fatal("ownership not fixed after a failed script")
	}

	// Timeout: killed, reported, ownership fixed by the follow-up container.
	res, err = e.install(id, "touch /mnt/server/slow-root-file\necho sleeping\nsleep 600\n", 3*time.Second)
	if err != nil || !res.TimedOut || res.ExitCode != 137 {
		t.Fatalf("timeout: %v %+v", err, res)
	}
	if uid, _ := ownerOf(t, filepath.Join(data, "slow-root-file")); uid != 1000 {
		t.Fatal("ownership not fixed after a timeout")
	}

	// Concurrent install → BUSY; start during install → BUSY.
	var wg sync.WaitGroup
	var concurrent *protocol.WorkloadInstallResult
	wg.Add(1)
	go func() {
		defer wg.Done()
		concurrent, _ = e.install(id, "sleep 4\necho survived\n", time.Minute)
	}()
	time.Sleep(1500 * time.Millisecond)
	// Another agent on the same Docker daemon starting up must not reap this agent's install.
	other, err := NewDriver(Options{NodeID: "99999999-9999-4999-8999-999999999999", DataRoot: e.d.o.DataRoot, UID: 1000, GID: 1000,
		Images: e.d.o.Images, Sandbox: e.sb, Logs: e.logs, Logger: e.d.o.Logger})
	if err != nil {
		t.Fatal(err)
	}
	other.cleanupStaleInstalls(ctx)
	if _, err := e.install(id, "echo second\n", time.Minute); errCode(err) != protocol.CodeBusy {
		t.Fatalf("second install: %v", err)
	}
	if _, err := e.d.Start(ctx, id); errCode(err) != protocol.CodeBusy {
		t.Fatalf("start during install: %v", err)
	}
	wg.Wait()
	if concurrent == nil || concurrent.ExitCode != 0 || !strings.Contains(strings.Join(concurrent.LogTail, "\n"), "survived") {
		t.Fatalf("install was disturbed by another agent's start-up cleanup: %+v", concurrent)
	}

	// Running workload → BUSY; disallowed image → IMAGE_NOT_ALLOWED.
	if _, err := e.d.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	e.waitState(id, protocol.StateRunning, 10*time.Second)
	if _, err := e.install(id, "echo x\n", time.Minute); errCode(err) != protocol.CodeBusy {
		t.Fatalf("install while running: %v", err)
	}
	e.d.Kill(ctx, id)
	if _, err := e.d.Install(ctx, &protocol.WorkloadInstallPayload{WorkloadID: id, Image: "busybox:latest", Entrypoint: "sh",
		MemoryLimitBytes: 256 << 20, TimeoutMs: 60000}, nil); errCode(err) != protocol.CodeImageNotAllowed {
		t.Fatalf("image allowlist: %v", err)
	}
	// Install containers never drive workload events or the restart policy.
	e.mu.Lock()
	for _, ev := range e.events {
		if strings.Contains(ev, "agent.warning") {
			t.Fatalf("unexpected warning event: %v", e.events)
		}
	}
	e.mu.Unlock()
}

// Claims: restore/install need a stopped workload and block start; backup runs next to a running
// server but is exclusive with other claims and blocks remove; backups survive workload.remove.
func TestWorkloadClaims(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id := newUUID()
	defer e.d.Remove(ctx, id, true)
	if _, err := e.d.Ensure(ctx, e.spec(id), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	e.waitState(id, protocol.StateRunning, 10*time.Second)
	if _, err := e.d.Claim(ctx, id, ClaimRestore); errCode(err) != protocol.CodeBusy {
		t.Fatalf("restore while running: %v", err)
	}
	rel, err := e.d.Claim(ctx, id, ClaimBackup)
	if err != nil {
		t.Fatalf("backup next to a running server: %v", err)
	}
	if _, err := e.d.Claim(ctx, id, ClaimBackup); errCode(err) != protocol.CodeBusy {
		t.Fatalf("second backup: %v", err)
	}
	if err := e.d.Remove(ctx, id, true); errCode(err) != protocol.CodeBusy {
		t.Fatalf("remove during backup: %v", err)
	}
	rel()
	e.d.Kill(ctx, id)
	rel, err = e.d.Claim(ctx, id, ClaimRestore)
	if err != nil {
		t.Fatalf("restore on a stopped workload: %v", err)
	}
	if _, err := e.d.Start(ctx, id); errCode(err) != protocol.CodeBusy {
		t.Fatalf("start during restore: %v", err)
	}
	if _, err := e.install(id, "echo x\n", time.Minute); errCode(err) != protocol.CodeBusy {
		t.Fatalf("install during restore: %v", err)
	}
	rel()
	if _, err := e.d.Start(ctx, id); err != nil {
		t.Fatalf("start after restore: %v", err)
	}
	e.d.Kill(ctx, id)
	// workload.remove(deleteData) never deletes <dataRoot>/backups/<id>.
	bdir := filepath.Join(e.d.o.DataRoot, "backups", id)
	os.MkdirAll(bdir, 0o700)
	os.WriteFile(filepath.Join(bdir, "b.tar.gz"), []byte("archive"), 0o600)
	if err := e.d.Remove(ctx, id, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(bdir, "b.tar.gz")); err != nil {
		t.Fatal("workload.remove deleted the workload's backups")
	}
	if _, err := os.Stat(e.sb.WorkloadBase(id)); !os.IsNotExist(err) {
		t.Fatal("workload data not removed")
	}
}

// TestEnsureVersusClaims: workload.ensure answers BUSY while install / restore / backup hold the
// workload and leaves the persisted spec and the container alone; it works again afterwards
// (review: agent backups #5). The install case races a real install container.
func TestEnsureVersusClaims(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id := newUUID()
	defer e.d.Remove(ctx, id, true)
	if _, err := e.d.Ensure(ctx, e.spec(id), nil); err != nil {
		t.Fatal(err)
	}
	specPath := filepath.Join(e.sb.WorkloadBase(id), "spec.json")
	containerID := func() string {
		c, err := e.d.inspectManaged(ctx, id)
		if err != nil || c == nil {
			t.Fatalf("inspect: %v", err)
		}
		return c.ID
	}
	changed := e.spec(id)
	changed.Env = map[string]string{"TZ": "UTC", "CHANGED": "1"}
	expectBusy := func(what string) {
		t.Helper()
		before, _ := os.ReadFile(specPath)
		cid := containerID()
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := e.d.Ensure(ctx, changed, nil); errCode(err) != protocol.CodeBusy {
					t.Errorf("ensure during %s: %v", what, err)
				}
			}()
		}
		wg.Wait()
		if after, _ := os.ReadFile(specPath); string(after) != string(before) {
			t.Fatalf("spec rewritten during %s", what)
		}
		if containerID() != cid {
			t.Fatalf("container replaced during %s", what)
		}
	}
	// Restore (workload stopped).
	rel, err := e.d.Claim(ctx, id, ClaimRestore)
	if err != nil {
		t.Fatal(err)
	}
	expectBusy("restore")
	rel()
	// Backup.
	rel, err = e.d.Claim(ctx, id, ClaimBackup)
	if err != nil {
		t.Fatal(err)
	}
	expectBusy("backup")
	rel()
	// A real install in flight.
	done := make(chan error, 1)
	go func() {
		_, err := e.install(id, "sleep 4\n", time.Minute)
		done <- err
	}()
	deadline := time.Now().Add(30 * time.Second)
	for e.d.claimed(id, ClaimInstall) == "" {
		if time.Now().After(deadline) {
			t.Fatal("install never claimed the workload")
		}
		time.Sleep(20 * time.Millisecond)
	}
	expectBusy("install")
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	res, err := e.d.Ensure(ctx, changed, nil)
	if err != nil || !res.Changed {
		t.Fatalf("ensure after the claims: %+v %v", res, err)
	}
}
