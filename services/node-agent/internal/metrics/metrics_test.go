package metrics

import (
	"context"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/shirou/gopsutil/v4/cpu"
)

func TestCPUPercentDockerFormula(t *testing.T) {
	s := &container.StatsResponse{}
	s.CPUStats.CPUUsage.TotalUsage = 3_000_000_000
	s.CPUStats.SystemUsage = 20_000_000_000
	s.CPUStats.OnlineCPUs = 4
	// container used 2e9 ns while the system (4 cores) accumulated 8e9 ns → 1 core of 4 → 100%... ×online
	pct, ok := CPUPercent(1_000_000_000, 12_000_000_000, s)
	if !ok || pct != 100 {
		t.Fatalf("pct %v ok %v", pct, ok)
	}
	if _, ok := CPUPercent(0, 20_000_000_000, s); ok {
		t.Fatal("zero system delta must be rejected")
	}
	if _, ok := CPUPercent(0, 30_000_000_000, s); ok {
		t.Fatal("negative system delta must be rejected")
	}
	// Two full cores → 200 (per-core semantics, may exceed 100).
	pct, _ = CPUPercent(0, 12_000_000_000, &container.StatsResponse{CPUStats: container.CPUStats{
		CPUUsage: container.CPUUsage{TotalUsage: 4_000_000_000}, SystemUsage: 20_000_000_000, OnlineCPUs: 4}})
	if pct != 200 {
		t.Fatalf("two cores %v", pct)
	}
}

func TestMemoryUsage(t *testing.T) {
	used, cache, ok := MemoryUsage(container.MemoryStats{Usage: 1000, Stats: map[string]uint64{"inactive_file": 300, "file": 400}})
	if !ok || used != 700 || cache != 400 {
		t.Fatalf("v2 %d %d", used, cache)
	}
	used, cache, _ = MemoryUsage(container.MemoryStats{Usage: 1000, Stats: map[string]uint64{"total_inactive_file": 100, "total_cache": 200}})
	if used != 900 || cache != 200 {
		t.Fatalf("v1 %d %d", used, cache)
	}
	if _, _, ok := MemoryUsage(container.MemoryStats{}); ok {
		t.Fatal("empty stats must be omitted, not zero-filled")
	}
}

func TestParseJVM(t *testing.T) {
	now := time.UnixMilli(1_760_000_000_000)
	doc := func(sampled int64) []byte {
		return []byte(`{"heapUsedBytes":100,"heapCommittedBytes":200,"heapMaxBytes":400,"nonHeapUsedBytes":50,"gcCountTotal":3,"gcTimeMsTotal":12,"threads":40,"uptimeMs":1000,"sampledAt":` + strconv.FormatInt(sampled, 10) + `}`)
	}
	j := ParseJVM(doc(now.UnixMilli()-5000), now)
	if j == nil || j.HeapMaxBytes != 400 || *j.Threads != 40 {
		t.Fatalf("fresh %+v", j)
	}
	if ParseJVM(doc(now.UnixMilli()-31_000), now) != nil {
		t.Fatal("stale probe accepted")
	}
	if ParseJVM([]byte(`{"heapUsedBytes":1,"heapCommittedBytes":2,"sampledAt":`+strconv.FormatInt(now.UnixMilli(), 10)+`}`), now) != nil {
		t.Fatal("probe without heapMax accepted")
	}
	if ParseJVM([]byte(`garbage`), now) != nil {
		t.Fatal("garbage accepted")
	}
}

func TestUsageClamp(t *testing.T) {
	a := cpu.TimesStat{User: 10, Idle: 10}
	b := cpu.TimesStat{User: 30, Idle: 10.000001} // jitter → >100% before clamping
	pct, _, _, ok := usage(a, b)
	if !ok || pct > 100 || pct < 99 {
		t.Fatalf("pct %v", pct)
	}
	if clampPct(100.4) != 100 || clampPct(-1) != 0 {
		t.Fatal("clamp")
	}
}

func TestIfaceExcluded(t *testing.T) {
	ex := []string{"lo", "veth*", "docker*", "br-*"}
	for name, want := range map[string]bool{"lo": true, "veth1a2b": true, "docker0": true, "br-0123456789ab": true, "ens18": false, "eth0": false, "wlan0": false} {
		if IfaceExcluded(name, ex) != want {
			t.Errorf("%s", name)
		}
	}
}

func TestHostSamplerReal(t *testing.T) {
	ctx := context.Background()
	s := NewHostSampler(ctx, t.TempDir(), []string{"lo", "veth*"})
	time.Sleep(1100 * time.Millisecond)
	smp, ok := s.Sample(ctx)
	if !ok {
		t.Fatal("no CPU baseline")
	}
	if smp.CPU.UsagePct < 0 || smp.CPU.UsagePct > 100 || smp.Memory.TotalBytes <= 0 || smp.Memory.AvailableBytes <= 0 {
		t.Fatalf("sample %+v", smp)
	}
	for _, p := range smp.CPU.PerCorePct {
		if p < 0 || p > 100 {
			t.Fatalf("per-core %v", p)
		}
	}
	if len(smp.Filesystems) == 0 {
		t.Fatal("dataRoot filesystem missing")
	}
	for _, d := range smp.DiskIO {
		if d.BusyPct != nil && (*d.BusyPct < 0 || *d.BusyPct > 100) {
			t.Fatalf("busy %v", *d.BusyPct)
		}
	}
	if runtime.GOOS == "linux" {
		if smp.CPU.IowaitPct == nil || smp.CPU.Load1 == nil || smp.TCP == nil || smp.Memory.CachedBytes == nil {
			t.Fatalf("linux fields missing: %+v", smp)
		}
	} else if smp.CPU.IowaitPct != nil || smp.Memory.CachedBytes != nil {
		t.Fatal("non-linux must omit iowait/cached rather than zero-fill")
	}
	for _, n := range smp.Network {
		if n.Iface == "lo" {
			t.Fatal("loopback not excluded")
		}
	}
}

func TestUnescapeMount(t *testing.T) {
	if got := unescapeMount(`/mnt/my\040disk`); got != "/mnt/my disk" {
		t.Fatalf("%q", got)
	}
	if got := unescapeMount("/plain"); got != "/plain" {
		t.Fatal(got)
	}
}
