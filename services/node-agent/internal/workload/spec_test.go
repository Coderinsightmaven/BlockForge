package workload

import (
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"

	"github.com/blockforge/node-agent/internal/protocol"
)

func testSpec() *protocol.WorkloadSpec {
	cpu := int64(2000)
	stop := "stop"
	return &protocol.WorkloadSpec{
		WorkloadID: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", Kind: "minecraft", Image: "eclipse-temurin:21-jre",
		Command:          []string{"java", "-Xmx1G", "-jar", "server.jar", "nogui"},
		Env:              map[string]string{"TZ": "UTC", "JAVA_TOOL_OPTIONS": "-Dfoo=bar"},
		MemoryLimitBytes: 2 << 30, CPULimitMillicores: &cpu, PidsLimit: 4096,
		Ports:       []protocol.PortBinding{{ContainerPort: 25565, HostPort: 25570, HostIP: "0.0.0.0", Protocol: "tcp"}},
		Networks:    []protocol.WorkloadNetwork{{Name: "bf-net-main", Aliases: []string{"lobby"}}, {Name: "bf-other"}},
		StopCommand: &stop, StopTimeoutMs: 60000,
		RestartPolicy: protocol.RestartPolicy{Mode: "on-failure", MaxRetries: 3, BackoffMs: 10000},
		JvmProbe:      true,
		Labels:        map[string]string{"io.blockforge.server-slug": "lobby", LabelManaged: "false"},
	}
}

func TestBuildCreateOptionsHardening(t *testing.T) {
	h := HostOptions{DataDir: "/var/lib/blockforge/servers/x/data", ProbeJarPath: "/var/lib/blockforge/runtime/jvm-probe.jar", UID: 1000, GID: 1000}
	o, err := BuildCreateOptions(testSpec(), h)
	if err != nil {
		t.Fatal(err)
	}
	c, hc := o.Config, o.HostConfig
	if o.Name != "bf-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" {
		t.Fatalf("name %s", o.Name)
	}
	if c.User != "1000:1000" || c.WorkingDir != "/data" || !c.OpenStdin || c.Tty || c.StdinOnce {
		t.Fatalf("config %+v", c)
	}
	if strings.Join(c.Entrypoint, " ") != "java" || strings.Join(c.Cmd, " ") != "-Xmx1G -jar server.jar nogui" {
		t.Fatalf("argv %v %v", c.Entrypoint, c.Cmd)
	}
	if c.Labels[LabelManaged] != "true" || c.Labels[LabelWorkload] != testSpec().WorkloadID ||
		!strings.HasPrefix(c.Labels[LabelSpecHash], "sha256:") || c.Labels[LabelWatchtower] != "false" ||
		c.Labels["io.blockforge.server-slug"] != "lobby" {
		t.Fatalf("labels %v (reserved labels must not be overridable)", c.Labels)
	}
	envs := strings.Join(c.Env, "\n")
	if !strings.Contains(envs, "JAVA_TOOL_OPTIONS=-javaagent:/opt/blockforge/jvm-probe.jar=/data/.blockforge/jvm.json -Dfoo=bar") ||
		!strings.Contains(envs, "TZ=UTC") || !strings.Contains(envs, "HOME=/tmp") {
		t.Fatalf("env %v", c.Env)
	}
	if !hc.ReadonlyRootfs || hc.Privileged || len(hc.CapDrop) != 1 || hc.CapDrop[0] != "ALL" || len(hc.CapAdd) != 0 {
		t.Fatalf("security %+v", hc)
	}
	if len(hc.SecurityOpt) != 1 || hc.SecurityOpt[0] != "no-new-privileges:true" {
		t.Fatalf("securityopt %v", hc.SecurityOpt)
	}
	if !strings.HasPrefix(hc.Tmpfs["/tmp"], "rw,nosuid,nodev") {
		t.Fatalf("tmpfs %v", hc.Tmpfs)
	}
	if hc.Memory != 2<<30 || hc.MemorySwap != 2<<30 || hc.NanoCPUs != 2_000_000_000 || *hc.PidsLimit != 4096 {
		t.Fatalf("resources %+v", hc.Resources)
	}
	if hc.RestartPolicy.Name != container.RestartPolicyDisabled {
		t.Fatal("docker restart policy must be off (agent-managed)")
	}
	if hc.NetworkMode != "bf-net-main" || hc.NetworkMode.IsHost() || len(o.NetworkingConfig.EndpointsConfig) != 2 ||
		o.NetworkingConfig.EndpointsConfig["bf-net-main"].Aliases[0] != "lobby" {
		t.Fatalf("network %v %+v", hc.NetworkMode, o.NetworkingConfig)
	}
	if len(hc.Mounts) != 2 || hc.Mounts[0].Source != h.DataDir || hc.Mounts[0].Target != "/data" || hc.Mounts[0].ReadOnly ||
		hc.Mounts[1].Target != ProbeJarContainerPath || !hc.Mounts[1].ReadOnly {
		t.Fatalf("mounts %+v", hc.Mounts)
	}
	for _, m := range hc.Mounts {
		if strings.Contains(m.Source, "docker.sock") {
			t.Fatal("docker socket mounted")
		}
	}
	if len(hc.Binds) != 0 || hc.PidMode != "" || hc.UsernsMode != "" || hc.IpcMode != "private" {
		t.Fatalf("namespaces %+v", hc)
	}
	if len(hc.PortBindings) != 1 {
		t.Fatalf("ports %+v", hc.PortBindings)
	}
	for p, b := range hc.PortBindings {
		if p.String() != "25565/tcp" || b[0].HostPort != "25570" || b[0].HostIP.String() != "0.0.0.0" {
			t.Fatalf("binding %v %+v", p, b)
		}
	}

	// No probe, no CPU limit, default bridge.
	s := testSpec()
	s.JvmProbe, s.CPULimitMillicores, s.Networks, s.Env = false, nil, nil, map[string]string{}
	o, _ = BuildCreateOptions(s, h)
	if o.HostConfig.NanoCPUs != 0 || o.HostConfig.NetworkMode != "bridge" || len(o.HostConfig.Mounts) != 1 {
		t.Fatalf("minimal %+v", o.HostConfig)
	}
	for _, e := range o.Config.Env {
		if strings.HasPrefix(e, "JAVA_TOOL_OPTIONS=") {
			t.Fatal("probe option without jvmProbe")
		}
	}
}

func TestSpecHashStable(t *testing.T) {
	h := HostOptions{DataDir: "/d", UID: 1000, GID: 1000}
	a, b := SpecHash(testSpec(), h), SpecHash(testSpec(), h)
	if a != b {
		t.Fatal("hash not deterministic")
	}
	s := testSpec()
	s.MemoryLimitBytes++
	if SpecHash(s, h) == a {
		t.Fatal("hash ignores spec change")
	}
	h2 := h
	h2.UID = 1001
	if SpecHash(testSpec(), h2) == a {
		t.Fatal("hash ignores hardening inputs")
	}
}
