package metrics

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"

	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/minecraft"
	"github.com/blockforge/node-agent/internal/protocol"
	"github.com/blockforge/node-agent/internal/workload"
)

// Runtime is the subset of the workload driver used for sampling.
type Runtime interface {
	Running(ctx context.Context) ([]workload.RunningInfo, error)
	Stats(ctx context.Context, containerID string) (*container.StatsResponse, error)
	KnownWorkloads() []string
	Spec(id string) (*protocol.WorkloadSpec, error)
}

type prevStats struct {
	at                 time.Time
	cpuTotal, sysTotal uint64
	rx, tx, blkR, blkW uint64
	hasNet, hasBlk     bool
}

type cached[T any] struct {
	v  T
	at time.Time
}

// WorkloadSampler produces per-workload samples from Docker stats, the JVM probe file, periodic
// data-directory sizes and periodic Server List Pings.
type WorkloadSampler struct {
	rt      Runtime
	sandbox *fsops.Sandbox
	log     *slog.Logger

	mu   sync.Mutex
	prev map[string]prevStats // by container id
	du   map[string]cached[int64]
	slp  map[string]cached[*protocol.SlpStatus]

	DiskUsageEvery time.Duration
	SLPEvery       time.Duration
	now            func() time.Time
}

// NewWorkloadSampler creates a sampler.
func NewWorkloadSampler(rt Runtime, sb *fsops.Sandbox, log *slog.Logger) *WorkloadSampler {
	return &WorkloadSampler{rt: rt, sandbox: sb, log: log, prev: map[string]prevStats{},
		du: map[string]cached[int64]{}, slp: map[string]cached[*protocol.SlpStatus]{},
		DiskUsageEvery: 5 * time.Minute, SLPEvery: 15 * time.Second, now: time.Now}
}

// CPUPercent mirrors the docker CLI: (Δcontainer / Δsystem) × onlineCPUs × 100 (relative to one core).
func CPUPercent(prevCPU, prevSys uint64, s *container.StatsResponse) (float64, bool) {
	cpuDelta := float64(s.CPUStats.CPUUsage.TotalUsage) - float64(prevCPU)
	sysDelta := float64(s.CPUStats.SystemUsage) - float64(prevSys)
	online := float64(s.CPUStats.OnlineCPUs)
	if online == 0 {
		online = float64(len(s.CPUStats.CPUUsage.PercpuUsage))
	}
	if sysDelta <= 0 || cpuDelta < 0 || online == 0 {
		return 0, false
	}
	return cpuDelta / sysDelta * online * 100, true
}

// MemoryUsage returns usage minus inactive file cache (docker CLI semantics) and the page cache.
func MemoryUsage(m container.MemoryStats) (used, cache int64, ok bool) {
	if m.Usage == 0 {
		return 0, 0, false
	}
	u := m.Usage
	if v, has := m.Stats["inactive_file"]; has && v < u { // cgroup v2
		u -= v
	} else if v, has := m.Stats["total_inactive_file"]; has && v < u { // cgroup v1
		u -= v
	}
	c, has := m.Stats["file"]
	if !has {
		c = m.Stats["total_cache"]
	}
	return int64(u), int64(c), true
}

func blkio(s *container.StatsResponse) (r, w uint64, ok bool) {
	if s.BlkioStats.IoServiceBytesRecursive == nil {
		return 0, 0, false
	}
	for _, e := range s.BlkioStats.IoServiceBytesRecursive {
		switch strings.ToLower(e.Op) {
		case "read":
			r += e.Value
		case "write":
			w += e.Value
		}
	}
	return r, w, true
}

func rate(cur, prev uint64, dt float64) *float64 {
	if cur < prev || dt <= 0 {
		return nil
	}
	v := float64(cur-prev) / dt
	return &v
}

// Sample builds samples for all known workloads.
func (s *WorkloadSampler) Sample(ctx context.Context) []protocol.WorkloadMetricSample {
	now := s.now()
	running, err := s.rt.Running(ctx)
	if err != nil {
		return []protocol.WorkloadMetricSample{}
	}
	out := []protocol.WorkloadMetricSample{}
	seen := map[string]bool{}
	results := make([]protocol.WorkloadMetricSample, len(running))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, ri := range running {
		seen[ri.WorkloadID] = true
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, ri workload.RunningInfo) {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = s.sampleRunning(ctx, ri, now)
		}(i, ri)
	}
	wg.Wait()
	out = append(out, results...)
	for _, id := range s.rt.KnownWorkloads() {
		if seen[id] {
			continue
		}
		smp := protocol.WorkloadMetricSample{WorkloadID: id, TS: now.UnixMilli(), Running: false}
		s.mu.Lock()
		if c, ok := s.du[id]; ok {
			smp.DiskUsageBytes = i64(c.v)
		}
		s.mu.Unlock()
		out = append(out, smp)
	}
	// Forget counters of containers that went away.
	s.mu.Lock()
	live := map[string]bool{}
	for _, ri := range running {
		live[ri.ContainerID] = true
	}
	for cid := range s.prev {
		if !live[cid] {
			delete(s.prev, cid)
		}
	}
	s.mu.Unlock()
	return out
}

func (s *WorkloadSampler) sampleRunning(ctx context.Context, ri workload.RunningInfo, now time.Time) protocol.WorkloadMetricSample {
	smp := protocol.WorkloadMetricSample{WorkloadID: ri.WorkloadID, TS: now.UnixMilli(), Running: true}
	sctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	st, err := s.rt.Stats(sctx, ri.ContainerID)
	cancel()
	if err == nil && st != nil {
		s.mu.Lock()
		p, had := s.prev[ri.ContainerID]
		s.mu.Unlock()
		read := st.Read
		if read.IsZero() {
			read = now
		}
		dt := read.Sub(p.at).Seconds()
		if had {
			if pct, ok := CPUPercent(p.cpuTotal, p.sysTotal, st); ok {
				smp.CPUPct = f64(pct)
			}
		}
		smp.CPUThrottledPeriodsTotal = u64(st.CPUStats.ThrottlingData.ThrottledPeriods)
		if used, cache, ok := MemoryUsage(st.MemoryStats); ok {
			smp.MemoryUsageBytes, smp.MemoryCacheBytes = i64(used), i64(cache)
			if st.MemoryStats.Limit > 0 {
				smp.MemoryLimitBytes = i64(int64(st.MemoryStats.Limit))
			}
		}
		np := prevStats{at: read, cpuTotal: st.CPUStats.CPUUsage.TotalUsage, sysTotal: st.CPUStats.SystemUsage}
		if st.Networks != nil {
			for _, n := range st.Networks {
				np.rx += n.RxBytes
				np.tx += n.TxBytes
			}
			np.hasNet = true
			if had && p.hasNet {
				smp.NetRxBytesPerSec, smp.NetTxBytesPerSec = rate(np.rx, p.rx, dt), rate(np.tx, p.tx, dt)
			}
		}
		if r, w, ok := blkio(st); ok {
			np.blkR, np.blkW, np.hasBlk = r, w, true
			if had && p.hasBlk {
				smp.BlkReadBytesPerSec, smp.BlkWriteBytesPerSec = rate(r, p.blkR, dt), rate(w, p.blkW, dt)
			}
		}
		if st.PidsStats.Current > 0 {
			smp.Pids = i64(int64(st.PidsStats.Current))
		}
		s.mu.Lock()
		s.prev[ri.ContainerID] = np
		s.mu.Unlock()
	}
	if j := s.readJVM(ri.WorkloadID, now); j != nil {
		smp.JVM = j
	}
	s.mu.Lock()
	if c, ok := s.du[ri.WorkloadID]; ok {
		smp.DiskUsageBytes = i64(c.v)
	}
	if c, ok := s.slp[ri.WorkloadID]; ok && now.Sub(c.at) < 3*s.SLPEvery && c.v != nil {
		smp.Minecraft = c.v
	}
	s.mu.Unlock()
	return smp
}

// JVMStaleAfter drops probe files older than this.
const JVMStaleAfter = 30 * time.Second

// readJVM reads <data>/.blockforge/jvm.json through the sandbox (the workload controls that file).
func (s *WorkloadSampler) readJVM(id string, now time.Time) *protocol.JvmStats {
	root, err := s.sandbox.Open(id)
	if err != nil {
		return nil
	}
	defer root.Close()
	f, _, err := root.OpenRegular(".blockforge/jvm.json")
	if err != nil {
		return nil
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 64*1024))
	if err != nil {
		return nil
	}
	return ParseJVM(b, now)
}

// ParseJVM validates a probe document; nil if malformed, incomplete or stale.
func ParseJVM(b []byte, now time.Time) *protocol.JvmStats {
	var j protocol.JvmStats
	dec := json.NewDecoder(bytes.NewReader(b))
	if err := dec.Decode(&j); err != nil {
		return nil
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(b, &raw) != nil {
		return nil
	}
	for _, k := range []string{"heapUsedBytes", "heapCommittedBytes", "heapMaxBytes", "sampledAt"} {
		if _, ok := raw[k]; !ok {
			return nil
		}
	}
	age := now.Sub(time.UnixMilli(j.SampledAt))
	if age > JVMStaleAfter || age < -JVMStaleAfter {
		return nil
	}
	if j.HeapUsedBytes < 0 || j.HeapCommittedBytes < 0 || j.HeapMaxBytes < 0 {
		return nil
	}
	for _, p := range []**int64{&j.NonHeapUsedBytes, &j.GcCountTotal, &j.GcTimeMsTotal, &j.Threads, &j.UptimeMs} {
		if *p != nil && **p < 0 {
			*p = nil
		}
	}
	return &j
}

// RunBackground refreshes data-dir sizes and SLP status until ctx ends.
func (s *WorkloadSampler) RunBackground(ctx context.Context) {
	go s.loop(ctx, s.SLPEvery, s.refreshSLP)
	go s.loop(ctx, s.DiskUsageEvery, s.refreshDiskUsage)
}

func (s *WorkloadSampler) loop(ctx context.Context, every time.Duration, fn func(context.Context)) {
	fn(ctx)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fn(ctx)
		}
	}
}

func (s *WorkloadSampler) refreshDiskUsage(ctx context.Context) {
	for _, id := range s.rt.KnownWorkloads() {
		if ctx.Err() != nil {
			return
		}
		root, err := s.sandbox.Open(id)
		if err != nil {
			continue
		}
		size, complete := root.DirSize(1_000_000)
		root.Close()
		if !complete {
			s.log.Warn("data directory walk truncated; size is a lower bound and not reported", "workload", id)
			continue
		}
		s.mu.Lock()
		s.du[id] = cached[int64]{v: size, at: s.now()}
		s.mu.Unlock()
	}
}

var (
	reServerPort  = regexp.MustCompile(`^\s*server-port\s*=\s*(\d{1,5})\s*$`)
	reVelocityBnd = regexp.MustCompile(`^\s*bind\s*=\s*"[^"]*:(\d{1,5})"\s*$`)
)

// slpPort resolves the in-container port: server.properties / velocity.toml, then spec ports, then defaults.
func (s *WorkloadSampler) slpPort(id, kind string) int {
	file, re, def := "server.properties", reServerPort, 25565
	if kind == "velocity" {
		file, re, def = "velocity.toml", reVelocityBnd, 25577
	}
	if root, err := s.sandbox.Open(id); err == nil {
		if f, _, err := root.OpenRegular(file); err == nil {
			sc := bufio.NewScanner(io.LimitReader(f, 1<<20))
			for sc.Scan() {
				if m := re.FindStringSubmatch(sc.Text()); m != nil {
					if p, err := strconv.Atoi(m[1]); err == nil && p > 0 && p < 65536 {
						f.Close()
						root.Close()
						return p
					}
				}
			}
			f.Close()
		}
		root.Close()
	}
	if spec, err := s.rt.Spec(id); err == nil {
		for _, p := range spec.Ports {
			if p.Protocol == "tcp" {
				return p.ContainerPort
			}
		}
	}
	return def
}

// SLPTargets lists (host, port) candidates for a running workload: its IP on a bf-* network,
// any other container IP, then the published host port on loopback.
func (s *WorkloadSampler) SLPTargets(ri workload.RunningInfo) []struct {
	Host string
	Port int
} {
	port := s.slpPort(ri.WorkloadID, ri.Kind)
	type hp = struct {
		Host string
		Port int
	}
	var out []hp
	for name, ip := range ri.IPs {
		if strings.HasPrefix(name, "bf-") {
			out = append(out, hp{ip, port})
		}
	}
	for name, ip := range ri.IPs {
		if !strings.HasPrefix(name, "bf-") {
			out = append(out, hp{ip, port})
		}
	}
	if spec, err := s.rt.Spec(ri.WorkloadID); err == nil {
		for _, p := range spec.Ports {
			if p.Protocol == "tcp" && p.ContainerPort == port {
				host := p.HostIP
				if host == "0.0.0.0" || host == "::" {
					host = "127.0.0.1"
				}
				out = append(out, hp{host, p.HostPort})
			}
		}
	}
	return out
}

func (s *WorkloadSampler) refreshSLP(ctx context.Context) {
	running, err := s.rt.Running(ctx)
	if err != nil {
		return
	}
	var wg sync.WaitGroup
	for _, ri := range running {
		if ri.Kind != "minecraft" && ri.Kind != "velocity" {
			continue
		}
		wg.Add(1)
		go func(ri workload.RunningInfo) {
			defer wg.Done()
			var st *protocol.SlpStatus
			for _, t := range s.SLPTargets(ri) {
				if r, err := minecraft.Ping(ctx, t.Host, t.Port, 3*time.Second); err == nil {
					st = r
					break
				}
			}
			s.mu.Lock()
			if st != nil {
				s.slp[ri.WorkloadID] = cached[*protocol.SlpStatus]{v: st, at: s.now()}
			} else {
				delete(s.slp, ri.WorkloadID)
			}
			s.mu.Unlock()
		}(ri)
	}
	wg.Wait()
}

// LatestSLP returns the cached SLP status of a workload (tests / diagnostics).
func (s *WorkloadSampler) LatestSLP(id string) *protocol.SlpStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.slp[id].v
}
