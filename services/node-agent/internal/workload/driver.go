package workload

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/events"
	"github.com/moby/moby/client"

	"github.com/blockforge/node-agent/internal/config"
	"github.com/blockforge/node-agent/internal/fileutil"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/logs"
	"github.com/blockforge/node-agent/internal/protocol"
)

// Options configures the driver.
type Options struct {
	// NodeID labels the bf-* networks this agent creates (io.blockforge.node) and is required to reuse one.
	NodeID     string
	DataRoot   string
	DockerHost string
	UID, GID   int
	Images     *config.ImageAllowlist
	Sandbox    *fsops.Sandbox
	Logs       *logs.Manager
	// Emit publishes an `event` frame.
	Emit     func(event string, data any)
	Logger   *slog.Logger
	ProbeJar []byte
}

// Driver manages workload containers through the Docker Engine API.
type Driver struct {
	cli     *client.Client
	o       Options
	rootCtx context.Context

	mu sync.Mutex
	ws map[string]*wstate
}

type wstate struct {
	// opMu serialises ensure/start/remove and policy restarts for one workload.
	opMu sync.Mutex

	mu             sync.Mutex
	tracker        RestartTracker
	timer          *time.Timer
	pendingRestart bool
	followCID      string
	followCancel   context.CancelFunc

	// consoleMu guards the persistent stdin attach (network I/O, so not under mu).
	consoleMu  sync.Mutex
	console    *client.HijackedResponse
	consoleCID string
}

// NewDriver connects to Docker (DOCKER_HOST / config override) with API version negotiation.
func NewDriver(o Options) (*Driver, error) {
	if !protocol.IsUUID(o.NodeID) {
		return nil, errors.New("workload driver: NodeID must be the enrolled node id")
	}
	opts := []client.Opt{client.FromEnv, client.WithAPIVersionNegotiation()}
	if o.DockerHost != "" {
		opts = append(opts, client.WithHost(o.DockerHost))
	}
	cli, err := client.New(opts...)
	if err != nil {
		return nil, err
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.Emit == nil {
		o.Emit = func(string, any) {}
	}
	return &Driver{cli: cli, o: o, ws: map[string]*wstate{}, rootCtx: context.Background()}, nil
}

// Client exposes the Docker client (facts collection).
func (d *Driver) Client() *client.Client { return d.cli }

// Close releases the client.
func (d *Driver) Close() error { return d.cli.Close() }

func (d *Driver) state(id string) *wstate {
	d.mu.Lock()
	defer d.mu.Unlock()
	w := d.ws[id]
	if w == nil {
		w = &wstate{}
		if spec, err := d.loadSpec(id); err == nil {
			w.tracker.Policy = spec.RestartPolicy
		}
		if st := d.loadState(id); st.GaveUp {
			w.tracker.GaveUp = true
		}
		d.ws[id] = w
	}
	return w
}

// ---------------------------------------------------------------------------
// Persistence: <dataRoot>/servers/<id>/{spec.json,state.json} (agent-owned, outside /data)

type persistedState struct {
	Desired string `json:"desired"`
	GaveUp  bool   `json:"gaveUp,omitempty"`
}

func (d *Driver) base(id string) string { return d.o.Sandbox.WorkloadBase(id) }

func (d *Driver) saveSpec(spec *protocol.WorkloadSpec) error {
	b, _ := json.MarshalIndent(spec, "", "  ")
	return fileutil.WriteFileAtomic(filepath.Join(d.base(spec.WorkloadID), "spec.json"), b, 0o600)
}

func (d *Driver) loadSpec(id string) (*protocol.WorkloadSpec, error) {
	b, err := os.ReadFile(filepath.Join(d.base(id), "spec.json"))
	if err != nil {
		return nil, err
	}
	var s protocol.WorkloadSpec
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func (d *Driver) saveState(id string, st persistedState) {
	b, _ := json.Marshal(st)
	if err := fileutil.WriteFileAtomic(filepath.Join(d.base(id), "state.json"), b, 0o600); err != nil {
		d.o.Logger.Warn("persist workload state", "workload", id, "err", err)
	}
}

func (d *Driver) loadState(id string) persistedState {
	var st persistedState
	if b, err := os.ReadFile(filepath.Join(d.base(id), "state.json")); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	return st
}

// KnownWorkloads lists workload ids that have a persisted spec.
func (d *Driver) KnownWorkloads() []string {
	entries, err := os.ReadDir(filepath.Join(d.o.DataRoot, "servers"))
	if err != nil {
		return nil
	}
	var ids []string
	for _, e := range entries {
		if e.IsDir() && protocol.IsUUID(e.Name()) {
			if _, err := os.Stat(filepath.Join(d.base(e.Name()), "spec.json")); err == nil {
				ids = append(ids, e.Name())
			}
		}
	}
	return ids
}

// Spec returns the persisted spec for a workload.
func (d *Driver) Spec(id string) (*protocol.WorkloadSpec, error) { return d.loadSpec(id) }

// ProbeJarPath is the host path of the JVM probe jar.
func (d *Driver) ProbeJarPath() string {
	return filepath.Join(d.o.DataRoot, "runtime", "jvm-probe.jar")
}

func (d *Driver) hostOpts(id string) HostOptions {
	return HostOptions{DataDir: d.o.Sandbox.DataDir(id), ProbeJarPath: d.ProbeJarPath(), UID: d.o.UID, GID: d.o.GID}
}

// InstallProbeJar writes the embedded JVM probe to <dataRoot>/runtime/jvm-probe.jar if it differs.
func (d *Driver) InstallProbeJar() error {
	if len(d.o.ProbeJar) == 0 {
		return errors.New("no embedded JVM probe")
	}
	p := d.ProbeJarPath()
	if cur, err := os.ReadFile(p); err == nil && sha256.Sum256(cur) == sha256.Sum256(d.o.ProbeJar) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return fileutil.WriteFileAtomic(p, d.o.ProbeJar, 0o644)
}

// ---------------------------------------------------------------------------
// Docker helpers

func runtimeErr(op string, err error) error {
	if err == nil {
		return nil
	}
	if pe, ok := protocol.AsError(err); ok {
		return pe
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return err
	}
	if client.IsErrConnectionFailed(err) {
		return protocol.RetryableErrorf(protocol.CodeRuntimeError, "%s: container runtime unreachable", op)
	}
	msg := err.Error()
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return protocol.Errorf(protocol.CodeRuntimeError, "%s: %s", op, msg)
}

// inspectManaged returns the container for a workload, or nil if missing. A container with the
// workload's name that is NOT labelled as managed is never touched.
func (d *Driver) inspectManaged(ctx context.Context, id string) (*container.InspectResponse, error) {
	res, err := d.cli.ContainerInspect(ctx, ContainerName(id), client.ContainerInspectOptions{})
	if err != nil {
		if cerrdefs.IsNotFound(err) {
			return nil, nil
		}
		return nil, runtimeErr("inspect container", err)
	}
	c := res.Container
	if c.Config == nil || c.Config.Labels[LabelManaged] != "true" || c.Config.Labels[LabelWorkload] != id {
		return nil, protocol.Errorf(protocol.CodeConflict, "container %s exists but is not managed by BlockForge; refusing to touch it", ContainerName(id))
	}
	return &c, nil
}

func parseDockerTime(s string) *int64 {
	if s == "" || strings.HasPrefix(s, "0001-01-01") {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return nil
	}
	ms := t.UnixMilli()
	return &ms
}

func mapState(s container.ContainerState) string {
	switch s {
	case container.StateCreated:
		return protocol.StateCreated
	case container.StateRunning, container.StatePaused:
		return protocol.StateRunning
	case container.StateRestarting:
		return protocol.StateRestarting
	case container.StateDead:
		return protocol.StateDead
	}
	return protocol.StateExited
}

func (d *Driver) statusFrom(id string, c *container.InspectResponse) protocol.WorkloadStatus {
	w := d.state(id)
	w.mu.Lock()
	retries, pending := w.tracker.Retries, w.pendingRestart
	w.mu.Unlock()
	st := protocol.WorkloadStatus{WorkloadID: id, RestartCount: retries}
	if c == nil {
		st.State = protocol.StateMissing
		if spec, err := d.loadSpec(id); err == nil {
			st.Image = spec.Image
		}
		return st
	}
	st.Exists = true
	st.ContainerID = c.ID
	if len(st.ContainerID) > 12 {
		st.ContainerID = st.ContainerID[:12]
	}
	if c.Config != nil {
		st.Image = c.Config.Image
		st.SpecHash = c.Config.Labels[LabelSpecHash]
	}
	if c.State != nil {
		st.State = mapState(c.State.Status)
		st.StartedAt = parseDockerTime(c.State.StartedAt)
		st.FinishedAt = parseDockerTime(c.State.FinishedAt)
		if !c.State.Running && st.FinishedAt != nil {
			code := c.State.ExitCode
			oom := c.State.OOMKilled
			st.ExitCode, st.OOMKilled = &code, &oom
		}
		if pending && !c.State.Running {
			st.State = protocol.StateRestarting
		}
	}
	return st
}

// Status returns the status of one workload.
func (d *Driver) Status(ctx context.Context, id string) (protocol.WorkloadStatus, error) {
	c, err := d.inspectManaged(ctx, id)
	if err != nil {
		return protocol.WorkloadStatus{}, err
	}
	return d.statusFrom(id, c), nil
}

// List returns statuses of every managed container plus persisted specs without a container.
func (d *Driver) List(ctx context.Context) ([]protocol.WorkloadStatus, error) {
	res, err := d.cli.ContainerList(ctx, client.ContainerListOptions{All: true,
		Filters: client.Filters{}.Add("label", LabelManaged+"=true")})
	if err != nil {
		return nil, runtimeErr("list containers", err)
	}
	seen := map[string]bool{}
	out := []protocol.WorkloadStatus{}
	for _, s := range res.Items {
		id := s.Labels[LabelWorkload]
		if !protocol.IsUUID(id) || seen[id] {
			continue
		}
		seen[id] = true
		st, err := d.Status(ctx, id)
		if err != nil {
			continue
		}
		out = append(out, st)
	}
	for _, id := range d.KnownWorkloads() {
		if !seen[id] {
			out = append(out, d.statusFrom(id, nil))
		}
	}
	return out, nil
}

// RunningInfo describes a running managed container (metrics, SLP).
type RunningInfo struct {
	WorkloadID  string
	ContainerID string
	Kind        string
	// IPs maps network name → container IP.
	IPs map[string]string
}

// Running lists running managed containers.
func (d *Driver) Running(ctx context.Context) ([]RunningInfo, error) {
	res, err := d.cli.ContainerList(ctx, client.ContainerListOptions{
		Filters: client.Filters{}.Add("label", LabelManaged+"=true").Add("status", "running")})
	if err != nil {
		return nil, runtimeErr("list containers", err)
	}
	var out []RunningInfo
	for _, s := range res.Items {
		id := s.Labels[LabelWorkload]
		if !protocol.IsUUID(id) || s.Labels[LabelManaged] != "true" {
			continue
		}
		ri := RunningInfo{WorkloadID: id, ContainerID: s.ID, Kind: s.Labels[LabelKind], IPs: map[string]string{}}
		if s.NetworkSettings != nil {
			for name, ep := range s.NetworkSettings.Networks {
				if ep != nil && ep.IPAddress.IsValid() {
					ri.IPs[name] = ep.IPAddress.String()
				}
			}
		}
		out = append(out, ri)
	}
	return out, nil
}

// Stats takes a one-shot stats sample.
func (d *Driver) Stats(ctx context.Context, containerID string) (*container.StatsResponse, error) {
	res, err := d.cli.ContainerStats(ctx, containerID, client.ContainerStatsOptions{Stream: false})
	if err != nil {
		return nil, runtimeErr("stats", err)
	}
	defer res.Body.Close()
	var s container.StatsResponse
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&s); err != nil {
		return nil, runtimeErr("decode stats", err)
	}
	return &s, nil
}

// ---------------------------------------------------------------------------
// Ensure

// EnsureResult is the workload.ensure result.
type EnsureResult struct {
	Created bool                    `json:"created"`
	Changed bool                    `json:"changed"`
	Status  protocol.WorkloadStatus `json:"status"`
}

// ProgressFunc reports long-running progress.
type ProgressFunc func(stage, message string, percent *float64)

// Ensure creates or reconciles the workload container (idempotent by spec hash). A running
// container with a different spec is left running and reported as changed.
func (d *Driver) Ensure(ctx context.Context, spec *protocol.WorkloadSpec, progress ProgressFunc) (*EnsureResult, error) {
	if !d.o.Images.Allowed(spec.Image) {
		return nil, protocol.Errorf(protocol.CodeImageNotAllowed, "image %q is not allowed by this agent's image allowlist", spec.Image)
	}
	for _, n := range spec.Networks {
		if !strings.HasPrefix(n.Name, "bf-") {
			return nil, protocol.Errorf(protocol.CodeValidationFailed, "network %q must start with bf-", n.Name)
		}
	}
	id := spec.WorkloadID
	w := d.state(id)
	w.opMu.Lock()
	defer w.opMu.Unlock()
	c, err := d.inspectManaged(ctx, id)
	if err != nil {
		return nil, err
	}
	// Refuse foreign bf-* networks before anything is persisted or created.
	for _, n := range spec.Networks {
		if _, err := d.checkNetwork(ctx, n.Name); err != nil {
			return nil, err
		}
	}
	if err := d.o.Sandbox.EnsureDataDir(id); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "prepare data directory: %v", err)
	}
	if err := d.saveSpec(spec); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "persist spec: %v", err)
	}
	w.mu.Lock()
	w.tracker.Policy = spec.RestartPolicy
	w.mu.Unlock()
	if d.loadState(id).Desired == "" {
		d.saveState(id, persistedState{Desired: "stopped"})
	}
	hash := SpecHash(spec, d.hostOpts(id))
	res := &EnsureResult{}
	switch {
	case c == nil:
		if err := d.create(ctx, spec, progress); err != nil {
			return nil, err
		}
		res.Created = true
	case c.Config.Labels[LabelSpecHash] == hash:
	case c.State != nil && (c.State.Running || c.State.Restarting || c.State.Paused):
		res.Changed = true
	default:
		if _, err := d.cli.ContainerRemove(ctx, c.ID, client.ContainerRemoveOptions{Force: true}); err != nil && !cerrdefs.IsNotFound(err) {
			return nil, runtimeErr("remove outdated container", err)
		}
		if err := d.create(ctx, spec, progress); err != nil {
			return nil, err
		}
		res.Created, res.Changed = true, true
	}
	st, err := d.Status(ctx, id)
	if err != nil {
		return nil, err
	}
	res.Status = st
	return res, nil
}

func (d *Driver) create(ctx context.Context, spec *protocol.WorkloadSpec, progress ProgressFunc) error {
	if spec.JvmProbe {
		if err := d.InstallProbeJar(); err != nil {
			return protocol.Errorf(protocol.CodeInternal, "install JVM probe: %v", err)
		}
	}
	if err := d.ensureImage(ctx, spec.Image, progress); err != nil {
		return err
	}
	for _, n := range spec.Networks {
		if err := d.ensureNetwork(ctx, n.Name); err != nil {
			return err
		}
	}
	opts, err := BuildCreateOptions(spec, d.hostOpts(spec.WorkloadID))
	if err != nil {
		return err
	}
	if _, err := d.cli.ContainerCreate(ctx, opts); err != nil {
		return runtimeErr("create container", err)
	}
	return nil
}

func (d *Driver) ensureImage(ctx context.Context, image string, progress ProgressFunc) error {
	if _, err := d.cli.ImageInspect(ctx, image); err == nil {
		return nil
	} else if !cerrdefs.IsNotFound(err) {
		return runtimeErr("inspect image", err)
	}
	if progress != nil {
		progress("pull", "pulling "+image, nil)
	}
	resp, err := d.cli.ImagePull(ctx, image, client.ImagePullOptions{})
	if err != nil {
		return runtimeErr("pull image", err)
	}
	type layer struct{ cur, total int64 }
	layers := map[string]*layer{}
	last := time.Now()
	for msg, err := range resp.JSONMessages(ctx) {
		if err != nil {
			return runtimeErr("pull image", err)
		}
		if msg.Error != nil {
			return protocol.RetryableErrorf(protocol.CodeRuntimeError, "pull %s: %s", image, msg.Error.Message)
		}
		if msg.ID != "" && msg.Progress != nil && msg.Status == "Downloading" {
			l := layers[msg.ID]
			if l == nil {
				l = &layer{}
				layers[msg.ID] = l
			}
			l.cur, l.total = msg.Progress.Current, msg.Progress.Total
		}
		if progress != nil && time.Since(last) >= time.Second {
			last = time.Now()
			var cur, total int64
			for _, l := range layers {
				cur += l.cur
				total += l.total
			}
			if total > 0 {
				pct := float64(cur) / float64(total) * 100
				if pct > 100 {
					pct = 100
				}
				progress("pull", fmt.Sprintf("pulling %s: %d of %d MiB", image, cur>>20, total>>20), &pct)
			}
		}
	}
	if _, err := d.cli.ImageInspect(ctx, image); err != nil {
		return runtimeErr("image missing after pull", err)
	}
	return nil
}

// checkNetwork validates an existing bf-* network before a workload may join it: it must have been
// created by this agent (io.blockforge.managed=true and io.blockforge.node=<our node id>) and be a
// bridge. A missing network is fine (it will be created). Foreign networks are a CONFLICT.
func (d *Driver) checkNetwork(ctx context.Context, name string) (exists bool, err error) {
	if !strings.HasPrefix(name, "bf-") {
		return false, protocol.Errorf(protocol.CodeValidationFailed, "network %q must start with bf-", name)
	}
	res, err := d.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{})
	if err != nil {
		if cerrdefs.IsNotFound(err) {
			return false, nil
		}
		return false, runtimeErr("inspect network", err)
	}
	n := res.Network
	switch {
	case n.Name != name:
		return true, protocol.Errorf(protocol.CodeConflict, "network lookup %q resolved to %q", name, n.Name)
	case n.Labels[LabelManaged] != "true":
		return true, protocol.Errorf(protocol.CodeConflict, "network %q exists but was not created by BlockForge; refusing to attach workloads to it", name)
	case n.Labels[LabelNode] != d.o.NodeID:
		return true, protocol.Errorf(protocol.CodeConflict, "network %q is owned by another BlockForge node; refusing to attach workloads to it", name)
	case n.Driver != "bridge":
		return true, protocol.Errorf(protocol.CodeConflict, "network %q exists with driver %q (bridge required)", name, n.Driver)
	}
	return true, nil
}

func (d *Driver) ensureNetwork(ctx context.Context, name string) error {
	for attempt := 0; attempt < 2; attempt++ {
		exists, err := d.checkNetwork(ctx, name)
		if err != nil || exists {
			return err
		}
		_, err = d.cli.NetworkCreate(ctx, name, client.NetworkCreateOptions{
			Driver: "bridge", Labels: map[string]string{LabelManaged: "true", LabelNode: d.o.NodeID},
		})
		if err == nil {
			return nil
		}
		if !cerrdefs.IsConflict(err) {
			return runtimeErr("create network", err)
		}
		// Lost a creation race: validate whatever exists now.
	}
	return protocol.RetryableErrorf(protocol.CodeConflict, "network %q could not be created", name)
}

// ---------------------------------------------------------------------------
// Lifecycle

// Start starts the workload (recreating the container from the persisted spec if needed).
func (d *Driver) Start(ctx context.Context, id string) (protocol.WorkloadStatus, error) {
	w := d.state(id)
	w.opMu.Lock()
	defer w.opMu.Unlock()
	return d.startLocked(ctx, id, true)
}

func (d *Driver) startLocked(ctx context.Context, id string, manual bool) (protocol.WorkloadStatus, error) {
	spec, err := d.loadSpec(id)
	if err != nil {
		return protocol.WorkloadStatus{}, protocol.Errorf(protocol.CodeNotFound, "workload %s has no spec on this node (run workload.ensure first)", id)
	}
	if !d.o.Images.Allowed(spec.Image) {
		return protocol.WorkloadStatus{}, protocol.Errorf(protocol.CodeImageNotAllowed, "image %q is no longer allowed by this agent", spec.Image)
	}
	w := d.state(id)
	if manual {
		d.saveState(id, persistedState{Desired: "running"})
	}
	c, err := d.inspectManaged(ctx, id)
	if err != nil {
		return protocol.WorkloadStatus{}, err
	}
	hash := SpecHash(spec, d.hostOpts(id))
	if c != nil && c.State != nil && c.State.Running {
		return d.statusFrom(id, c), nil
	}
	if c != nil && c.Config.Labels[LabelSpecHash] != hash {
		if _, err := d.cli.ContainerRemove(ctx, c.ID, client.ContainerRemoveOptions{Force: true}); err != nil && !cerrdefs.IsNotFound(err) {
			return protocol.WorkloadStatus{}, runtimeErr("remove outdated container", err)
		}
		c = nil
	}
	if c == nil {
		if err := d.o.Sandbox.EnsureDataDir(id); err != nil {
			return protocol.WorkloadStatus{}, protocol.Errorf(protocol.CodeInternal, "prepare data directory: %v", err)
		}
		if err := d.create(ctx, spec, nil); err != nil {
			return protocol.WorkloadStatus{}, err
		}
	}
	w.mu.Lock()
	w.tracker.Policy = spec.RestartPolicy
	w.tracker.OnStart(time.Now(), manual)
	if w.timer != nil {
		w.timer.Stop()
	}
	w.pendingRestart = false
	w.mu.Unlock()
	if _, err := d.cli.ContainerStart(ctx, ContainerName(id), client.ContainerStartOptions{}); err != nil {
		return protocol.WorkloadStatus{}, runtimeErr("start container", err)
	}
	c, err = d.inspectManaged(ctx, id)
	if err != nil {
		return protocol.WorkloadStatus{}, err
	}
	if c != nil && c.State != nil {
		d.follow(id, c.ID, c.State.StartedAt, "")
	}
	return d.statusFrom(id, c), nil
}

// markStopped records a deliberate stop so the restart policy stays out of the way.
func (d *Driver) markStopped(id string) {
	w := d.state(id)
	w.mu.Lock()
	w.tracker.MarkDeliberate()
	if w.timer != nil {
		w.timer.Stop()
	}
	w.pendingRestart = false
	w.mu.Unlock()
	if _, err := os.Stat(d.base(id)); err == nil {
		d.saveState(id, persistedState{Desired: "stopped"})
	}
}

func (d *Driver) waitNotRunning(ctx context.Context, cid string, timeout time.Duration) bool {
	wctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	res := d.cli.ContainerWait(wctx, cid, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case <-res.Result:
		return true
	case <-res.Error:
		// The wait endpoint fails if the container is already gone or the deadline hit: check.
		c, err := d.cli.ContainerInspect(context.WithoutCancel(ctx), cid, client.ContainerInspectOptions{})
		return err != nil || c.Container.State == nil || !c.Container.State.Running
	}
}

// Stop writes the stop command to stdin, waits up to timeout, then SIGTERM, then SIGKILL after 15 s.
func (d *Driver) Stop(ctx context.Context, id string, timeout time.Duration) (protocol.WorkloadStatus, error) {
	d.markStopped(id)
	c, err := d.inspectManaged(ctx, id)
	if err != nil {
		return protocol.WorkloadStatus{}, err
	}
	if c == nil || c.State == nil || !c.State.Running {
		return d.statusFrom(id, c), nil
	}
	spec, _ := d.loadSpec(id)
	graceSecs := int(timeout / time.Second)
	if spec != nil && spec.StopCommand != nil {
		if err := d.writeConsole(id, c.ID, *spec.StopCommand); err != nil {
			// Not delivered: SIGTERM with the full timeout instead.
			d.o.Logger.Warn("stop command could not be delivered; falling back to SIGTERM", "workload", id, "err", err)
		} else {
			if d.waitNotRunning(ctx, c.ID, timeout) {
				return d.Status(context.WithoutCancel(ctx), id)
			}
			graceSecs = 15 // stop command ignored for timeoutMs: SIGTERM, then SIGKILL after 15 s
		}
	}
	if graceSecs < 1 {
		graceSecs = 1
	}
	if _, err := d.cli.ContainerStop(ctx, c.ID, client.ContainerStopOptions{Signal: "SIGTERM", Timeout: &graceSecs}); err != nil && !cerrdefs.IsNotFound(err) {
		return protocol.WorkloadStatus{}, runtimeErr("stop container", err)
	}
	return d.Status(context.WithoutCancel(ctx), id)
}

// Kill sends SIGKILL immediately.
func (d *Driver) Kill(ctx context.Context, id string) (protocol.WorkloadStatus, error) {
	d.markStopped(id)
	c, err := d.inspectManaged(ctx, id)
	if err != nil {
		return protocol.WorkloadStatus{}, err
	}
	if c == nil || c.State == nil || !c.State.Running {
		return d.statusFrom(id, c), nil
	}
	if _, err := d.cli.ContainerKill(ctx, c.ID, client.ContainerKillOptions{Signal: "SIGKILL"}); err != nil && !cerrdefs.IsNotFound(err) {
		return protocol.WorkloadStatus{}, runtimeErr("kill container", err)
	}
	d.waitNotRunning(ctx, c.ID, 10*time.Second)
	return d.Status(context.WithoutCancel(ctx), id)
}

// Remove deletes the container and, if requested, the workload directory (inside the data root only).
func (d *Driver) Remove(ctx context.Context, id string, deleteData bool) error {
	w := d.state(id)
	w.opMu.Lock()
	defer w.opMu.Unlock()
	c, err := d.inspectManaged(ctx, id)
	if err != nil {
		return err
	}
	d.markStopped(id)
	d.stopFollow(id)
	d.closeConsole(id)
	var networks []string
	if spec, err := d.loadSpec(id); err == nil {
		for _, n := range spec.Networks {
			networks = append(networks, n.Name)
		}
	}
	if c != nil {
		if _, err := d.cli.ContainerRemove(ctx, c.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); err != nil && !cerrdefs.IsNotFound(err) {
			return runtimeErr("remove container", err)
		}
	}
	d.pruneNetworks(ctx, networks)
	servers, err := os.OpenRoot(filepath.Join(d.o.DataRoot, "servers"))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return protocol.Errorf(protocol.CodeInternal, "open servers dir: %v", err)
	}
	defer servers.Close()
	if deleteData {
		if err := servers.RemoveAll(id); err != nil {
			return fsops.MapError("delete", id, err)
		}
	} else {
		_ = servers.Remove(id + "/spec.json")
		_ = servers.Remove(id + "/state.json")
	}
	d.o.Logs.Forget(id)
	d.mu.Lock()
	delete(d.ws, id)
	d.mu.Unlock()
	return nil
}

// ---------------------------------------------------------------------------
// Console

// Console writes one validated line to the workload's stdin.
func (d *Driver) Console(ctx context.Context, id, line string) error {
	if strings.ContainsAny(line, "\x00\r\n") || line == "" {
		return protocol.Errorf(protocol.CodeValidationFailed, "console input must be a single line")
	}
	c, err := d.inspectManaged(ctx, id)
	if err != nil {
		return err
	}
	if c == nil {
		return protocol.Errorf(protocol.CodeNotFound, "workload %s does not exist", id)
	}
	if c.State == nil || !c.State.Running {
		return protocol.Errorf(protocol.CodeConflict, "workload is not running")
	}
	return d.writeConsole(id, c.ID, line)
}

func (d *Driver) writeConsole(id, cid, line string) error {
	w := d.state(id)
	w.consoleMu.Lock()
	defer w.consoleMu.Unlock()
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if w.console == nil || w.consoleCID != cid {
			if w.console != nil {
				w.console.Close()
				w.console = nil
			}
			// ctrl-@ (NUL) can never appear in a validated console line, so input can't detach us.
			actx, cancel := context.WithTimeout(d.rootCtx, 15*time.Second)
			att, err := d.cli.ContainerAttach(actx, cid, client.ContainerAttachOptions{Stream: true, Stdin: true, DetachKeys: "ctrl-@"})
			cancel()
			if err != nil {
				return runtimeErr("attach stdin", err)
			}
			hr := att.HijackedResponse
			w.console, w.consoleCID = &hr, cid
		}
		_ = w.console.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		_, lastErr = w.console.Conn.Write([]byte(line + "\n"))
		if lastErr == nil {
			return nil
		}
		w.console.Close()
		w.console = nil
	}
	return runtimeErr("write stdin", lastErr)
}

func (d *Driver) closeConsole(id string) {
	w := d.state(id)
	w.consoleMu.Lock()
	if w.console != nil {
		w.console.Close()
		w.console = nil
	}
	w.consoleMu.Unlock()
}

// ---------------------------------------------------------------------------
// Logs

// follow streams stdout/stderr of a container into the log manager (idempotent per container).
// since is a Docker timestamp (RFC 3339) or "" with tail "0" for new output only.
func (d *Driver) follow(id, cid, since, tail string) {
	w := d.state(id)
	w.mu.Lock()
	if w.followCID == cid && w.followCancel != nil {
		w.mu.Unlock()
		return
	}
	if w.followCancel != nil {
		w.followCancel()
	}
	ctx, cancel := context.WithCancel(d.rootCtx)
	w.followCID, w.followCancel = cid, cancel
	w.mu.Unlock()
	go func() {
		defer func() {
			w.mu.Lock()
			if w.followCID == cid {
				w.followCID, w.followCancel = "", nil
			}
			w.mu.Unlock()
			cancel()
		}()
		opts := client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true, Follow: true, Timestamps: true}
		if since != "" && !strings.HasPrefix(since, "0001-") {
			opts.Since = since
		} else {
			opts.Tail = "0"
			if tail != "" {
				opts.Tail = tail
			}
		}
		rc, err := d.cli.ContainerLogs(ctx, cid, opts)
		if err != nil {
			if ctx.Err() == nil {
				d.o.Logger.Warn("follow logs", "workload", id, "err", err)
			}
			return
		}
		defer rc.Close()
		mk := func(stream string) *logs.LineWriter {
			return logs.NewLineWriter(protocol.LogLineMaxBytes+64, func(line string) {
				ts, text := splitTimestamp(line)
				d.o.Logs.Ingest(id, protocol.LogLine{TS: ts, Stream: stream, Line: text})
			})
		}
		out, errw := mk("stdout"), mk("stderr")
		_, _ = stdcopy.StdCopy(out, errw, rc)
		out.Flush()
		errw.Flush()
	}()
}

func (d *Driver) stopFollow(id string) {
	w := d.state(id)
	w.mu.Lock()
	if w.followCancel != nil {
		w.followCancel()
		w.followCID, w.followCancel = "", nil
	}
	w.mu.Unlock()
}

// splitTimestamp separates the RFC 3339 prefix Docker adds with timestamps=true.
func splitTimestamp(line string) (int64, string) {
	if sp := strings.IndexByte(line, ' '); sp > 0 && sp < 40 {
		if t, err := time.Parse(time.RFC3339Nano, line[:sp]); err == nil {
			return t.UnixMilli(), line[sp+1:]
		}
	}
	return time.Now().UnixMilli(), line
}

// LogsFromRuntime reads historical lines from Docker (fallback for workload.logs.tail).
func (d *Driver) LogsFromRuntime(ctx context.Context, id string, n int, since *int64) ([]protocol.LogLine, error) {
	c, err := d.inspectManaged(ctx, id)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, protocol.Errorf(protocol.CodeNotFound, "workload %s does not exist", id)
	}
	opts := client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true, Timestamps: true, Tail: strconv.Itoa(n)}
	if since != nil {
		opts.Since = time.UnixMilli(*since).UTC().Format(time.RFC3339Nano)
	}
	rc, err := d.cli.ContainerLogs(ctx, c.ID, opts)
	if err != nil {
		return nil, runtimeErr("read logs", err)
	}
	defer rc.Close()
	var lines []protocol.LogLine
	var mu sync.Mutex
	mk := func(stream string) *logs.LineWriter {
		return logs.NewLineWriter(protocol.LogLineMaxBytes+64, func(line string) {
			ts, text := splitTimestamp(line)
			mu.Lock()
			lines = append(lines, protocol.LogLine{TS: ts, Stream: stream, Line: logs.Truncate(text, protocol.LogLineMaxBytes)})
			mu.Unlock()
		})
	}
	out, errw := mk("stdout"), mk("stderr")
	if _, err := stdcopy.StdCopy(out, errw, io.LimitReader(rc, 64<<20)); err != nil {
		return nil, runtimeErr("read logs", err)
	}
	out.Flush()
	errw.Flush()
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	if lines == nil {
		lines = []protocol.LogLine{}
	}
	return lines, nil
}

// ---------------------------------------------------------------------------
// Events + restart policy

// Run installs the probe, reconciles existing workloads and watches Docker events until ctx ends.
func (d *Driver) Run(ctx context.Context) {
	d.rootCtx = ctx
	if err := d.InstallProbeJar(); err != nil {
		d.o.Logger.Warn("JVM probe not installed", "err", err)
	}
	delay := time.Second
	for ctx.Err() == nil {
		f := client.Filters{}.Add("type", "container").Add("label", LabelManaged+"=true")
		ectx, cancel := context.WithCancel(ctx)
		res := d.cli.Events(ectx, client.EventsListOptions{Filters: f})
		d.resync(ctx)
		started := time.Now()
	loop:
		for {
			select {
			case <-ctx.Done():
				cancel()
				return
			case m := <-res.Messages:
				d.handleEvent(ctx, m)
			case err := <-res.Err:
				if ctx.Err() == nil {
					d.o.Logger.Warn("docker event stream ended", "err", err)
				}
				break loop
			}
		}
		cancel()
		if time.Since(started) > time.Minute {
			delay = time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		if delay < 30*time.Second {
			delay *= 2
		}
	}
}

func (d *Driver) emitState(ctx context.Context, id string) {
	st, err := d.Status(ctx, id)
	if err != nil {
		return
	}
	d.o.Emit(protocol.EventWorkloadState, st)
}

// resync attaches log followers to running workloads and applies the restart policy to workloads
// that should be running but are not (e.g. after an agent or host restart).
func (d *Driver) resync(ctx context.Context) {
	statuses, err := d.List(ctx)
	if err != nil {
		d.o.Logger.Warn("resync workloads", "err", err)
		return
	}
	for _, st := range statuses {
		d.o.Emit(protocol.EventWorkloadState, st)
		id := st.WorkloadID
		if st.State == protocol.StateRunning {
			if c, err := d.inspectManaged(ctx, id); err == nil && c != nil {
				d.follow(id, c.ID, "", "0")
			}
			continue
		}
		ps := d.loadState(id)
		if ps.Desired != "running" || ps.GaveUp {
			continue
		}
		w := d.state(id)
		w.mu.Lock()
		pending := w.pendingRestart
		w.mu.Unlock()
		if pending {
			continue
		}
		// The exit happened while the agent was not watching (agent, daemon or host restart). A
		// daemon shutdown often ends the server cleanly (exit 0), so the observed exit counts as a
		// failure here: the desired running state is restored unless the policy is "never".
		code := 1
		if st.ExitCode != nil && *st.ExitCode != 0 {
			code = *st.ExitCode
		}
		d.onExit(ctx, id, code)
	}
}

func (d *Driver) handleEvent(ctx context.Context, m events.Message) {
	id := m.Actor.Attributes[LabelWorkload]
	if !protocol.IsUUID(id) || m.Actor.Attributes[LabelManaged] != "true" {
		return
	}
	switch m.Action {
	case events.ActionStart:
		w := d.state(id)
		w.mu.Lock()
		w.tracker.OnStart(time.Now(), false)
		w.pendingRestart = false
		w.mu.Unlock()
		if c, err := d.inspectManaged(ctx, id); err == nil && c != nil && c.State != nil {
			d.follow(id, c.ID, c.State.StartedAt, "")
		}
		d.emitState(ctx, id)
	case events.ActionDie:
		code, _ := strconv.Atoi(m.Actor.Attributes["exitCode"])
		d.closeConsole(id)
		d.emitState(ctx, id)
		d.onExit(ctx, id, code)
	case events.ActionOOM:
		d.o.Emit(protocol.EventWorkloadOOM, protocol.WorkloadOOMEvent{WorkloadID: id})
	case events.ActionDestroy:
		d.stopFollow(id)
		d.closeConsole(id)
		d.o.Emit(protocol.EventWorkloadState, d.statusFrom(id, nil))
	case events.ActionCreate:
		d.emitState(ctx, id)
	}
}

// onExit feeds an exit into the restart policy and schedules a restart if warranted.
func (d *Driver) onExit(ctx context.Context, id string, exitCode int) {
	ps := d.loadState(id)
	if ps.Desired != "running" {
		return
	}
	w := d.state(id)
	w.mu.Lock()
	dec := w.tracker.OnExit(time.Now(), exitCode)
	if dec.Restart {
		w.pendingRestart = true
		if w.timer != nil {
			w.timer.Stop()
		}
		w.timer = time.AfterFunc(dec.Delay, func() { d.policyRestart(id) })
	}
	retries := w.tracker.Retries
	w.mu.Unlock()
	switch {
	case dec.Restart:
		d.o.Logger.Info("restart policy: scheduling restart", "workload", id, "exitCode", exitCode, "in", dec.Delay, "attempt", retries)
		d.emitState(ctx, id)
	case dec.GaveUp:
		d.saveState(id, persistedState{Desired: "running", GaveUp: true})
		d.o.Emit(protocol.EventAgentWarning, protocol.AgentWarningEvent{
			Code:    "WORKLOAD_RESTART_LIMIT",
			Message: fmt.Sprintf("workload %s exited (code %d) and reached its restart limit", id, exitCode),
		})
	}
}

func (d *Driver) policyRestart(id string) {
	ctx := d.rootCtx
	if ctx.Err() != nil {
		return
	}
	w := d.state(id)
	w.opMu.Lock()
	defer w.opMu.Unlock()
	w.mu.Lock()
	ok := w.pendingRestart && !w.tracker.Deliberate
	w.mu.Unlock()
	if !ok || d.loadState(id).Desired != "running" {
		return
	}
	sctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	if _, err := d.startLocked(sctx, id, false); err != nil {
		d.o.Logger.Warn("restart policy: start failed", "workload", id, "err", err)
		w.mu.Lock()
		w.pendingRestart = false
		w.mu.Unlock()
		d.onExit(sctx, id, 255)
	}
}

// pruneNetworks removes bf-* networks this agent created (managed + node labels) once no container
// uses them. Networks created by anyone else are never removed.
func (d *Driver) pruneNetworks(ctx context.Context, names []string) {
	for _, name := range names {
		if !strings.HasPrefix(name, "bf-") {
			continue
		}
		res, err := d.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{})
		if err != nil || res.Network.Name != name || res.Network.Labels[LabelManaged] != "true" ||
			res.Network.Labels[LabelNode] != d.o.NodeID || len(res.Network.Containers) > 0 {
			continue
		}
		if _, err := d.cli.NetworkRemove(ctx, res.Network.ID, client.NetworkRemoveOptions{}); err != nil && !cerrdefs.IsNotFound(err) {
			d.o.Logger.Info("network still in use or not removable", "network", name, "err", err)
		}
	}
}
