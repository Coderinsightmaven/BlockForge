package workload

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/client"

	"github.com/blockforge/node-agent/internal/fileutil"
	"github.com/blockforge/node-agent/internal/logs"
	"github.com/blockforge/node-agent/internal/protocol"
)

// Install container layout (agent-protocol.md "Install containers").
const (
	installScriptDir   = "/mnt/install"
	installScriptPath  = installScriptDir + "/install.sh"
	installDataPath    = "/mnt/server"
	installLogTail     = 200
	installPidsLimit   = 4096
	ownershipFixWindow = 5 * time.Minute
)

// installCaps is the only capability set install containers get (root inside, no-new-privileges).
var installCaps = []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"}

// InstallContainerName is the Docker name of a workload's install container.
func InstallContainerName(workloadID string) string { return "bf-" + workloadID + "-install" }

// installWrapper runs the egg script and always hands the data back to the workload user, also when
// the script fails. Only integers are interpolated; the script itself is a file, never a string here.
func installWrapper(shell string, uid, gid int, script bool) string {
	run := shell + " " + installScriptPath + "; rc=$?; "
	if !script {
		run = "rc=0; "
	}
	return fmt.Sprintf("%schown -R %d:%d %s; exit $rc", run, uid, gid, installDataPath)
}

func sortedEnv(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+m[k])
	}
	return out
}

func (d *Driver) installCreateOptions(p *protocol.WorkloadInstallPayload, scriptHostDir, name string, cmd []string) client.ContainerCreateOptions {
	pids := int64(installPidsLimit)
	hc := &container.HostConfig{
		Mounts: []mount.Mount{
			{Type: mount.TypeBind, Source: d.o.Sandbox.DataDir(p.WorkloadID), Target: installDataPath,
				BindOptions: &mount.BindOptions{Propagation: mount.PropagationRPrivate}},
			{Type: mount.TypeBind, Source: scriptHostDir, Target: installScriptDir, ReadOnly: true,
				BindOptions: &mount.BindOptions{Propagation: mount.PropagationRPrivate}},
		},
		NetworkMode:   "bridge",
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled},
		CapDrop:       []string{"ALL"},
		CapAdd:        append([]string{}, installCaps...),
		SecurityOpt:   []string{"no-new-privileges:true"},
		Privileged:    false,
		IpcMode:       "private",
		LogConfig:     container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "20m", "max-file": "1"}},
		Resources: container.Resources{
			Memory:     p.MemoryLimitBytes,
			MemorySwap: p.MemoryLimitBytes,
			PidsLimit:  &pids,
		},
	}
	if p.CPULimitMillicores != nil {
		hc.Resources.NanoCPUs = *p.CPULimitMillicores * 1_000_000
	}
	return client.ContainerCreateOptions{
		Name: name,
		Config: &container.Config{
			Image:      p.Image,
			Entrypoint: cmd,
			Env:        sortedEnv(p.Env),
			User:       "0:0",
			WorkingDir: installDataPath,
			Labels: map[string]string{
				LabelManaged: "true", LabelWorkload: p.WorkloadID, LabelRole: RoleInstall, LabelWatchtower: "false",
				LabelNode: d.o.NodeID,
			},
		},
		HostConfig: hc,
	}
}

// removeInstallContainer force-removes a leftover install container (only if it is ours).
func (d *Driver) removeInstallContainer(ctx context.Context, name string) error {
	res, err := d.cli.ContainerInspect(ctx, name, client.ContainerInspectOptions{})
	if err != nil {
		if cerrdefs.IsNotFound(err) {
			return nil
		}
		return runtimeErr("inspect install container", err)
	}
	if res.Container.Config == nil || res.Container.Config.Labels[LabelManaged] != "true" || res.Container.Config.Labels[LabelRole] != RoleInstall {
		return protocol.Errorf(protocol.CodeConflict, "container %s exists but is not a BlockForge install container", name)
	}
	if _, err := d.cli.ContainerRemove(ctx, res.Container.ID, client.ContainerRemoveOptions{Force: true}); err != nil && !cerrdefs.IsNotFound(err) {
		return runtimeErr("remove install container", err)
	}
	return nil
}

// cleanupStaleInstalls removes install containers left behind by a previous run of THIS agent (node
// label): another agent sharing the Docker daemon may have installs in flight.
func (d *Driver) cleanupStaleInstalls(ctx context.Context) {
	res, err := d.cli.ContainerList(ctx, client.ContainerListOptions{All: true,
		Filters: client.Filters{}.Add("label", LabelManaged+"=true").Add("label", LabelRole+"="+RoleInstall).
			Add("label", LabelNode+"="+d.o.NodeID)})
	if err != nil {
		return
	}
	for _, c := range res.Items {
		d.o.Logger.Warn("removing install container left by a previous agent run", "container", c.ID[:12])
		_, _ = d.cli.ContainerRemove(ctx, c.ID, client.ContainerRemoveOptions{Force: true})
	}
}

// Install runs a one-shot install container for a stopped workload.
func (d *Driver) Install(ctx context.Context, p *protocol.WorkloadInstallPayload, progress ProgressFunc) (*protocol.WorkloadInstallResult, error) {
	if !d.o.Images.Allowed(p.Image) {
		return nil, protocol.Errorf(protocol.CodeImageNotAllowed, "image %q is not allowed by this agent's image allowlist", p.Image)
	}
	id := p.WorkloadID
	w := d.state(id)

	// Claim the workload: no other install, and the workload container must not run.
	w.opMu.Lock()
	w.mu.Lock()
	if w.installing {
		w.mu.Unlock()
		w.opMu.Unlock()
		return nil, protocol.RetryableErrorf(protocol.CodeBusy, "an install is already running for this workload")
	}
	pending := w.pendingRestart
	w.mu.Unlock()
	c, err := d.inspectManaged(ctx, id)
	if err != nil {
		w.opMu.Unlock()
		return nil, err
	}
	if pending || (c != nil && c.State != nil && (c.State.Running || c.State.Restarting || c.State.Paused)) {
		w.opMu.Unlock()
		return nil, protocol.RetryableErrorf(protocol.CodeBusy, "the workload is running; stop it before installing")
	}
	w.mu.Lock()
	w.installing = true
	w.mu.Unlock()
	w.opMu.Unlock()
	defer func() {
		w.mu.Lock()
		w.installing = false
		w.mu.Unlock()
	}()

	if err := d.o.Sandbox.EnsureDataDir(id); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "prepare data directory: %v", err)
	}
	scriptDir := filepath.Join(d.base(id), "install")
	if err := os.MkdirAll(scriptDir, 0o755); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "prepare install dir: %v", err)
	}
	_ = os.Chmod(scriptDir, 0o755)
	defer os.RemoveAll(scriptDir)
	script := strings.ReplaceAll(p.Script, "\r\n", "\n")
	if err := fileutil.WriteFileAtomic(filepath.Join(scriptDir, "install.sh"), []byte(script), 0o644); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "write install script: %v", err)
	}
	if err := d.ensureImage(ctx, p.Image, progress); err != nil {
		return nil, err
	}
	name := InstallContainerName(id)
	if err := d.removeInstallContainer(ctx, name); err != nil {
		return nil, err
	}
	cmd := []string{p.Entrypoint, "-c", installWrapper(p.Entrypoint, d.o.UID, d.o.GID, true)}
	created, err := d.cli.ContainerCreate(ctx, d.installCreateOptions(p, scriptDir, name, cmd))
	if err != nil {
		return nil, runtimeErr("create install container", err)
	}
	cid := created.ID
	// The container is removed whatever happens (background context: also after cancellation).
	defer func() {
		rctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		_, _ = d.cli.ContainerRemove(rctx, cid, client.ContainerRemoveOptions{Force: true})
	}()

	d.o.Logs.ResetSource(id, protocol.LogSourceInstall)
	if progress != nil {
		progress("install", "running install script in "+p.Image, nil)
	}
	start := time.Now()
	if _, err := d.cli.ContainerStart(ctx, cid, client.ContainerStartOptions{}); err != nil {
		return nil, runtimeErr("start install container", err)
	}
	var follow sync.WaitGroup
	follow.Add(1)
	go func() {
		defer follow.Done()
		d.followInstallLogs(context.WithoutCancel(ctx), id, cid)
	}()

	exited := d.waitNotRunning(ctx, cid, time.Duration(p.TimeoutMs)*time.Millisecond)
	res := &protocol.WorkloadInstallResult{ExitCode: -1}
	if !exited {
		res.TimedOut = ctx.Err() == nil
		kctx, kcancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, _ = d.cli.ContainerKill(kctx, cid, client.ContainerKillOptions{Signal: "SIGKILL"})
		d.waitNotRunning(kctx, cid, 25*time.Second)
		kcancel()
	}
	res.DurationMs = time.Since(start).Milliseconds()
	ictx, icancel := context.WithTimeout(context.Background(), 30*time.Second)
	ins, ierr := d.cli.ContainerInspect(ictx, cid, client.ContainerInspectOptions{})
	icancel()
	oom := false
	if ierr == nil && ins.Container.State != nil {
		res.ExitCode = ins.Container.State.ExitCode
		oom = ins.Container.State.OOMKilled
	}
	follow.Wait()
	d.o.Logs.Flush()

	// A killed wrapper never reached its chown: hand the data back in a short follow-up container.
	if res.TimedOut || oom || ierr != nil {
		if err := d.fixInstallOwnership(p, scriptDir); err != nil {
			d.o.Logger.Error("could not restore data ownership after install", "workload", id, "err", err)
			d.o.Emit(protocol.EventAgentWarning, protocol.AgentWarningEvent{Code: "INSTALL_OWNERSHIP",
				Message: fmt.Sprintf("workload %s: data ownership could not be restored after the install was killed", id)})
		}
	}
	if ctx.Err() != nil && !res.TimedOut {
		return nil, ctx.Err()
	}
	res.LogTail = []string{}
	if lines, ok := d.o.Logs.TailSource(id, protocol.LogSourceInstall, installLogTail, -1); ok {
		for _, l := range lines {
			res.LogTail = append(res.LogTail, l.Line)
		}
	}
	return res, nil
}

func (d *Driver) followInstallLogs(ctx context.Context, id, cid string) {
	rc, err := d.cli.ContainerLogs(ctx, cid, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true, Follow: true, Timestamps: true})
	if err != nil {
		d.o.Logger.Warn("follow install logs", "workload", id, "err", err)
		return
	}
	defer rc.Close()
	mk := func(stream string) *logs.LineWriter {
		return logs.NewLineWriter(protocol.LogLineMaxBytes+64, func(line string) {
			ts, text := splitTimestamp(line)
			d.o.Logs.IngestSource(id, protocol.LogSourceInstall, protocol.LogLine{TS: ts, Stream: stream, Line: text})
		})
	}
	out, errw := mk("stdout"), mk("stderr")
	_, _ = stdcopy.StdCopy(out, errw, rc)
	out.Flush()
	errw.Flush()
}

// fixInstallOwnership runs `chown -R uid:gid /mnt/server` with the install image (no script).
func (d *Driver) fixInstallOwnership(p *protocol.WorkloadInstallPayload, scriptDir string) error {
	ctx, cancel := context.WithTimeout(context.Background(), ownershipFixWindow)
	defer cancel()
	name := InstallContainerName(p.WorkloadID) + "-chown"
	if err := d.removeInstallContainer(ctx, name); err != nil {
		return err
	}
	cmd := []string{p.Entrypoint, "-c", installWrapper(p.Entrypoint, d.o.UID, d.o.GID, false)}
	opts := d.installCreateOptions(p, scriptDir, name, cmd)
	opts.HostConfig.NetworkMode = "none"
	created, err := d.cli.ContainerCreate(ctx, opts)
	if err != nil {
		return err
	}
	defer func() {
		rctx, rcancel := context.WithTimeout(context.Background(), time.Minute)
		defer rcancel()
		_, _ = d.cli.ContainerRemove(rctx, created.ID, client.ContainerRemoveOptions{Force: true})
	}()
	if _, err := d.cli.ContainerStart(ctx, created.ID, client.ContainerStartOptions{}); err != nil {
		return err
	}
	if !d.waitNotRunning(ctx, created.ID, ownershipFixWindow) {
		return errors.New("ownership fix timed out")
	}
	ins, err := d.cli.ContainerInspect(ctx, created.ID, client.ContainerInspectOptions{})
	if err != nil {
		return err
	}
	if ins.Container.State != nil && ins.Container.State.ExitCode != 0 {
		return fmt.Errorf("chown exited with %d", ins.Container.State.ExitCode)
	}
	return nil
}
