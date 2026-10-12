// Package metrics samples host and workload telemetry. Rates are computed from deltas between
// consecutive samples; anything a platform cannot provide is omitted, never zero-filled.
package metrics

import (
	"bufio"
	"context"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	psnet "github.com/shirou/gopsutil/v4/net"

	"github.com/blockforge/node-agent/internal/protocol"
)

// HostProc / HostSys / HostRoot honour the gopsutil environment overrides used when the agent runs
// in a container with the host's /proc and /sys mounted (e.g. HOST_PROC=/host/proc).
func HostProc(p ...string) string { return hostPath("HOST_PROC", "/proc", p...) }
func HostSys(p ...string) string  { return hostPath("HOST_SYS", "/sys", p...) }

func hostPath(env, def string, p ...string) string {
	base := os.Getenv(env)
	if base == "" {
		base = def
	}
	return filepath.Join(append([]string{base}, p...)...)
}

// Containerised reports whether host paths are remapped (agent running in a container).
func Containerised() bool { return os.Getenv("HOST_PROC") != "" }

func clampPct(v float64) float64 {
	if v < 0 || v != v {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func f64(v float64) *float64 { return &v }
func i64(v int64) *int64     { return &v }
func u64(v uint64) *uint64   { return &v }

// HostSampler keeps the previous counters needed for rates.
type HostSampler struct {
	DataRoot      string
	ExcludeIfaces []string

	prevAt    time.Time
	prevTotal *cpu.TimesStat
	prevCores []cpu.TimesStat
	prevDisk  map[string]disk.IOCountersStat
	prevNet   map[string]psnet.IOCountersStat
}

// NewHostSampler primes the counters so the first Sample has a baseline.
func NewHostSampler(ctx context.Context, dataRoot string, exclude []string) *HostSampler {
	s := &HostSampler{DataRoot: dataRoot, ExcludeIfaces: exclude}
	s.prime(ctx)
	return s
}

func (s *HostSampler) prime(ctx context.Context) {
	s.prevAt = time.Now()
	if t, err := cpu.TimesWithContext(ctx, false); err == nil && len(t) == 1 {
		s.prevTotal = &t[0]
	}
	if t, err := cpu.TimesWithContext(ctx, true); err == nil {
		s.prevCores = t
	}
	if d, err := disk.IOCountersWithContext(ctx); err == nil {
		s.prevDisk = d
	}
	if n, err := psnet.IOCountersWithContext(ctx, true); err == nil {
		s.prevNet = map[string]psnet.IOCountersStat{}
		for _, c := range n {
			s.prevNet[c.Name] = c
		}
	}
}

type cpuShares struct{ busy, idle, iowait, steal, total float64 }

func shares(t cpu.TimesStat) cpuShares {
	// On Linux, user/nice already include guest time; do not add guest twice.
	busy := t.User + t.Nice + t.System + t.Irq + t.Softirq + t.Steal
	idle := t.Idle + t.Iowait
	return cpuShares{busy: busy, idle: idle, iowait: t.Iowait, steal: t.Steal, total: busy + idle}
}

func usage(prev, cur cpu.TimesStat) (pct, iowait, steal float64, ok bool) {
	a, b := shares(prev), shares(cur)
	dt := b.total - a.total
	if dt <= 0 {
		return 0, 0, 0, false
	}
	return clampPct((b.busy - a.busy) / dt * 100), clampPct((b.iowait - a.iowait) / dt * 100), clampPct((b.steal - a.steal) / dt * 100), true
}

// IfaceExcluded applies path.Match patterns to an interface name.
func IfaceExcluded(name string, patterns []string) bool {
	for _, p := range patterns {
		if ok, _ := path.Match(p, name); ok {
			return true
		}
	}
	return false
}

// Sample returns a node sample; ok=false if no CPU baseline could be established yet.
func (s *HostSampler) Sample(ctx context.Context) (protocol.NodeMetricSample, bool) {
	now := time.Now()
	dt := now.Sub(s.prevAt).Seconds()
	out := protocol.NodeMetricSample{TS: now.UnixMilli(), Filesystems: []protocol.FilesystemSample{},
		DiskIO: []protocol.DiskIOSample{}, Network: []protocol.NetworkSample{}}
	ok := false
	linux := runtime.GOOS == "linux"

	if t, err := cpu.TimesWithContext(ctx, false); err == nil && len(t) == 1 {
		if s.prevTotal != nil {
			if pct, iow, st, good := usage(*s.prevTotal, t[0]); good {
				out.CPU.UsagePct = pct
				ok = true
				if linux {
					out.CPU.IowaitPct, out.CPU.StealPct = f64(iow), f64(st)
				}
			}
		}
		s.prevTotal = &t[0]
	}
	if t, err := cpu.TimesWithContext(ctx, true); err == nil {
		if len(s.prevCores) == len(t) && len(t) > 0 {
			per := make([]float64, 0, len(t))
			for i := range t {
				p, _, _, good := usage(s.prevCores[i], t[i])
				if !good {
					per = nil
					break
				}
				per = append(per, p)
			}
			out.CPU.PerCorePct = per
		}
		s.prevCores = t
	}
	if runtime.GOOS != "windows" {
		if l, err := load.AvgWithContext(ctx); err == nil {
			out.CPU.Load1, out.CPU.Load5, out.CPU.Load15 = f64(l.Load1), f64(l.Load5), f64(l.Load15)
		}
	}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		out.Memory = protocol.MemorySample{TotalBytes: int64(vm.Total), UsedBytes: int64(vm.Used), AvailableBytes: int64(vm.Available)}
		if linux {
			out.Memory.CachedBytes, out.Memory.BuffersBytes = i64(int64(vm.Cached)), i64(int64(vm.Buffers))
		}
	}
	if sw, err := mem.SwapMemoryWithContext(ctx); err == nil {
		out.Memory.SwapTotalBytes, out.Memory.SwapUsedBytes = i64(int64(sw.Total)), i64(int64(sw.Used))
	}
	out.Filesystems = Filesystems(ctx, s.DataRoot)

	if d, err := disk.IOCountersWithContext(ctx); err == nil {
		if s.prevDisk != nil && dt > 0 {
			names := make([]string, 0, len(d))
			for n := range d {
				names = append(names, n)
			}
			sort.Strings(names)
			for _, name := range names {
				c := d[name]
				p, had := s.prevDisk[name]
				if !had || !PhysicalDisk(name) || c.ReadBytes < p.ReadBytes || c.WriteBytes < p.WriteBytes {
					continue
				}
				smp := protocol.DiskIOSample{
					Device:           name,
					ReadBytesPerSec:  float64(c.ReadBytes-p.ReadBytes) / dt,
					WriteBytesPerSec: float64(c.WriteBytes-p.WriteBytes) / dt,
					ReadOpsPerSec:    float64(c.ReadCount-p.ReadCount) / dt,
					WriteOpsPerSec:   float64(c.WriteCount-p.WriteCount) / dt,
				}
				if linux && c.IoTime >= p.IoTime {
					smp.BusyPct = f64(clampPct(float64(c.IoTime-p.IoTime) / (dt * 1000) * 100))
				}
				ops := (c.ReadCount - p.ReadCount) + (c.WriteCount - p.WriteCount)
				if linux && ops > 0 && c.ReadTime >= p.ReadTime && c.WriteTime >= p.WriteTime {
					smp.AvgLatencyMs = f64(float64((c.ReadTime-p.ReadTime)+(c.WriteTime-p.WriteTime)) / float64(ops))
				}
				out.DiskIO = append(out.DiskIO, smp)
			}
		}
		s.prevDisk = d
	}
	if n, err := psnet.IOCountersWithContext(ctx, true); err == nil {
		cur := map[string]psnet.IOCountersStat{}
		for _, c := range n {
			cur[c.Name] = c
		}
		if s.prevNet != nil && dt > 0 {
			sort.Slice(n, func(i, j int) bool { return n[i].Name < n[j].Name })
			for _, c := range n {
				p, had := s.prevNet[c.Name]
				if !had || IfaceExcluded(c.Name, s.ExcludeIfaces) || c.BytesRecv < p.BytesRecv || c.BytesSent < p.BytesSent {
					continue
				}
				smp := protocol.NetworkSample{
					Iface:         c.Name,
					RxBytesPerSec: float64(c.BytesRecv-p.BytesRecv) / dt,
					TxBytesPerSec: float64(c.BytesSent-p.BytesSent) / dt,
				}
				if c.PacketsRecv >= p.PacketsRecv && c.PacketsSent >= p.PacketsSent {
					smp.RxPacketsPerSec = f64(float64(c.PacketsRecv-p.PacketsRecv) / dt)
					smp.TxPacketsPerSec = f64(float64(c.PacketsSent-p.PacketsSent) / dt)
				}
				if runtime.GOOS != "windows" {
					smp.RxErrorsTotal, smp.TxErrorsTotal = u64(c.Errin), u64(c.Errout)
				}
				smp.RxDroppedTotal, smp.TxDroppedTotal = u64(c.Dropin), u64(c.Dropout)
				out.Network = append(out.Network, smp)
			}
		}
		s.prevNet = cur
	}
	if linux {
		if est, total, err := TCPCounts(); err == nil {
			out.TCP = &protocol.TCPSample{Established: est, Total: total}
		}
	}
	s.prevAt = now
	return out, ok
}

// PhysicalDisk reports whether a block device is a whole physical/virtual disk (not a partition,
// loop, ram, dm or md device). On Linux this is /sys/block/<name>/device; elsewhere every device counts.
func PhysicalDisk(name string) bool {
	if runtime.GOOS != "linux" {
		return true
	}
	for _, p := range []string{"loop", "ram", "zram", "sr", "fd", "nbd"} {
		if strings.HasPrefix(name, p) {
			return false
		}
	}
	_, err := os.Stat(HostSys("block", name, "device"))
	return err == nil
}

// TCPCounts counts sockets in /proc/net/tcp{,6} (state 01 = ESTABLISHED).
func TCPCounts() (established, total int64, err error) {
	found := false
	for _, f := range []string{"tcp", "tcp6"} {
		fh, e := os.Open(HostProc("net", f))
		if e != nil {
			continue
		}
		found = true
		sc := bufio.NewScanner(fh)
		first := true
		for sc.Scan() {
			if first {
				first = false
				continue
			}
			fields := strings.Fields(sc.Text())
			if len(fields) < 4 {
				continue
			}
			total++
			if fields[3] == "01" {
				established++
			}
		}
		fh.Close()
	}
	if !found {
		return 0, 0, os.ErrNotExist
	}
	return established, total, nil
}

var pseudoFS = map[string]bool{
	"proc": true, "sysfs": true, "tmpfs": true, "devtmpfs": true, "devpts": true, "cgroup": true, "cgroup2": true,
	"overlay": true, "squashfs": true, "nsfs": true, "mqueue": true, "debugfs": true, "tracefs": true,
	"securityfs": true, "pstore": true, "bpf": true, "autofs": true, "configfs": true, "fusectl": true,
	"hugetlbfs": true, "binfmt_misc": true, "rpc_pipefs": true, "efivarfs": true, "ramfs": true,
	"fuse.lxcfs": true, "nfsd": true, "selinuxfs": true, "aufs": true, "shm": true, "iso9660": true,
}

var skipMountPrefixes = []string{"/proc", "/sys", "/dev", "/run", "/snap", "/var/lib/docker", "/var/lib/containers",
	"/var/snap", "/boot/efi", "/mnt/wsl", "/usr/lib/wsl"}

// Filesystems reports real mounts (pseudo filesystems excluded, deduplicated by device). The
// filesystem containing dataRoot is always included. When containerised, other mounts are only
// stat-able if HOST_ROOT points at the host root filesystem.
func Filesystems(ctx context.Context, dataRoot string) []protocol.FilesystemSample {
	out := []protocol.FilesystemSample{}
	parts, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		parts = nil
	}
	hostRoot := os.Getenv("HOST_ROOT")
	contained := Containerised()

	// Locate the mount holding dataRoot (longest prefix).
	var dataPart *disk.PartitionStat
	for i := range parts {
		m := parts[i].Mountpoint
		if dataRoot == m || strings.HasPrefix(dataRoot, strings.TrimRight(m, "/")+"/") || m == "/" {
			if dataPart == nil || len(m) > len(dataPart.Mountpoint) {
				dataPart = &parts[i]
			}
		}
	}
	seenDev := map[string]bool{}
	add := func(mount, device, fstype, statPath string) {
		u, err := disk.UsageWithContext(ctx, statPath)
		if err != nil || u.Total == 0 {
			return
		}
		smp := protocol.FilesystemSample{Mount: mount, Device: device, FsType: fstype,
			TotalBytes: int64(u.Total), UsedBytes: int64(u.Used), FreeBytes: int64(u.Free)}
		if u.InodesTotal > 0 {
			smp.InodesTotal, smp.InodesUsed = i64(int64(u.InodesTotal)), i64(int64(u.InodesUsed))
		}
		out = append(out, smp)
		if device != "" {
			seenDev[device] = true
		}
	}
	if dataPart == nil && runtime.GOOS == "linux" {
		// The host mount table may not show the data root at a matching path (Docker Desktop's VM,
		// unreadable host table): the agent's own mount namespace always knows the bind mount.
		dataPart = ownMount(dataRoot)
	}
	if dataPart != nil {
		add(dataPart.Mountpoint, dataPart.Device, dataPart.Fstype, dataRoot)
	} else if _, err := os.Stat(dataRoot); err == nil {
		add(dataRoot, "", "", dataRoot)
	}
	for _, p := range parts {
		if len(out) >= 32 {
			break
		}
		if pseudoFS[p.Fstype] || seenDev[p.Device] || (dataPart != nil && p.Mountpoint == dataPart.Mountpoint) {
			continue
		}
		skip := false
		for _, pre := range skipMountPrefixes {
			if p.Mountpoint == pre || strings.HasPrefix(p.Mountpoint, pre+"/") {
				skip = true
			}
		}
		if skip {
			continue
		}
		statPath := p.Mountpoint
		if contained {
			if hostRoot == "" {
				continue
			}
			statPath = filepath.Join(hostRoot, p.Mountpoint)
		}
		add(p.Mountpoint, p.Device, p.Fstype, statPath)
	}
	return out
}

// ownMount finds the mount containing p in /proc/self/mountinfo (the agent's own namespace).
func ownMount(p string) *disk.PartitionStat {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return nil
	}
	defer f.Close()
	var best *disk.PartitionStat
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		pre, post, ok := strings.Cut(sc.Text(), " - ")
		if !ok {
			continue
		}
		a, b := strings.Fields(pre), strings.Fields(post)
		if len(a) < 5 || len(b) < 2 || pseudoFS[b[0]] {
			continue
		}
		mp := unescapeMount(a[4])
		if p == mp || strings.HasPrefix(p, strings.TrimRight(mp, "/")+"/") || mp == "/" {
			if best == nil || len(mp) > len(best.Mountpoint) {
				best = &disk.PartitionStat{Mountpoint: mp, Fstype: b[0], Device: unescapeMount(b[1])}
			}
		}
	}
	return best
}

// unescapeMount decodes the octal escapes (backslash + 3 octal digits) used in mountinfo.
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == 0x5c && i+3 < len(s) { // backslash
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				sb.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		sb.WriteByte(s[i])
	}
	return sb.String()
}
