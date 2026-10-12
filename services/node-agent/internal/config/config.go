// Package config loads and persists the agent configuration (<configDir>/agent.json) and
// implements the agent-side policies: control-plane URL rules, image allowlist and download
// host allowlist.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/blockforge/node-agent/internal/fileutil"
	"github.com/blockforge/node-agent/internal/protocol"
)

// File names inside the config directory.
const (
	ConfigFile  = "agent.json"
	KeyFile     = "agent.key"
	NextKeyFile = "agent.key.next"
	JournalFile = "commands.journal"
	// SftpHostKeyFile is the SFTP server's Ed25519 host key (OpenSSH PEM, 0600).
	SftpHostKeyFile = "sftp_host_ed25519_key"
)

// DefaultImageAllowlist is applied when the config does not specify one (agent-protocol.md §6):
// Temurin for built-in Minecraft templates and the yolks/installers images community eggs use.
var DefaultImageAllowlist = []string{
	"eclipse-temurin:*",
	"ghcr.io/pterodactyl/yolks:*",
	"ghcr.io/pterodactyl/installers:*",
	"ghcr.io/parkervcp/yolks:*",
	"ghcr.io/parkervcp/installers:*",
}

// legacyDefaultImageAllowlist is what agents ≤ 0.1.0 wrote into agent.json at enrollment. A config
// still holding exactly this list is treated as "defaults" and upgraded on load.
var legacyDefaultImageAllowlist = []string{"eclipse-temurin:*"}

// DefaultArtifactCacheMaxBytes caps <dataRoot>/cache/artifacts (LRU eviction above it).
const DefaultArtifactCacheMaxBytes = 10 << 30

// SFTPConfig configures the built-in SFTP server.
type SFTPConfig struct {
	// Enabled defaults to true when omitted.
	Enabled *bool  `json:"enabled,omitempty"`
	Listen  string `json:"listen,omitempty"`
}

// On reports whether the SFTP server should run.
func (s SFTPConfig) On() bool { return s.Enabled == nil || *s.Enabled }

// DefaultDownloadHosts is the artifact.fetch host allowlist default.
var DefaultDownloadHosts = []string{
	"piston-meta.mojang.com", "piston-data.mojang.com", "launcher.mojang.com",
	"fill.papermc.io", "fill-data.papermc.io", "api.papermc.io",
	"api.purpurmc.org",
	"meta.fabricmc.net", "maven.fabricmc.net",
	"maven.minecraftforge.net", "files.minecraftforge.net",
	"maven.neoforged.net",
	"cdn.modrinth.com", "api.modrinth.com",
}

// DefaultNetIfaceExclude are interface-name patterns (path.Match syntax) skipped in network
// facts/metrics: loopback, container veths and bridges, common CNI devices.
var DefaultNetIfaceExclude = []string{
	"lo", "veth*", "docker*", "br-*", "virbr*", "cni*", "flannel*", "cali*", "vxlan*",
	"tunl*", "kube-*", "cilium*", "lxc*", "dummy*",
}

// Config is the persisted agent configuration.
type Config struct {
	NodeID                 string `json:"nodeId"`
	NodeName               string `json:"nodeName,omitempty"`
	ControlPlaneURL        string `json:"controlPlaneUrl"`
	ControlPlaneSigningKey string `json:"controlPlaneSigningKey"`
	InsecureAllowHTTP      bool   `json:"insecureAllowHttp,omitempty"`
	CAFile                 string `json:"caFile,omitempty"`

	DataRoot    string `json:"dataRoot"`
	WorkloadUID int    `json:"workloadUid"`
	WorkloadGID int    `json:"workloadGid"`

	ImageAllowlist        []string `json:"imageAllowlist"`
	DownloadHostAllowlist []string `json:"downloadHostAllowlist"`
	NetIfaceExclude       []string `json:"netIfaceExclude,omitempty"`

	// DockerHost overrides DOCKER_HOST (e.g. unix:///run/user/1000/docker.sock for rootless).
	DockerHost string `json:"dockerHost,omitempty"`

	HeartbeatIntervalMs   int64 `json:"heartbeatIntervalMs,omitempty"`
	MetricsIntervalMs     int64 `json:"metricsIntervalMs,omitempty"`
	MaxConcurrentCommands int   `json:"maxConcurrentCommands,omitempty"`

	ArtifactCacheMaxBytes int64      `json:"artifactCacheMaxBytes,omitempty"`
	SFTP                  SFTPConfig `json:"sftp"`
}

// DefaultConfigDir is the platform default config directory, overridable with BLOCKFORGE_CONFIG_DIR.
func DefaultConfigDir() string {
	if d := os.Getenv("BLOCKFORGE_CONFIG_DIR"); d != "" {
		return d
	}
	if runtime.GOOS == "windows" {
		if pd := os.Getenv("ProgramData"); pd != "" {
			return filepath.Join(pd, "BlockForge", "agent")
		}
		return `C:\ProgramData\BlockForge\agent`
	}
	return "/etc/blockforge"
}

// DefaultDataRoot is the default workload data root, overridable with BLOCKFORGE_DATA_ROOT.
func DefaultDataRoot() string {
	if d := os.Getenv("BLOCKFORGE_DATA_ROOT"); d != "" {
		return d
	}
	if runtime.GOOS == "windows" {
		if pd := os.Getenv("ProgramData"); pd != "" {
			return filepath.Join(pd, "BlockForge", "data")
		}
	}
	return "/var/lib/blockforge"
}

// ApplyDefaults fills unset fields.
func (c *Config) ApplyDefaults() {
	if c.DataRoot == "" {
		c.DataRoot = DefaultDataRoot()
	}
	if len(c.ImageAllowlist) == 0 || equalStrings(c.ImageAllowlist, legacyDefaultImageAllowlist) {
		c.ImageAllowlist = append([]string(nil), DefaultImageAllowlist...)
	}
	if c.ArtifactCacheMaxBytes <= 0 {
		c.ArtifactCacheMaxBytes = DefaultArtifactCacheMaxBytes
	}
	if c.SFTP.Listen == "" {
		c.SFTP.Listen = "0.0.0.0:2022"
	}
	if len(c.DownloadHostAllowlist) == 0 {
		c.DownloadHostAllowlist = append([]string(nil), DefaultDownloadHosts...)
	}
	if c.NetIfaceExclude == nil {
		c.NetIfaceExclude = append([]string(nil), DefaultNetIfaceExclude...)
	}
	if c.HeartbeatIntervalMs <= 0 {
		c.HeartbeatIntervalMs = 15000
	}
	if c.MetricsIntervalMs <= 0 {
		c.MetricsIntervalMs = 5000
	}
	if c.MaxConcurrentCommands <= 0 {
		c.MaxConcurrentCommands = 8
	}
}

// Validate checks invariants of a loaded configuration.
func (c *Config) Validate() error {
	if !protocol.IsUUID(c.NodeID) {
		return errors.New("config: nodeId is not a UUID (is the agent enrolled?)")
	}
	if _, err := ValidateControlPlaneURL(c.ControlPlaneURL, c.InsecureAllowHTTP); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if b, err := protocol.B64.DecodeString(c.ControlPlaneSigningKey); err != nil || len(b) != 32 {
		return errors.New("config: controlPlaneSigningKey must be a base64url Ed25519 public key")
	}
	if !filepath.IsAbs(c.DataRoot) {
		return errors.New("config: dataRoot must be an absolute path")
	}
	if c.WorkloadUID <= 0 || c.WorkloadGID <= 0 {
		return errors.New("config: workloadUid/workloadGid must be unprivileged (> 0)")
	}
	if _, err := NewImageAllowlist(c.ImageAllowlist); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if c.SFTP.On() {
		if _, port, err := net.SplitHostPort(c.SFTP.Listen); err != nil || port == "" {
			return fmt.Errorf("config: sftp.listen %q must be host:port", c.SFTP.Listen)
		}
	}
	return nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Load reads <dir>/agent.json, applies defaults and validates it.
func Load(dir string) (*Config, error) {
	b, err := os.ReadFile(filepath.Join(dir, ConfigFile))
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", ConfigFile, err)
	}
	c.ApplyDefaults()
	// Deployment overrides (compose files): not persisted.
	if v := os.Getenv("BLOCKFORGE_SFTP_LISTEN"); v != "" {
		c.SFTP.Listen = v
	}
	switch strings.ToLower(os.Getenv("BLOCKFORGE_SFTP_ENABLED")) {
	case "false", "0", "no", "off":
		off := false
		c.SFTP.Enabled = &off
	case "true", "1", "yes", "on":
		on := true
		c.SFTP.Enabled = &on
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

// Save writes <dir>/agent.json atomically with mode 0600.
func (c *Config) Save(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return fileutil.WriteFileAtomic(filepath.Join(dir, ConfigFile), append(b, '\n'), 0o600)
}

// ValidateControlPlaneURL enforces https, or http only for the development loopback hosts when
// allowInsecure is set (agent-protocol.md §2 step 3). Returns the normalised base URL.
func ValidateControlPlaneURL(raw string, allowInsecure bool) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid control-plane URL %q", raw)
	}
	if u.User != nil {
		return nil, errors.New("control-plane URL must not contain credentials")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("control-plane URL must not contain a query or fragment")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !allowInsecure {
			return nil, errors.New("refusing http:// control-plane URL (use https, or --insecure-allow-http for local development)")
		}
		host := strings.ToLower(u.Hostname())
		allowed := false
		for _, h := range protocol.InsecureHTTPAllowedHosts {
			if host == h {
				allowed = true
			}
		}
		if !allowed {
			return nil, fmt.Errorf("--insecure-allow-http only permits %s, not %q",
				strings.Join(protocol.InsecureHTTPAllowedHosts, ", "), u.Hostname())
		}
	default:
		return nil, fmt.Errorf("unsupported control-plane URL scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/")
	return u, nil
}

// WebSocketURL derives ws(s)://host/base/agent/v1/connect from the control-plane base URL.
func WebSocketURL(base *url.URL) string {
	u := *base
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = base.Path + "/agent/v1/connect"
	return u.String()
}

// Endpoint joins a path onto the control-plane base URL.
func Endpoint(base *url.URL, p string) string {
	u := *base
	u.Path = base.Path + p
	return u.String()
}
