// Command blockforge-agent is the BlockForge node agent.
//
//	blockforge-agent enroll --url <cp> --token <bfe_…> [--name] [--config-dir] [--data-root] [--ca-file] [--insecure-allow-http]
//	blockforge-agent run [--config-dir]
//	blockforge-agent version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/moby/moby/client"

	"github.com/blockforge/node-agent/internal/agent"
	"github.com/blockforge/node-agent/internal/config"
	"github.com/blockforge/node-agent/internal/enroll"
	"github.com/blockforge/node-agent/internal/facts"
	"github.com/blockforge/node-agent/internal/jvmprobe"
	"github.com/blockforge/node-agent/internal/protocol"
	"github.com/blockforge/node-agent/internal/version"
)

func usage(w io.Writer) {
	fmt.Fprintln(w, `Usage:
  blockforge-agent enroll --url <control-plane-url> --token <bfe_…> [--name NAME] [--config-dir DIR]
                          [--data-root DIR] [--ca-file PEM] [--insecure-allow-http]
                          [--workload-uid UID --workload-gid GID] [--docker-host URL] [--force]
  blockforge-agent run [--config-dir DIR] [--log-level debug|info|warn|error]
  blockforge-agent init-dirs --uid UID --gid GID DIR...   (one-shot, as root: create DIRs owned by UID:GID)
  blockforge-agent version`)
}

func main() {
	if len(os.Args) < 2 {
		usage(os.Stderr)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "enroll":
		err = cmdEnroll(os.Args[2:])
	case "run":
		err = cmdRun(os.Args[2:])
	case "init-dirs":
		err = cmdInitDirs(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Printf("blockforge-agent %s (commit %s, protocol %d, %s/%s, jvm-probe sha256 %s)\n",
			version.Version, version.Commit, protocol.ProtocolVersion, runtime.GOOS, runtime.GOARCH, jvmprobe.Sha256()[:12])
	case "help", "-h", "--help":
		usage(os.Stdout)
	default:
		usage(os.Stderr)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	if err := l.UnmarshalText([]byte(level)); err != nil {
		l = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: l}))
}

func dockerClient(host string) *client.Client {
	opts := []client.Opt{client.FromEnv, client.WithAPIVersionNegotiation()}
	if host != "" {
		opts = append(opts, client.WithHost(host))
	}
	cli, err := client.New(opts...)
	if err != nil {
		return nil
	}
	return cli
}

func cmdEnroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ContinueOnError)
	o := enroll.Options{}
	fs.StringVar(&o.URL, "url", "", "control-plane base URL (https://…)")
	fs.StringVar(&o.Token, "token", os.Getenv("BLOCKFORGE_ENROLL_TOKEN"), "enrollment token bfe_… (or BLOCKFORGE_ENROLL_TOKEN)")
	fs.StringVar(&o.NodeName, "name", "", "suggested node name")
	fs.StringVar(&o.ConfigDir, "config-dir", config.DefaultConfigDir(), "configuration directory")
	fs.StringVar(&o.DataRoot, "data-root", config.DefaultDataRoot(), "workload data root (absolute path)")
	fs.StringVar(&o.CAFile, "ca-file", "", "PEM CA bundle to pin for the control plane")
	fs.BoolVar(&o.InsecureAllowHTTP, "insecure-allow-http", false, "allow http:// for localhost/127.0.0.1/::1/host.docker.internal (development only)")
	fs.IntVar(&o.WorkloadUID, "workload-uid", 0, "UID workloads run as (default: 1000 as root, else the agent's uid)")
	fs.IntVar(&o.WorkloadGID, "workload-gid", 0, "GID workloads run as")
	fs.StringVar(&o.DockerHost, "docker-host", "", "Docker/Podman API endpoint (default DOCKER_HOST or the platform socket)")
	fs.BoolVar(&o.Force, "force", false, "overwrite an existing enrollment")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if o.URL == "" || o.Token == "" {
		usage(os.Stderr)
		return errors.New("--url and --token are required")
	}
	cli := dockerClient(o.DockerHost)
	o.Facts = func(ctx context.Context, dataRoot string) protocol.NodeFacts {
		c := &facts.Collector{DataRoot: dataRoot, ExcludeIfaces: config.DefaultNetIfaceExclude}
		if cli != nil {
			c.Docker = cli
		}
		return c.Collect(ctx)
	}
	if o.CAFile != "" {
		hc, err := agent.CPHTTPClient(o.CAFile)
		if err != nil {
			return err
		}
		o.HTTPClient = hc
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := enroll.Run(ctx, o)
	if err != nil {
		return err
	}
	fmt.Printf("enrolled: nodeId=%s controlPlane=%s configDir=%s dataRoot=%s workload=%d:%d\n",
		cfg.NodeID, cfg.ControlPlaneURL, o.ConfigDir, cfg.DataRoot, cfg.WorkloadUID, cfg.WorkloadGID)
	return nil
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	dir := fs.String("config-dir", config.DefaultConfigDir(), "configuration directory")
	level := fs.String("log-level", envOr("BLOCKFORGE_LOG_LEVEL", "info"), "log level")
	if err := fs.Parse(args); err != nil {
		return err
	}
	log := newLogger(*level)
	slog.SetDefault(log)
	cfg, err := config.Load(*dir)
	if err != nil {
		return fmt.Errorf("load config from %s: %w", *dir, err)
	}
	a, err := agent.New(cfg, *dir, log)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Info("blockforge-agent starting", "version", version.Version, "nodeId", cfg.NodeID,
		"controlPlane", cfg.ControlPlaneURL, "dataRoot", cfg.DataRoot, "workloadUid", cfg.WorkloadUID)
	err = a.Run(ctx)
	log.Info("blockforge-agent stopped")
	return err
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// cmdInitDirs creates directories (non-recursively chowning only the given paths) so a non-root
// agent container can own a freshly created bind-mounted data root. Intended for a one-shot init
// container running as root with only CAP_CHOWN.
func cmdInitDirs(args []string) error {
	fs := flag.NewFlagSet("init-dirs", flag.ContinueOnError)
	uid := fs.Int("uid", 1000, "owner uid")
	gid := fs.Int("gid", 1000, "owner gid")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *uid <= 0 || *gid <= 0 {
		return errors.New("--uid/--gid must be unprivileged (> 0)")
	}
	for _, d := range fs.Args() {
		if !filepath.IsAbs(d) || filepath.Clean(d) == string(filepath.Separator) {
			return fmt.Errorf("refusing %q: absolute, non-root paths only", d)
		}
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
		fi, err := os.Lstat(d)
		if err != nil {
			return err
		}
		if !fi.IsDir() {
			return fmt.Errorf("%s is not a directory", d)
		}
		if err := chownIfNeeded(d, fi, *uid, *gid); err != nil {
			return err
		}
		fmt.Printf("%s ready (owner %d:%d)\n", d, *uid, *gid)
	}
	return nil
}
