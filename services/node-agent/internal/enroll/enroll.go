// Package enroll implements `blockforge-agent enroll` (agent-protocol.md §2).
package enroll

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"time"

	"github.com/blockforge/node-agent/internal/auth"
	"github.com/blockforge/node-agent/internal/config"
	"github.com/blockforge/node-agent/internal/facts"
	"github.com/blockforge/node-agent/internal/protocol"
	"github.com/blockforge/node-agent/internal/version"
)

// TokenPattern is ENROLLMENT_TOKEN_PATTERN from envelope.ts.
var TokenPattern = regexp.MustCompile(`^bfe_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$`)

// Options are the enroll flags.
type Options struct {
	URL               string
	Token             string
	NodeName          string
	ConfigDir         string
	DataRoot          string
	CAFile            string
	InsecureAllowHTTP bool
	WorkloadUID       int
	WorkloadGID       int
	DockerHost        string
	Force             bool
	// HTTPClient overrides the client (tests).
	HTTPClient *http.Client
	// Facts overrides fact collection (tests).
	Facts func(ctx context.Context, dataRoot string) protocol.NodeFacts
}

// DefaultWorkloadIDs picks 1000:1000 when running as root, otherwise the agent's own uid/gid so a
// non-root agent can manage files the workload owns without chown.
func DefaultWorkloadIDs() (int, int) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		return 1000, 1000
	}
	return os.Geteuid(), os.Getegid()
}

// Run enrolls the node and persists agent.key + agent.json (both 0600).
func Run(ctx context.Context, o Options) (*config.Config, error) {
	if !TokenPattern.MatchString(o.Token) {
		return nil, errors.New("invalid enrollment token format (expected bfe_<16 hex>_<43 base64url>)")
	}
	base, err := config.ValidateControlPlaneURL(o.URL, o.InsecureAllowHTTP)
	if err != nil {
		return nil, err
	}
	if len(o.NodeName) > 80 {
		return nil, errors.New("--name must be at most 80 characters")
	}
	if o.DataRoot == "" {
		o.DataRoot = config.DefaultDataRoot()
	}
	if !filepath.IsAbs(o.DataRoot) {
		return nil, errors.New("--data-root must be an absolute path")
	}
	if o.WorkloadUID == 0 && o.WorkloadGID == 0 {
		o.WorkloadUID, o.WorkloadGID = DefaultWorkloadIDs()
	}
	if o.WorkloadUID <= 0 || o.WorkloadGID <= 0 {
		return nil, errors.New("workload uid/gid must be unprivileged (> 0)")
	}
	cfgPath := filepath.Join(o.ConfigDir, config.ConfigFile)
	if _, err := os.Stat(cfgPath); err == nil && !o.Force {
		return nil, fmt.Errorf("%s already exists (node already enrolled); use --force to re-enroll", cfgPath)
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(o.ConfigDir, 0o700); err != nil {
		return nil, fmt.Errorf("create config dir: %w", err)
	}
	if err := os.MkdirAll(o.DataRoot, 0o755); err != nil {
		return nil, fmt.Errorf("create data root: %w", err)
	}
	key, err := auth.GenerateKey()
	if err != nil {
		return nil, err
	}
	collect := o.Facts
	if collect == nil {
		collect = func(ctx context.Context, dataRoot string) protocol.NodeFacts {
			return (&facts.Collector{DataRoot: dataRoot, ExcludeIfaces: config.DefaultNetIfaceExclude}).Collect(ctx)
		}
	}
	fctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	nf := collect(fctx, o.DataRoot)
	cancel()
	req := protocol.EnrollRequest{
		Token: o.Token, PublicKey: auth.PublicKeyB64(key), AgentVersion: version.Version,
		ProtocolVersion: protocol.ProtocolVersion, Facts: nf, NodeName: o.NodeName,
	}
	body, _ := json.Marshal(req)
	client := o.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, config.Endpoint(base, "/agent/v1/enroll"), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("User-Agent", "BlockForge-Agent/"+version.Version)
	resp, err := client.Do(hreq)
	if err != nil {
		return nil, fmt.Errorf("enroll request failed: %w", err)
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		var apiErr struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(rb, &apiErr) == nil && apiErr.Error.Code != "" {
			return nil, fmt.Errorf("enrollment rejected (HTTP %d %s): %s", resp.StatusCode, apiErr.Error.Code, apiErr.Error.Message)
		}
		return nil, fmt.Errorf("enrollment rejected (HTTP %d)", resp.StatusCode)
	}
	var er protocol.EnrollResponse
	if err := json.Unmarshal(rb, &er); err != nil {
		return nil, fmt.Errorf("invalid enrollment response: %w", err)
	}
	if !protocol.IsUUID(er.NodeID) {
		return nil, errors.New("invalid enrollment response: nodeId")
	}
	if _, err := auth.ParsePublicKeyB64(er.ControlPlaneSigningKey); err != nil {
		return nil, fmt.Errorf("invalid enrollment response: %w", err)
	}
	cfg := &config.Config{
		NodeID: er.NodeID, NodeName: o.NodeName, ControlPlaneURL: base.String(),
		ControlPlaneSigningKey: er.ControlPlaneSigningKey, InsecureAllowHTTP: o.InsecureAllowHTTP, CAFile: o.CAFile,
		DataRoot: o.DataRoot, WorkloadUID: o.WorkloadUID, WorkloadGID: o.WorkloadGID, DockerHost: o.DockerHost,
		HeartbeatIntervalMs: er.HeartbeatIntervalMs, MetricsIntervalMs: er.MetricsIntervalMs,
	}
	cfg.ApplyDefaults()
	// Key first: a config without its key is unusable, a key without config is just re-enrollable.
	if err := auth.SaveKey(filepath.Join(o.ConfigDir, config.KeyFile), key); err != nil {
		return nil, fmt.Errorf("save key: %w", err)
	}
	_ = os.Remove(filepath.Join(o.ConfigDir, config.NextKeyFile))
	if err := cfg.Save(o.ConfigDir); err != nil {
		return nil, fmt.Errorf("save config: %w", err)
	}
	return cfg, nil
}
