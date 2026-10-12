// Package facts collects NodeFacts (hardware, OS, network, filesystems, container runtime, Java images).
package facts

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/moby/moby/client"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	psnet "github.com/shirou/gopsutil/v4/net"

	"github.com/blockforge/node-agent/internal/metrics"
	"github.com/blockforge/node-agent/internal/protocol"
)

// Collector gathers facts. Docker may be nil (runtime reported as unavailable).
type Collector struct {
	DataRoot      string
	ExcludeIfaces []string
	Docker        *client.Client
	// SFTP is reported as NodeFacts.sftp (nil = service disabled or not listening).
	SFTP *protocol.SftpFact
}

func ip(v int) *int      { return &v }
func i64(v int64) *int64 { return &v }
func bptr(v bool) *bool  { return &v }
func clip(s string) string {
	if len(s) > 256 {
		return s[:256]
	}
	return s
}

// Collect returns the current facts. It never fails: unavailable facts are omitted.
func (c *Collector) Collect(ctx context.Context) protocol.NodeFacts {
	f := protocol.NodeFacts{
		OS: runtime.GOOS, Arch: runtime.GOARCH, DataRoot: c.DataRoot,
		Interfaces: []protocol.NetworkInterfaceFact{}, Filesystems: []protocol.FilesystemFact{},
		JavaRuntimes: []protocol.JavaRuntimeFact{}, CPULogicalCores: runtime.NumCPU(),
	}
	if hi, err := host.InfoWithContext(ctx); err == nil {
		f.Hostname = hi.Hostname
		f.Platform, f.PlatformVersion, f.KernelVersion = clip(hi.Platform), clip(hi.PlatformVersion), clip(hi.KernelVersion)
		if hi.BootTime > 0 {
			f.BootTime = i64(int64(hi.BootTime) * 1000)
		}
	}
	if h := os.Getenv("BLOCKFORGE_HOSTNAME"); h != "" {
		f.Hostname = h
	}
	if f.Hostname == "" {
		f.Hostname, _ = os.Hostname()
	}
	if infos, err := cpu.InfoWithContext(ctx); err == nil && len(infos) > 0 {
		f.CPUModel = clip(strings.TrimSpace(infos[0].ModelName))
	}
	if n, err := cpu.CountsWithContext(ctx, true); err == nil && n > 0 {
		f.CPULogicalCores = n
	}
	if n, err := cpu.CountsWithContext(ctx, false); err == nil && n > 0 {
		f.CPUPhysicalCores = ip(n)
	}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		f.MemoryTotalBytes = int64(vm.Total)
	}
	if sw, err := mem.SwapMemoryWithContext(ctx); err == nil {
		f.SwapTotalBytes = i64(int64(sw.Total))
	}
	f.Timezone = timezone()
	if ifs, err := psnet.InterfacesWithContext(ctx); err == nil {
		for _, i := range ifs {
			if metrics.IfaceExcluded(i.Name, c.ExcludeIfaces) {
				continue
			}
			nf := protocol.NetworkInterfaceFact{Name: i.Name, MAC: i.HardwareAddr, Addresses: []string{}}
			if i.MTU > 0 {
				nf.MTU = ip(i.MTU)
			}
			up := false
			for _, fl := range i.Flags {
				if fl == "up" {
					up = true
				}
			}
			nf.Up = bptr(up)
			for _, a := range i.Addrs {
				nf.Addresses = append(nf.Addresses, a.Addr)
			}
			f.Interfaces = append(f.Interfaces, nf)
			if len(f.Interfaces) >= 64 {
				break
			}
		}
	}
	for _, fs := range metrics.Filesystems(ctx, c.DataRoot) {
		f.Filesystems = append(f.Filesystems, protocol.FilesystemFact{Mount: fs.Mount, Device: fs.Device, FsType: fs.FsType, TotalBytes: fs.TotalBytes})
	}
	f.Sftp = c.SFTP
	if c.Docker != nil {
		rt := c.runtimeFact(ctx)
		f.ContainerRuntime = &rt
		if rt.Healthy {
			f.JavaRuntimes = c.javaImages(ctx)
		}
	}
	return f
}

func timezone() string {
	if tz := os.Getenv("TZ"); tz != "" && !strings.HasPrefix(tz, ":") {
		return tz
	}
	etc := os.Getenv("HOST_ETC")
	if etc == "" {
		etc = "/etc"
	}
	if b, err := os.ReadFile(filepath.Join(etc, "timezone")); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" && len(s) < 64 {
			return s
		}
	}
	if target, err := os.Readlink(filepath.Join(etc, "localtime")); err == nil {
		if i := strings.Index(target, "zoneinfo/"); i >= 0 {
			return target[i+len("zoneinfo/"):]
		}
	}
	if runtime.GOOS == "windows" {
		name, _ := time.Now().Zone()
		return name
	}
	if name := time.Local.String(); name != "" && name != "Local" {
		return name
	}
	return ""
}

func (c *Collector) runtimeFact(ctx context.Context) protocol.ContainerRuntimeFact {
	rt := protocol.ContainerRuntimeFact{Name: "docker"}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := c.Docker.Ping(cctx, client.PingOptions{}); err != nil {
		rt.Error = errString(err)
		return rt
	}
	ver, err := c.Docker.ServerVersion(cctx, client.ServerVersionOptions{})
	if err != nil {
		rt.Error = errString(err)
		return rt
	}
	rt.Version, rt.APIVersion = ver.Version, ver.APIVersion
	if strings.Contains(strings.ToLower(ver.Platform.Name), "podman") {
		rt.Name = "podman"
	}
	for _, comp := range ver.Components {
		if strings.Contains(strings.ToLower(comp.Name), "podman") {
			rt.Name = "podman"
		}
	}
	info, err := c.Docker.Info(cctx, client.InfoOptions{})
	if err != nil {
		rt.Error = errString(err)
		return rt
	}
	rt.CgroupVersion, rt.StorageDriver = info.Info.CgroupVersion, info.Info.Driver
	for _, o := range info.Info.SecurityOptions {
		if strings.Contains(o, "name=rootless") {
			rt.Rootless = true
		}
	}
	rt.Healthy = true
	return rt
}

func errString(err error) string {
	s := err.Error()
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

var reMajor = regexp.MustCompile(`^(\d+)`)

// javaImages lists locally available eclipse-temurin images as Java runtimes.
func (c *Collector) javaImages(ctx context.Context) []protocol.JavaRuntimeFact {
	out := []protocol.JavaRuntimeFact{}
	res, err := c.Docker.ImageList(ctx, client.ImageListOptions{Filters: client.Filters{}.Add("reference", "eclipse-temurin")})
	if err != nil {
		return out
	}
	for _, img := range res.Items {
		for _, tag := range img.RepoTags {
			repo, t, ok := strings.Cut(tag, ":")
			if !ok || (repo != "eclipse-temurin" && repo != "docker.io/library/eclipse-temurin") {
				continue
			}
			m := reMajor.FindStringSubmatch(t)
			if m == nil {
				continue
			}
			major, _ := strconv.Atoi(m[1])
			jr := protocol.JavaRuntimeFact{Major: major, Version: t, Vendor: "Eclipse Adoptium", Source: "image", Ref: "eclipse-temurin:" + t}
			if ins, err := c.Docker.ImageInspect(ctx, img.ID); err == nil && ins.Config != nil {
				for _, e := range ins.Config.Env {
					if v, ok := strings.CutPrefix(e, "JAVA_VERSION="); ok {
						v = strings.TrimPrefix(strings.TrimPrefix(v, "jdk-"), "jdk")
						jr.Version = strings.TrimPrefix(v, "-")
					}
				}
			}
			out = append(out, jr)
			if len(out) >= 64 {
				return out
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Major != out[j].Major {
			return out[i].Major > out[j].Major
		}
		return out[i].Ref < out[j].Ref
	})
	return out
}
