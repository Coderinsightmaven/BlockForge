package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/blockforge/node-agent/internal/artifact"
	"github.com/blockforge/node-agent/internal/auth"
	"github.com/blockforge/node-agent/internal/config"
	"github.com/blockforge/node-agent/internal/facts"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/journal"
	"github.com/blockforge/node-agent/internal/jvmprobe"
	"github.com/blockforge/node-agent/internal/logs"
	"github.com/blockforge/node-agent/internal/metrics"
	"github.com/blockforge/node-agent/internal/protocol"
	"github.com/blockforge/node-agent/internal/transport"
	"github.com/blockforge/node-agent/internal/version"
	"github.com/blockforge/node-agent/internal/workload"
)

// Capabilities advertised in hello.
var Capabilities = []string{"docker", "jvm-probe", "slp", "fs.sandbox", "fs.extract", "fs.transfer",
	"artifact.fetch", "logs", "console", "restart-policy", "credentials.rotate.staged"}

// Agent is a running node agent.
type Agent struct {
	cfg       *config.Config
	configDir string
	cpURL     *url.URL
	cpKey     ed25519.PublicKey
	log       *slog.Logger
	http      *http.Client

	keyMu   sync.Mutex
	key     ed25519.PrivateKey
	nextKey ed25519.PrivateKey

	outbox    *transport.Outbox
	client    *transport.Client
	journal   *journal.Journal
	exec      *Executor
	sandbox   *fsops.Sandbox
	logs      *logs.Manager
	driver    *workload.Driver
	fetcher   *artifact.Fetcher
	transfers *artifact.Transfers
	facts     *facts.Collector
	host      *metrics.HostSampler
	wl        *metrics.WorkloadSampler

	approved  atomic.Bool
	metricsMs atomic.Int64
	metricsCh chan struct{}

	// FetcherTransport overrides the artifact transport (tests).
	FetcherTransport http.RoundTripper
}

// CPHTTPClient builds the control-plane HTTP client (TLS ≥ 1.2, optional pinned CA, HTTP/1.1 so the
// WebSocket upgrade works).
func CPHTTPClient(caFile string) (*http.Client, error) {
	tlsConf := &tls.Config{MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}}
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("read CA file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("CA file contains no PEM certificates")
		}
		tlsConf.RootCAs = pool
	}
	t := artifact.DefaultTransport(tlsConf)
	t.ForceAttemptHTTP2 = false
	t.DisableCompression = false
	return &http.Client{Transport: t}, nil
}

// New loads keys and builds all components (nothing runs until Run).
func New(cfg *config.Config, configDir string, log *slog.Logger) (*Agent, error) {
	cpURL, err := config.ValidateControlPlaneURL(cfg.ControlPlaneURL, cfg.InsecureAllowHTTP)
	if err != nil {
		return nil, err
	}
	cpKey, err := auth.ParsePublicKeyB64(cfg.ControlPlaneSigningKey)
	if err != nil {
		return nil, err
	}
	key, err := auth.LoadKey(filepath.Join(configDir, config.KeyFile))
	if err != nil {
		return nil, fmt.Errorf("load agent key: %w", err)
	}
	a := &Agent{cfg: cfg, configDir: configDir, cpURL: cpURL, cpKey: cpKey, log: log, key: key, metricsCh: make(chan struct{}, 1)}
	if next, err := auth.LoadKey(filepath.Join(configDir, config.NextKeyFile)); err == nil {
		a.nextKey = next
	}
	a.metricsMs.Store(cfg.MetricsIntervalMs)
	if a.http, err = CPHTTPClient(cfg.CAFile); err != nil {
		return nil, err
	}
	return a, nil
}

func (a *Agent) authHeader() (string, bool, error) {
	a.keyMu.Lock()
	key, usingNext := a.key, false
	if a.nextKey != nil {
		key, usingNext = a.nextKey, true
	}
	a.keyMu.Unlock()
	h, _, err := auth.NewToken(key, a.cfg.NodeID, time.Now(), auth.DefaultTokenTTL)
	return h, usingNext, err
}

// currentAuth signs with the active key (HTTP transfer endpoints).
func (a *Agent) currentAuth() (string, error) {
	a.keyMu.Lock()
	key := a.key
	a.keyMu.Unlock()
	h, _, err := auth.NewToken(key, a.cfg.NodeID, time.Now(), auth.DefaultTokenTTL)
	return h, err
}

func (a *Agent) onAuthRejected(usingNext bool) {
	if !usingNext {
		a.log.Error("control plane rejected the agent key (node revoked or not enrolled?)")
		return
	}
	a.keyMu.Lock()
	a.nextKey = nil
	a.keyMu.Unlock()
	if err := os.Remove(filepath.Join(a.configDir, config.NextKeyFile)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		a.log.Error("discard staged key", "err", err)
	}
	a.log.Warn("staged key rejected by control plane; discarded, falling back to the current key")
}

func (a *Agent) onWelcome(w protocol.WelcomeFrame, usingNext bool) {
	if w.NodeID != a.cfg.NodeID {
		a.log.Error("welcome for a different node id; treating node as unapproved", "got", w.NodeID)
		a.approved.Store(false)
		return
	}
	a.approved.Store(w.Approved)
	if w.MetricsIntervalMs > 0 && w.MetricsIntervalMs != a.metricsMs.Load() {
		a.metricsMs.Store(w.MetricsIntervalMs)
		select {
		case a.metricsCh <- struct{}{}:
		default:
		}
	}
	if usingNext {
		a.keyMu.Lock()
		next := a.nextKey
		a.keyMu.Unlock()
		if next == nil {
			return
		}
		if err := auth.SaveKey(filepath.Join(a.configDir, config.KeyFile), next); err != nil {
			a.log.Error("promote staged key", "err", err)
			return
		}
		_ = os.Remove(filepath.Join(a.configDir, config.NextKeyFile))
		a.keyMu.Lock()
		a.key, a.nextKey = next, nil
		a.keyMu.Unlock()
		a.log.Info("credential rotation complete: staged key promoted")
	}
}

// rotate stages a next key and returns the possession proof (§3.1).
func (a *Agent) rotate(cmdID string) (*protocol.CredentialsRotateResult, error) {
	next, err := auth.GenerateKey()
	if err != nil {
		return nil, err
	}
	if err := auth.SaveKey(filepath.Join(a.configDir, config.NextKeyFile), next); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "persist staged key: %v", err)
	}
	a.keyMu.Lock()
	a.nextKey = next
	a.keyMu.Unlock()
	return &protocol.CredentialsRotateResult{PublicKey: auth.PublicKeyB64(next), Proof: auth.RotationProof(next, a.cfg.NodeID, cmdID)}, nil
}

func (a *Agent) push(class transport.Class, kind string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		a.log.Error("encode frame", "kind", kind, "err", err)
		return
	}
	a.outbox.Push(transport.Item{Class: class, Kind: kind, Data: b})
}

func (a *Agent) emitEvent(event string, data any) {
	b, err := json.Marshal(data)
	if err != nil {
		return
	}
	a.push(transport.High, protocol.FrameEvent, protocol.EventFrame{T: protocol.FrameEvent, TS: time.Now().UnixMilli(), Event: event, Data: b})
}

func (a *Agent) hello(ctx context.Context) ([]byte, error) {
	fctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	f := a.facts.Collect(fctx)
	wl, err := a.driver.List(fctx)
	if err != nil {
		wl = []protocol.WorkloadStatus{}
	}
	return json.Marshal(protocol.HelloFrame{
		T: protocol.FrameHello, AgentVersion: version.Version, ProtocolVersion: protocol.ProtocolVersion,
		TS: time.Now().UnixMilli(), Facts: f, Capabilities: Capabilities, Workloads: wl,
	})
}

// Setup builds components; split from Run so tests can inject pieces.
func (a *Agent) Setup(ctx context.Context) error {
	var err error
	if a.journal, err = journal.Open(filepath.Join(a.configDir, config.JournalFile), time.Now()); err != nil {
		return fmt.Errorf("open command journal: %w", err)
	}
	images, err := config.NewImageAllowlist(a.cfg.ImageAllowlist)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(a.cfg.DataRoot, "servers"), 0o755); err != nil {
		return fmt.Errorf("create data root: %w", err)
	}
	a.sandbox = fsops.NewSandbox(a.cfg.DataRoot, a.cfg.WorkloadUID, a.cfg.WorkloadGID)
	if !a.sandbox.Chown && runtime.GOOS != "windows" && os.Geteuid() != a.cfg.WorkloadUID {
		a.log.Warn("agent runs as a different non-root user than the workloads; files it creates will not be owned by the workload user",
			"agentUid", os.Geteuid(), "workloadUid", a.cfg.WorkloadUID)
	}
	a.outbox = transport.NewOutbox(4096, 256, 24)
	a.logs = logs.NewManager(func(f protocol.LogsFrame) {
		b, err := json.Marshal(f)
		if err != nil {
			return
		}
		a.outbox.Push(transport.Item{Class: transport.Logs, Kind: protocol.FrameLogs, Data: b, WorkloadID: f.WorkloadID, Lines: len(f.Lines)})
	})
	a.outbox.OnLogsDropped = a.logs.AddDropped
	if a.driver, err = workload.NewDriver(workload.Options{
		DataRoot: a.cfg.DataRoot, DockerHost: a.cfg.DockerHost, UID: a.cfg.WorkloadUID, GID: a.cfg.WorkloadGID,
		Images: images, Sandbox: a.sandbox, Logs: a.logs, Emit: a.emitEvent, Logger: a.log, ProbeJar: jvmprobe.Jar(),
	}); err != nil {
		return fmt.Errorf("docker client: %w", err)
	}
	a.fetcher = &artifact.Fetcher{Hosts: config.NewHostAllowlist(a.cfg.DownloadHostAllowlist), Transport: a.FetcherTransport}
	a.transfers = &artifact.Transfers{
		Client: a.http,
		URL:    func(id string) string { return config.Endpoint(a.cpURL, "/agent/v1/transfers/"+id) },
		Auth:   a.currentAuth,
	}
	a.facts = &facts.Collector{DataRoot: a.cfg.DataRoot, ExcludeIfaces: a.cfg.NetIfaceExclude, Docker: a.driver.Client()}
	a.host = metrics.NewHostSampler(ctx, a.cfg.DataRoot, a.cfg.NetIfaceExclude)
	a.wl = metrics.NewWorkloadSampler(a.driver, a.sandbox, a.log)

	a.exec = NewExecutor(ctx, a.cfg.MaxConcurrentCommands)
	a.exec.NodeID, a.exec.CPKey, a.exec.Journal, a.exec.Log = a.cfg.NodeID, a.cpKey, a.journal, a.log
	a.exec.Send = a.outbox.Push
	a.exec.Approved = a.approved.Load
	a.exec.Timeout = commandTimeout
	a.exec.Handlers = a.handlers()

	a.client = transport.New(transport.Options{
		URL: config.WebSocketURL(a.cpURL), HTTPClient: a.http, Auth: a.authHeader,
		OnAuthRejected: a.onAuthRejected, Hello: a.hello, OnWelcome: a.onWelcome,
		OnCommand: a.exec.Handle, Outbox: a.outbox, Logger: a.log,
		OnDisconnect: func(error) { a.outbox.DropClass(transport.Metrics) },
	})
	return nil
}

// Run starts every loop and blocks until ctx is cancelled.
func (a *Agent) Run(ctx context.Context) error {
	if a.exec == nil {
		if err := a.Setup(ctx); err != nil {
			return err
		}
	}
	defer a.journal.Close()
	defer a.driver.Close()
	var wg sync.WaitGroup
	start := func(fn func(context.Context)) {
		wg.Add(1)
		go func() { defer wg.Done(); fn(ctx) }()
	}
	start(a.logs.Run)
	start(a.driver.Run)
	start(a.exec.Janitor)
	start(a.metricsLoop)
	a.wl.RunBackground(ctx)
	err := a.client.Run(ctx)
	a.exec.Wait(10 * time.Second)
	wg.Wait()
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func (a *Agent) metricsLoop(ctx context.Context) {
	interval := func() time.Duration {
		ms := a.metricsMs.Load()
		if ms < 1000 {
			ms = 1000
		}
		return time.Duration(ms) * time.Millisecond
	}
	t := time.NewTicker(interval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.metricsCh:
			t.Reset(interval())
		case <-t.C:
			sctx, cancel := context.WithTimeout(ctx, interval())
			node, ok := a.host.Sample(sctx)
			wls := a.wl.Sample(sctx)
			cancel()
			if !ok {
				continue
			}
			a.push(transport.Metrics, protocol.FrameMetrics, protocol.MetricsFrame{T: protocol.FrameMetrics, TS: node.TS, Node: node, Workloads: wls})
		}
	}
}

// commandTimeout is the per-command execution deadline.
func commandTimeout(c *Command) time.Duration {
	switch p := c.Payload.(type) {
	case *protocol.NodeProbePayload:
		return time.Duration(p.TimeoutMs)*time.Millisecond + 5*time.Second
	case *protocol.WorkloadStopPayload:
		return time.Duration(p.TimeoutMs)*time.Millisecond + 90*time.Second
	}
	switch c.Type {
	case protocol.CmdWorkloadEnsure, protocol.CmdFsExtract, protocol.CmdArtifactFetch:
		return time.Hour
	case protocol.CmdFsTransferPush, protocol.CmdFsTransferPull:
		return 2 * time.Hour
	case protocol.CmdWorkloadRemove, protocol.CmdFsDu, protocol.CmdFsDelete:
		return 15 * time.Minute
	case protocol.CmdWorkloadStart, protocol.CmdWorkloadKill, protocol.CmdFsRead, protocol.CmdFsWrite:
		return 5 * time.Minute
	case protocol.CmdWorkloadConsole, protocol.CmdCredentialsRotate:
		return 30 * time.Second
	}
	return 2 * time.Minute
}
