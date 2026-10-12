package agent

import (
	"context"
	"strconv"
	"time"

	"github.com/blockforge/node-agent/internal/denylist"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/metrics"
	"github.com/blockforge/node-agent/internal/minecraft"
	"github.com/blockforge/node-agent/internal/protocol"
)

type empty struct{}

func (a *Agent) withRoot(id string, fn func(*fsops.Root) (any, error)) (any, error) {
	return a.withRootDeny(id, nil, fn)
}

// withRootDeny opens the sandbox with the template denylist from the payload enforced.
func (a *Agent) withRootDeny(id string, deny []string, fn func(*fsops.Root) (any, error)) (any, error) {
	root, err := a.sandbox.Open(id)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return fn(root.WithDenylist(denylist.New(deny)))
}

// ProbeResult is the node.probe result.
type ProbeResult struct {
	Reachable bool                `json:"reachable"`
	LatencyMs *float64            `json:"latencyMs,omitempty"`
	Error     string              `json:"error,omitempty"`
	Minecraft *protocol.SlpStatus `json:"minecraft,omitempty"`
}

func ms(d time.Duration) *float64 { v := float64(d.Microseconds()) / 1000; return &v }

func probe(ctx context.Context, p *protocol.NodeProbePayload) ProbeResult {
	timeout := time.Duration(p.TimeoutMs) * time.Millisecond
	if p.Kind == "minecraft" {
		st, err := minecraft.Ping(ctx, p.Host, p.Port, timeout)
		if err == nil {
			l := st.LatencyMs
			return ProbeResult{Reachable: true, LatencyMs: &l, Minecraft: st}
		}
		if d, terr := minecraft.ProbeTCP(ctx, p.Host, p.Port, timeout); terr == nil {
			return ProbeResult{Reachable: true, LatencyMs: ms(d), Error: "status ping failed: " + short(err)}
		}
		return ProbeResult{Reachable: false, Error: short(err)}
	}
	d, err := minecraft.ProbeTCP(ctx, p.Host, p.Port, timeout)
	if err != nil {
		return ProbeResult{Reachable: false, Error: short(err)}
	}
	return ProbeResult{Reachable: true, LatencyMs: ms(d)}
}

func short(err error) string {
	s := err.Error()
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

func (a *Agent) handlers() map[string]Handler {
	return map[string]Handler{
		protocol.CmdNodeFacts: func(ctx context.Context, c *Command) (any, error) {
			return a.facts.Collect(ctx), nil
		},
		protocol.CmdNodePorts: func(ctx context.Context, c *Command) (any, error) {
			tcp, udp, err := metrics.ListeningPorts()
			if err != nil {
				return nil, protocol.Errorf(protocol.CodeRuntimeError, "listening ports unavailable: %v", err)
			}
			return map[string]any{"tcp": tcp, "udp": udp}, nil
		},
		protocol.CmdWorkloadInstall: func(ctx context.Context, c *Command) (any, error) {
			return a.driver.Install(ctx, c.Payload.(*protocol.WorkloadInstallPayload), c.Progress)
		},
		protocol.CmdFsCopy: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsPathPayload)
			return a.withRootDeny(p.WorkloadID, p.Denylist, func(r *fsops.Root) (any, error) {
				dst, err := r.Copy(p.Path)
				if err != nil {
					return nil, err
				}
				return map[string]any{"path": dst}, nil
			})
		},
		protocol.CmdFsCompress: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsCompressPayload)
			return a.withRootDeny(p.WorkloadID, p.Denylist, func(r *fsops.Root) (any, error) { return r.Compress(*p, time.Now()) })
		},
		protocol.CmdFsChmod: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsChmodPayload)
			return a.withRootDeny(p.WorkloadID, p.Denylist, func(r *fsops.Root) (any, error) { return empty{}, r.Chmod(p.Path, p.Mode) })
		},
		protocol.CmdFsFind: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsFindPayload)
			return a.withRoot(p.WorkloadID, func(r *fsops.Root) (any, error) { return r.Find(p.Path, p.Query, p.MaxResults) })
		},
		protocol.CmdNodeProbe: func(ctx context.Context, c *Command) (any, error) {
			return probe(ctx, c.Payload.(*protocol.NodeProbePayload)), nil
		},
		protocol.CmdWorkloadEnsure: func(ctx context.Context, c *Command) (any, error) {
			return a.driver.Ensure(ctx, c.Payload.(*protocol.WorkloadSpec), c.Progress)
		},
		protocol.CmdWorkloadStart: func(ctx context.Context, c *Command) (any, error) {
			return a.driver.Start(ctx, c.Payload.(*protocol.WorkloadRef).WorkloadID)
		},
		protocol.CmdWorkloadStop: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.WorkloadStopPayload)
			return a.driver.Stop(ctx, p.WorkloadID, time.Duration(p.TimeoutMs)*time.Millisecond)
		},
		protocol.CmdWorkloadKill: func(ctx context.Context, c *Command) (any, error) {
			return a.driver.Kill(ctx, c.Payload.(*protocol.WorkloadRef).WorkloadID)
		},
		protocol.CmdWorkloadRemove: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.WorkloadRemovePayload)
			return empty{}, a.driver.Remove(ctx, p.WorkloadID, p.DeleteData)
		},
		protocol.CmdWorkloadStatus: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.WorkloadStatusPayload)
			if p.WorkloadID != "" {
				st, err := a.driver.Status(ctx, p.WorkloadID)
				if err != nil {
					return nil, err
				}
				return map[string]any{"workloads": []protocol.WorkloadStatus{st}}, nil
			}
			list, err := a.driver.List(ctx)
			if err != nil {
				return nil, err
			}
			return map[string]any{"workloads": list}, nil
		},
		protocol.CmdWorkloadConsole: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.WorkloadConsolePayload)
			return empty{}, a.driver.Console(ctx, p.WorkloadID, p.Line)
		},
		protocol.CmdWorkloadLogsTail: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.WorkloadLogsTailPayload)
			since := int64(-1)
			if p.SinceTs != nil {
				since = *p.SinceTs
			}
			if lines, ok := a.logs.Tail(p.WorkloadID, p.Lines, since); ok {
				return map[string]any{"lines": lines}, nil
			}
			lines, err := a.driver.LogsFromRuntime(ctx, p.WorkloadID, p.Lines, p.SinceTs)
			if err != nil {
				return nil, err
			}
			return map[string]any{"lines": lines}, nil
		},
		protocol.CmdFsList: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsPathPayload)
			return a.withRoot(p.WorkloadID, func(r *fsops.Root) (any, error) {
				entries, truncated, err := r.List(p.Path)
				if err != nil {
					return nil, err
				}
				return map[string]any{"entries": entries, "truncated": truncated}, nil
			})
		},
		protocol.CmdFsStat: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsPathPayload)
			return a.withRoot(p.WorkloadID, func(r *fsops.Root) (any, error) { return r.Stat(p.Path) })
		},
		protocol.CmdFsRead: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsReadPayload)
			return a.withRootDeny(p.WorkloadID, p.Denylist, func(r *fsops.Root) (any, error) { return r.Read(p.Path, p.MaxBytes) })
		},
		protocol.CmdFsWrite: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsWritePayload)
			return a.withRootDeny(p.WorkloadID, p.Denylist, func(r *fsops.Root) (any, error) { return r.Write(*p) })
		},
		protocol.CmdFsMkdir: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsPathPayload)
			return a.withRootDeny(p.WorkloadID, p.Denylist, func(r *fsops.Root) (any, error) { return empty{}, r.Mkdir(p.Path) })
		},
		protocol.CmdFsRename: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsRenamePayload)
			return a.withRootDeny(p.WorkloadID, p.Denylist, func(r *fsops.Root) (any, error) { return empty{}, r.Rename(p.From, p.To) })
		},
		protocol.CmdFsDelete: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsDeletePayload)
			return a.withRootDeny(p.WorkloadID, p.Denylist, func(r *fsops.Root) (any, error) { return empty{}, r.Delete(p.Path, p.Recursive) })
		},
		protocol.CmdFsDu: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsDuPayload)
			return a.withRoot(p.WorkloadID, func(r *fsops.Root) (any, error) { return r.Du(p.Path, p.Depth, p.Top) })
		},
		protocol.CmdFsExtract: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsExtractPayload)
			return a.withRootDeny(p.WorkloadID, p.Denylist, func(r *fsops.Root) (any, error) { return r.Extract(*p) })
		},
		protocol.CmdFsTransferPush: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsTransferPushPayload)
			return a.withRootDeny(p.WorkloadID, p.Denylist, func(r *fsops.Root) (any, error) { return a.transfers.Push(ctx, r, p) })
		},
		protocol.CmdFsTransferPull: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.FsTransferPullPayload)
			return a.withRootDeny(p.WorkloadID, p.Denylist, func(r *fsops.Root) (any, error) { return a.transfers.Pull(ctx, r, p) })
		},
		protocol.CmdArtifactFetch: func(ctx context.Context, c *Command) (any, error) {
			p := c.Payload.(*protocol.ArtifactFetchPayload)
			return a.withRoot(p.WorkloadID, func(r *fsops.Root) (any, error) {
				return a.fetcher.Fetch(ctx, r, p, func(done, total int64) {
					if total > 0 {
						pct := float64(done) / float64(total) * 100
						c.Progress("download", formatMiB(done, total), &pct)
					} else {
						c.Progress("download", formatMiB(done, -1), nil)
					}
				})
			})
		},
		protocol.CmdCredentialsRotate: func(ctx context.Context, c *Command) (any, error) {
			res, err := a.rotate(c.ID)
			if err != nil {
				return nil, err
			}
			// §3.1: after the result is on the wire, reconnect authenticating with the next key.
			c.AfterResult = a.client.Reconnect
			return res, nil
		},
	}
}

func formatMiB(done, total int64) string {
	const mib = 1 << 20
	if total < 0 {
		return itoa(done/mib) + " MiB"
	}
	return itoa(done/mib) + " MiB of " + itoa(total/mib) + " MiB"
}

func itoa(v int64) string { return strconv.FormatInt(v, 10) }
