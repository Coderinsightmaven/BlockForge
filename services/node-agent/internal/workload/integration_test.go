//go:build integration && linux

// Integration tests against a real Docker engine. Run inside a Linux container whose data root
// path is identical on the Docker host (see scripts/test-linux.sh):
//
//	BF_IT_DATA_ROOT=/var/lib/blockforge-it scripts/test-linux.sh -tags integration ./internal/workload/
package workload

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	"github.com/blockforge/node-agent/internal/config"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/jvmprobe"
	"github.com/blockforge/node-agent/internal/logs"
	"github.com/blockforge/node-agent/internal/protocol"
)

const testImage = "alpine:3.22"

// itNodeID is the node id the integration drivers run as.
const itNodeID = "6f1c2b9a-4d3e-4f5a-9b8c-7d6e5f4a3b2c"

// The workload script runs inside the container (the agent itself never spawns a shell).
const script = `echo READY uid=$(id -u) gid=$(id -g); echo hello > /data/fromcontainer; ` +
	`(touch /rootfs-probe 2>/dev/null && echo ROOTFS_WRITABLE) || echo ROOTFS_READONLY; ` +
	`while read line; do echo "got:$line"; ` +
	`if [ "$line" = stop ]; then echo bye; exit 0; fi; ` +
	`if [ "$line" = crash ]; then echo crashing >&2; exit 3; fi; done`

type itEnv struct {
	t       *testing.T
	d       *Driver
	cli     *client.Client
	sb      *fsops.Sandbox
	logs    *logs.Manager
	mu      sync.Mutex
	events  []string
	cancel  context.CancelFunc
	netName string
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func newUUID() string {
	h := randHex(16)
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-8" + h[17:20] + "-" + h[20:32]
}

func setup(t *testing.T) *itEnv {
	root := os.Getenv("BF_IT_DATA_ROOT")
	if root == "" {
		t.Skip("BF_IT_DATA_ROOT not set (run via scripts/test-linux.sh -tags integration)")
	}
	dataRoot := filepath.Join(root, "drv-"+randHex(4))
	if err := os.MkdirAll(filepath.Join(dataRoot, "servers"), 0o755); err != nil {
		t.Fatal(err)
	}
	images, _ := config.NewImageAllowlist([]string{"eclipse-temurin:*", testImage})
	sb := fsops.NewSandbox(dataRoot, 1000, 1000)
	e := &itEnv{t: t, sb: sb, netName: "bf-it-" + randHex(4)}
	e.logs = logs.NewManager(func(protocol.LogsFrame) {})
	d, err := NewDriver(Options{NodeID: itNodeID, DataRoot: dataRoot, UID: 1000, GID: 1000, Images: images, Sandbox: sb, Logs: e.logs,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), ProbeJar: jvmprobe.Jar(),
		Emit: func(ev string, data any) {
			e.mu.Lock()
			defer e.mu.Unlock()
			if st, ok := data.(protocol.WorkloadStatus); ok {
				e.events = append(e.events, ev+":"+st.State)
			} else {
				e.events = append(e.events, ev)
			}
		}})
	if err != nil {
		t.Fatal(err)
	}
	e.d, e.cli = d, d.Client()
	ctx, cancel := context.WithCancel(context.Background())
	e.cancel = cancel
	go d.Run(ctx)
	if _, err := e.cli.ImageInspect(ctx, testImage); err != nil {
		resp, err := e.cli.ImagePull(ctx, testImage, client.ImagePullOptions{})
		if err != nil {
			t.Fatal(err)
		}
		resp.Wait(ctx)
	}
	t.Cleanup(func() {
		cancel()
		e.cli.NetworkRemove(context.Background(), e.netName, client.NetworkRemoveOptions{})
		os.RemoveAll(dataRoot)
	})
	return e
}

func (e *itEnv) spec(id string) *protocol.WorkloadSpec {
	cpu := int64(500)
	stop := "stop"
	return &protocol.WorkloadSpec{
		WorkloadID: id, Kind: "minecraft", Image: testImage, Command: []string{"sh", "-c", script},
		Env: map[string]string{"TZ": "UTC"}, MemoryLimitBytes: 128 << 20, CPULimitMillicores: &cpu, PidsLimit: 64,
		Ports: []protocol.PortBinding{}, Networks: []protocol.WorkloadNetwork{{Name: e.netName, Aliases: []string{"it"}}},
		StopCommand: &stop, StopTimeoutMs: 10000,
		RestartPolicy: protocol.RestartPolicy{Mode: "on-failure", MaxRetries: 2, BackoffMs: 1000},
		JvmProbe:      false, Labels: map[string]string{"io.blockforge.test": "1"},
	}
}

func (e *itEnv) waitLog(id, needle string, d time.Duration) {
	e.t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if lines, ok := e.logs.Tail(id, 5000, -1); ok {
			for _, l := range lines {
				if strings.Contains(l.Line, needle) {
					return
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	lines, _ := e.logs.Tail(id, 50, -1)
	e.t.Fatalf("log line %q not seen; last lines: %+v", needle, lines)
}

func (e *itEnv) waitState(id, state string, d time.Duration) protocol.WorkloadStatus {
	e.t.Helper()
	deadline := time.Now().Add(d)
	var st protocol.WorkloadStatus
	for time.Now().Before(deadline) {
		st, _ = e.d.Status(context.Background(), id)
		if st.State == state {
			return st
		}
		time.Sleep(100 * time.Millisecond)
	}
	e.t.Fatalf("state %q not reached; last %+v", state, st)
	return st
}

func TestDockerWorkloadLifecycle(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id := newUUID()
	defer e.d.Remove(ctx, id, true)

	res, err := e.d.Ensure(ctx, e.spec(id), nil)
	if err != nil || !res.Created || res.Status.State != protocol.StateCreated {
		t.Fatalf("ensure: %v %+v", err, res)
	}
	res2, err := e.d.Ensure(ctx, e.spec(id), nil)
	if err != nil || res2.Created || res2.Changed || res2.Status.ContainerID != res.Status.ContainerID {
		t.Fatalf("ensure idempotent: %v %+v", err, res2)
	}

	// Hardening actually applied on the engine side.
	ins, err := e.cli.ContainerInspect(ctx, ContainerName(id), client.ContainerInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	c, hc := ins.Container.Config, ins.Container.HostConfig
	if c.User != "1000:1000" || !hc.ReadonlyRootfs || hc.Privileged || hc.NetworkMode.IsHost() ||
		len(hc.CapDrop) != 1 || hc.CapDrop[0] != "ALL" || len(hc.CapAdd) != 0 ||
		*hc.PidsLimit != 64 || hc.Memory != 128<<20 || hc.MemorySwap != 128<<20 || hc.NanoCPUs != 500_000_000 ||
		hc.RestartPolicy.Name != container.RestartPolicyDisabled || c.WorkingDir != "/data" || !c.OpenStdin || c.Tty {
		t.Fatalf("hardening not applied: config=%+v host=%+v", c, hc)
	}
	nnp := false
	for _, o := range hc.SecurityOpt {
		if strings.HasPrefix(o, "no-new-privileges") {
			nnp = true
		}
	}
	if !nnp || c.Labels[LabelManaged] != "true" || c.Labels[LabelWatchtower] != "false" || string(hc.NetworkMode) != e.netName {
		t.Fatalf("security opts / labels: %v %v %v", hc.SecurityOpt, c.Labels, hc.NetworkMode)
	}
	if ni, err := e.cli.NetworkInspect(ctx, e.netName, client.NetworkInspectOptions{}); err != nil ||
		ni.Network.Labels[LabelManaged] != "true" || ni.Network.Labels[LabelNode] != itNodeID || ni.Network.Driver != "bridge" {
		t.Fatalf("agent-created network labels: %v %+v", err, ni.Network.Labels)
	}
	if _, ok := hc.Tmpfs["/tmp"]; !ok {
		t.Fatal("no tmpfs /tmp")
	}
	for _, m := range ins.Container.Mounts {
		if strings.Contains(m.Source, "docker.sock") {
			t.Fatal("docker socket mounted into workload")
		}
	}

	// Data directory ownership (agent runs as root in the test container → chown to 1000:1000).
	if runtime.GOOS == "linux" && os.Geteuid() == 0 {
		fi, err := os.Stat(e.sb.DataDir(id))
		if err != nil {
			t.Fatal(err)
		}
		if st := fi.Sys().(*syscall.Stat_t); st.Uid != 1000 || st.Gid != 1000 {
			t.Fatalf("data dir owned by %d:%d", st.Uid, st.Gid)
		}
	}

	st, err := e.d.Start(ctx, id)
	if err != nil || st.State != protocol.StateRunning {
		t.Fatalf("start: %v %+v", err, st)
	}
	e.waitLog(id, "READY uid=1000 gid=1000", 15*time.Second)
	e.waitLog(id, "ROOTFS_READONLY", 5*time.Second)
	if fi, err := os.Stat(filepath.Join(e.sb.DataDir(id), "fromcontainer")); err != nil {
		t.Fatalf("container could not write /data: %v", err)
	} else if st := fi.Sys().(*syscall.Stat_t); st.Uid != 1000 {
		t.Fatalf("file written by workload owned by %d", st.Uid)
	}

	// Console → stdin.
	if err := e.d.Console(ctx, id, "hello world"); err != nil {
		t.Fatal(err)
	}
	e.waitLog(id, "got:hello world", 10*time.Second)
	if err := e.d.Console(ctx, id, "two"); err != nil {
		t.Fatal(err)
	}
	e.waitLog(id, "got:two", 10*time.Second)

	// Stats.
	ri, _ := e.d.Running(ctx)
	found := false
	for _, r := range ri {
		if r.WorkloadID == id {
			found = true
			if r.IPs[e.netName] == "" {
				t.Fatalf("no IP on %s: %+v", e.netName, r.IPs)
			}
			s, err := e.d.Stats(ctx, r.ContainerID)
			if err != nil || s.MemoryStats.Usage == 0 || s.PidsStats.Current == 0 {
				t.Fatalf("stats: %v %+v", err, s)
			}
		}
	}
	if !found {
		t.Fatal("workload not in Running()")
	}

	// A running container with a changed spec is reported changed and kept running.
	changed := e.spec(id)
	changed.Env["EXTRA"] = "1"
	res3, err := e.d.Ensure(ctx, changed, nil)
	if err != nil || !res3.Changed || res3.Created || res3.Status.State != protocol.StateRunning || res3.Status.ContainerID != res.Status.ContainerID {
		t.Fatalf("ensure changed while running: %v %+v", err, res3)
	}

	// Crash → agent-side restart policy restarts it (on-failure).
	if err := e.d.Console(ctx, id, "crash"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		st, _ = e.d.Status(ctx, id)
		if st.State == protocol.StateRunning && st.RestartCount == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("not restarted after crash: %+v", st)
		}
		time.Sleep(200 * time.Millisecond)
	}
	// The restart applied the newer spec (container recreated since it was not running).
	if st.SpecHash == res.Status.SpecHash {
		t.Fatal("restart did not apply the pending spec")
	}
	e.waitLog(id, "READY", 15*time.Second)
	if lines, _ := e.logs.Tail(id, 5000, -1); !hasStderr(lines, "crashing") {
		t.Fatal("stderr line not captured")
	}

	// Deliberate stop via stopCommand → exit 0, no restart.
	st, err = e.d.Stop(ctx, id, 10*time.Second)
	if err != nil || st.State != protocol.StateExited || st.ExitCode == nil || *st.ExitCode != 0 {
		t.Fatalf("stop: %v %+v", err, st)
	}
	time.Sleep(3 * time.Second)
	if st, _ = e.d.Status(ctx, id); st.State != protocol.StateExited {
		t.Fatalf("restarted after a deliberate stop: %+v", st)
	}

	// Start + kill → 137, no restart.
	if _, err := e.d.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	e.waitState(id, protocol.StateRunning, 10*time.Second)
	st, err = e.d.Kill(ctx, id)
	if err != nil || st.State != protocol.StateExited || st.ExitCode == nil || *st.ExitCode != 137 {
		t.Fatalf("kill: %v %+v", err, st)
	}
	time.Sleep(3 * time.Second)
	if st, _ = e.d.Status(ctx, id); st.State != protocol.StateExited {
		t.Fatalf("restarted after kill: %+v", st)
	}

	// Historical logs fallback from the Docker API.
	lines, err := e.d.LogsFromRuntime(ctx, id, 100, nil)
	if err != nil || len(lines) == 0 {
		t.Fatalf("runtime logs: %v %d", err, len(lines))
	}

	// Remove with data → container and data dir gone.
	if err := e.d.Remove(ctx, id, true); err != nil {
		t.Fatal(err)
	}
	if st, _ := e.d.Status(ctx, id); st.Exists || st.State != protocol.StateMissing {
		t.Fatalf("after remove: %+v", st)
	}
	if _, err := os.Stat(e.sb.WorkloadBase(id)); !os.IsNotExist(err) {
		t.Fatal("workload directory not deleted")
	}
	if _, err := e.cli.NetworkInspect(ctx, e.netName, client.NetworkInspectOptions{}); err == nil {
		t.Fatal("unused agent-created bf-* network not pruned on remove")
	}
	e.mu.Lock()
	evs := strings.Join(e.events, ",")
	e.mu.Unlock()
	for _, want := range []string{"workload.state:running", "workload.state:exited", "workload.state:missing"} {
		if !strings.Contains(evs, want) {
			t.Fatalf("event %s missing from %s", want, evs)
		}
	}
}

func hasStderr(lines []protocol.LogLine, needle string) bool {
	for _, l := range lines {
		if l.Stream == "stderr" && strings.Contains(l.Line, needle) {
			return true
		}
	}
	return false
}

func TestRestartLimitAndUnmanagedContainerUntouched(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id := newUUID()
	defer e.d.Remove(ctx, id, true)
	s := e.spec(id)
	s.Command = []string{"sh", "-c", "echo boom; exit 7"}
	s.RestartPolicy = protocol.RestartPolicy{Mode: "on-failure", MaxRetries: 2, BackoffMs: 1000}
	if _, err := e.d.Ensure(ctx, s, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(40 * time.Second)
	for {
		e.mu.Lock()
		evs := strings.Join(e.events, ",")
		e.mu.Unlock()
		if strings.Contains(evs, "agent.warning") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("restart limit warning not emitted: %s", evs)
		}
		time.Sleep(200 * time.Millisecond)
	}
	st, _ := e.d.Status(ctx, id)
	if st.State != protocol.StateExited || st.RestartCount != 2 || *st.ExitCode != 7 {
		t.Fatalf("after giving up: %+v", st)
	}

	// A container with a workload's name but without the managed label is never touched.
	foreign := newUUID()
	_, err := e.cli.ContainerCreate(ctx, client.ContainerCreateOptions{Name: ContainerName(foreign),
		Config: &container.Config{Image: testImage, Cmd: []string{"true"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.cli.ContainerRemove(ctx, ContainerName(foreign), client.ContainerRemoveOptions{Force: true})
	fs := e.spec(foreign)
	if _, err := e.d.Ensure(ctx, fs, nil); err == nil || !strings.Contains(err.Error(), "not managed") {
		t.Fatalf("foreign container: %v", err)
	}
	if _, err := e.d.Kill(ctx, foreign); err == nil {
		t.Fatal("kill touched an unmanaged container")
	}
	if err := e.d.Remove(ctx, foreign, false); err == nil {
		t.Fatal("remove touched an unmanaged container")
	}
	if _, err := e.cli.ContainerInspect(ctx, ContainerName(foreign), client.ContainerInspectOptions{}); err != nil {
		t.Fatal("unmanaged container was removed")
	}
	// Disallowed image refused before anything is created.
	bad := e.spec(newUUID())
	bad.Image = "busybox:latest"
	if _, err := e.d.Ensure(ctx, bad, nil); errCode(err) != protocol.CodeImageNotAllowed {
		t.Fatalf("image outside allowlist: %v", err)
	}
}

func TestPullSigtermOOMAndReattach(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	// Image pull with progress (an allowlisted image that is not present locally).
	const pullImage = "alpine:3.21"
	e.cli.ImageRemove(ctx, pullImage, client.ImageRemoveOptions{Force: true})
	images, _ := config.NewImageAllowlist([]string{testImage, pullImage})
	e.d.o.Images = images
	pid := newUUID()
	defer e.d.Remove(ctx, pid, true)
	ps := e.spec(pid)
	ps.Image = pullImage
	var stages []string
	var mu sync.Mutex
	if _, err := e.d.Ensure(ctx, ps, func(stage, msg string, pct *float64) {
		mu.Lock()
		stages = append(stages, stage+":"+msg)
		mu.Unlock()
	}); err != nil {
		t.Fatalf("ensure with pull: %v", err)
	}
	mu.Lock()
	if len(stages) == 0 || !strings.HasPrefix(stages[0], "pull:") {
		t.Fatalf("no pull progress: %v", stages)
	}
	mu.Unlock()

	// No stop command → SIGTERM path; the workload traps TERM and exits 0.
	tid := newUUID()
	defer e.d.Remove(ctx, tid, true)
	ts := e.spec(tid)
	ts.StopCommand = nil
	ts.Command = []string{"sh", "-c", `trap 'echo got-TERM; exit 0' TERM; echo READY; while true; do sleep 1; done`}
	if _, err := e.d.Ensure(ctx, ts, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Start(ctx, tid); err != nil {
		t.Fatal(err)
	}
	e.waitLog(tid, "READY", 15*time.Second)

	// Simulated agent restart: a second driver instance re-attaches logs and console to the
	// running container (tail from "now", persistent stdin attach re-created).
	logs2 := logs.NewManager(func(protocol.LogsFrame) {})
	images2, _ := config.NewImageAllowlist([]string{testImage})
	d2, err := NewDriver(Options{NodeID: itNodeID, DataRoot: e.d.o.DataRoot, UID: 1000, GID: 1000, Images: images2, Sandbox: e.sb, Logs: logs2,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), ProbeJar: jvmprobe.Jar()})
	if err != nil {
		t.Fatal(err)
	}
	ctx2, cancel2 := context.WithCancel(ctx)
	go d2.Run(ctx2)
	defer cancel2()
	time.Sleep(time.Second)
	if err := d2.Console(ctx, tid, "after-restart"); err != nil {
		t.Fatalf("console after restart: %v", err)
	}
	st, err := d2.Stop(ctx, tid, 10*time.Second)
	if err != nil || st.State != protocol.StateExited || *st.ExitCode != 0 {
		t.Fatalf("SIGTERM stop: %v %+v", err, st)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		lines, _ := logs2.Tail(tid, 100, -1)
		if hasLine(lines, "got-TERM") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("re-attached follower did not capture output: %+v", lines)
		}
		time.Sleep(100 * time.Millisecond)
	}
	cancel2()

	// OOM: allocate past the 128 MiB limit → workload.oom event + oomKilled status, no restart (policy never).
	oid := newUUID()
	defer e.d.Remove(ctx, oid, true)
	oomSpec := e.spec(oid)
	oomSpec.RestartPolicy = protocol.RestartPolicy{Mode: "never"}
	oomSpec.Command = []string{"sh", "-c", `echo READY; x=$(head -c 400000000 /dev/zero | tr '\000' 'a'); echo survived`}
	if _, err := e.d.Ensure(ctx, oomSpec, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Start(ctx, oid); err != nil {
		t.Fatal(err)
	}
	ost := e.waitState(oid, protocol.StateExited, 60*time.Second)
	if ost.OOMKilled == nil || !*ost.OOMKilled || *ost.ExitCode != 137 {
		t.Fatalf("expected OOM kill: %+v", ost)
	}
	deadline = time.Now().Add(10 * time.Second)
	for {
		e.mu.Lock()
		evs := strings.Join(e.events, ",")
		e.mu.Unlock()
		if strings.Contains(evs, "workload.oom") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no workload.oom event: %s", evs)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func hasLine(lines []protocol.LogLine, needle string) bool {
	for _, l := range lines {
		if strings.Contains(l.Line, needle) {
			return true
		}
	}
	return false
}

func TestDesiredStateRecoveredAfterAgentRestart(t *testing.T) {
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
	e.cancel() // the agent goes away …
	time.Sleep(500 * time.Millisecond)
	timeout := 1
	// … and the container is stopped behind its back (daemon/host restart).
	if _, err := e.cli.ContainerStop(ctx, ContainerName(id), client.ContainerStopOptions{Timeout: &timeout}); err != nil {
		t.Fatal(err)
	}
	images, _ := config.NewImageAllowlist([]string{testImage})
	d2, err := NewDriver(Options{NodeID: itNodeID, DataRoot: e.d.o.DataRoot, UID: 1000, GID: 1000, Images: images, Sandbox: e.sb,
		Logs: logs.NewManager(func(protocol.LogsFrame) {}), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), ProbeJar: jvmprobe.Jar()})
	if err != nil {
		t.Fatal(err)
	}
	ctx2, cancel2 := context.WithCancel(ctx)
	defer cancel2()
	go d2.Run(ctx2)
	deadline := time.Now().Add(30 * time.Second)
	for {
		st, _ := d2.Status(ctx, id)
		if st.State == protocol.StateRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("desired running state not recovered: %+v", st)
		}
		time.Sleep(200 * time.Millisecond)
	}
	// A deliberately stopped workload stays stopped across an agent restart.
	if _, err := d2.Stop(ctx, id, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	cancel2()
	time.Sleep(300 * time.Millisecond)
	d3, _ := NewDriver(Options{NodeID: itNodeID, DataRoot: e.d.o.DataRoot, UID: 1000, GID: 1000, Images: images, Sandbox: e.sb,
		Logs: logs.NewManager(func(protocol.LogsFrame) {}), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), ProbeJar: jvmprobe.Jar()})
	ctx3, cancel3 := context.WithCancel(ctx)
	defer cancel3()
	go d3.Run(ctx3)
	time.Sleep(4 * time.Second)
	if st, _ := d3.Status(ctx, id); st.State != protocol.StateExited {
		t.Fatalf("deliberately stopped workload restarted after agent restart: %+v", st)
	}
}

func errCode(err error) protocol.ErrorCode {
	if pe, ok := protocol.AsError(err); ok {
		return pe.Code
	}
	return ""
}

// A bf-* network that this agent did not create (no managed label, or another node's label) is
// never joined: workload.ensure fails with CONFLICT before anything is created or persisted.
func TestForeignBfNetworkRefused(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	cases := map[string]map[string]string{
		"bf-x-" + randHex(3):       nil, // created by someone else
		"bf-other-" + randHex(3):   {LabelManaged: "true", LabelNode: "99999999-9999-4999-8999-999999999999"},
		"bf-nolabel-" + randHex(3): {LabelManaged: "true"},
	}
	for name, labels := range cases {
		if _, err := e.cli.NetworkCreate(ctx, name, client.NetworkCreateOptions{Driver: "bridge", Labels: labels}); err != nil {
			t.Fatal(err)
		}
		defer e.cli.NetworkRemove(context.Background(), name, client.NetworkRemoveOptions{})
		id := newUUID()
		s := e.spec(id)
		s.Networks = []protocol.WorkloadNetwork{{Name: name, Aliases: []string{}}}
		_, err := e.d.Ensure(ctx, s, nil)
		if errCode(err) != protocol.CodeConflict {
			t.Fatalf("%s (%v): want CONFLICT, got %v", name, labels, err)
		}
		if _, err := e.cli.ContainerInspect(ctx, ContainerName(id), client.ContainerInspectOptions{}); err == nil {
			t.Fatalf("%s: container created despite the conflict", name)
		}
		ni, err := e.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{})
		if err != nil || len(ni.Network.Containers) != 0 {
			t.Fatalf("%s: network gained endpoints: %v %+v", name, err, ni.Network.Containers)
		}
		if _, err := os.Stat(e.sb.WorkloadBase(id)); !os.IsNotExist(err) {
			t.Fatalf("%s: workload state persisted despite the conflict", name)
		}
		// Pruning never deletes a network this agent did not create.
		e.d.pruneNetworks(ctx, []string{name})
		if _, err := e.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{}); err != nil {
			t.Fatalf("%s: foreign network was pruned", name)
		}
	}
	// Start of an ensured workload whose network was swapped for a foreign one also refuses.
	id := newUUID()
	defer e.d.Remove(ctx, id, true)
	s := e.spec(id)
	if _, err := e.d.Ensure(ctx, s, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.cli.ContainerRemove(ctx, ContainerName(id), client.ContainerRemoveOptions{Force: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.cli.NetworkRemove(ctx, e.netName, client.NetworkRemoveOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.cli.NetworkCreate(ctx, e.netName, client.NetworkCreateOptions{Driver: "bridge"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Start(ctx, id); errCode(err) != protocol.CodeConflict {
		t.Fatalf("start onto a foreign network: %v", err)
	}
}
