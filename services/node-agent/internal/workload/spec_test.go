package workload

import (
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"

	"github.com/blockforge/node-agent/internal/protocol"
)

func testSpec() *protocol.WorkloadSpec {
	cpu := int64(2000)
	stop := &protocol.WorkloadStop{Type: "command", Command: "stop"}
	return &protocol.WorkloadSpec{
		WorkloadID: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", Kind: "minecraft", Image: "eclipse-temurin:21-jre",
		Command:          []string{"java", "-Xmx1G", "-jar", "server.jar", "nogui"},
		Env:              map[string]string{"TZ": "UTC", "JAVA_TOOL_OPTIONS": "-Dfoo=bar"},
		MemoryLimitBytes: 2 << 30, CPULimitMillicores: &cpu, PidsLimit: 4096,
		Ports:    []protocol.PortBinding{{ContainerPort: 25565, HostPort: 25570, HostIP: "0.0.0.0", Protocol: "tcp"}},
		Networks: []protocol.WorkloadNetwork{{Name: "bf-net-main", Aliases: []string{"lobby"}}, {Name: "bf-other"}},
		Stop:     stop, Entrypoint: protocol.EntrypointArgv, DataMountPath: "/data", ReadOnlyRootfs: true, StopTimeoutMs: 60000,
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
		!strings.Contains(envs, "TZ=UTC") || !strings.Contains(envs, "HOME=/data") {
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

func TestBuildCreateOptionsEggRuntime(t *testing.T) {
	h := HostOptions{DataDir: "/srv/bf/servers/x/data", ProbeJarPath: "/srv/bf/runtime/jvm-probe.jar", UID: 1000, GID: 1000}
	s := testSpec()
	s.Kind, s.Image, s.Entrypoint, s.Command = "minecraft", "ghcr.io/pterodactyl/yolks:java_21", protocol.EntrypointImage, nil
	s.DataMountPath, s.ReadOnlyRootfs = "/home/container", false
	s.Env = map[string]string{"STARTUP": "java -jar {{SERVER_JARFILE}}", "SERVER_JARFILE": "server.jar", "server_lower": "ok"}
	s.Stop = &protocol.WorkloadStop{Type: "signal", Signal: "SIGINT"}
	s.Labels[LabelRole] = "install" // reserved: must be stripped
	o, err := BuildCreateOptions(s, h)
	if err != nil {
		t.Fatal(err)
	}
	c, hc := o.Config, o.HostConfig
	if c.Entrypoint != nil || c.Cmd != nil {
		t.Fatalf("image entrypoint/cmd must be kept: %v %v", c.Entrypoint, c.Cmd)
	}
	if hc.Init == nil || !*hc.Init {
		t.Fatal("docker-init must be PID 1 to forward stop signals")
	}
	if c.WorkingDir != "/home/container" || hc.Mounts[0].Target != "/home/container" || hc.ReadonlyRootfs {
		t.Fatalf("mount/rootfs %v %v %v", c.WorkingDir, hc.Mounts[0].Target, hc.ReadonlyRootfs)
	}
	envs := strings.Join(c.Env, "\n")
	for _, want := range []string{"HOME=/home/container", "STARTUP=java -jar {{SERVER_JARFILE}}", "server_lower=ok",
		"-javaagent:/opt/blockforge/jvm-probe.jar=/home/container/.blockforge/jvm.json"} {
		if !strings.Contains(envs, want) {
			t.Fatalf("env missing %q: %v", want, c.Env)
		}
	}
	if _, ok := c.Labels[LabelRole]; ok {
		t.Fatal("reserved role label leaked from spec labels")
	}
	if c.User != "1000:1000" || hc.CapDrop[0] != "ALL" || hc.SecurityOpt[0] != "no-new-privileges:true" || hc.Tmpfs["/tmp"] == "" {
		t.Fatal("hardening must not depend on the runtime mode")
	}
	// Image entrypoint with an explicit command → CMD only.
	s.Command = []string{"--nogui"}
	o, _ = BuildCreateOptions(s, h)
	if o.Config.Entrypoint != nil || len(o.Config.Cmd) != 1 {
		t.Fatalf("cmd %v", o.Config.Cmd)
	}
	// argv without a command is refused.
	s.Entrypoint, s.Command = protocol.EntrypointArgv, nil
	if _, err := BuildCreateOptions(s, h); err == nil {
		t.Fatal("argv without command accepted")
	}
	// The hash covers the new fields.
	a := testSpec()
	b := testSpec()
	b.DataMountPath = "/home/container"
	c2 := testSpec()
	c2.Stop = &protocol.WorkloadStop{Type: "signal", Signal: "SIGINT"}
	if SpecHash(a, h) == SpecHash(b, h) || SpecHash(a, h) == SpecHash(c2, h) {
		t.Fatal("spec hash ignores dataMountPath/stop")
	}
}

func TestNormalizeLegacySpec(t *testing.T) {
	stop := "stop"
	var s protocol.WorkloadSpec
	NormalizeSpec(&s, &stop)
	if s.Entrypoint != "argv" || !s.ReadOnlyRootfs || s.DataMountPath != "/data" || s.Stop == nil || s.Stop.Command != "stop" {
		t.Fatalf("legacy %+v", s)
	}
	n := protocol.WorkloadSpec{Entrypoint: "image", DataMountPath: "/home/container", ReadOnlyRootfs: false}
	NormalizeSpec(&n, nil)
	if n.ReadOnlyRootfs || n.Stop != nil {
		t.Fatalf("current spec altered %+v", n)
	}
}

func TestInstallContainerOptions(t *testing.T) {
	if got := installWrapper("ash", 1000, 1000, true); got != "ash /mnt/install/install.sh; rc=$?; chown -R 1000:1000 /mnt/server; exit $rc" {
		t.Fatalf("wrapper %q", got)
	}
	if got := installWrapper("sh", 988, 988, false); got != "rc=0; chown -R 988:988 /mnt/server; exit $rc" {
		t.Fatalf("chown-only wrapper %q", got)
	}
	cpu := int64(1500)
	d := &Driver{o: Options{NodeID: "5e0c2b9a-4d3e-4f5a-9b8c-7d6e5f4a3b2c", Sandbox: newTestSandbox(t), UID: 1000, GID: 1000}}
	p := &protocol.WorkloadInstallPayload{WorkloadID: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", Image: "ghcr.io/pterodactyl/installers:alpine",
		Entrypoint: "ash", Env: map[string]string{"B": "2", "A": "1"}, MemoryLimitBytes: 512 << 20, CPULimitMillicores: &cpu}
	o := d.installCreateOptions(p, "/srv/bf/servers/x/install", InstallContainerName(p.WorkloadID), []string{"ash", "-c", "x"})
	c, hc := o.Config, o.HostConfig
	if o.Name != "bf-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d-install" || c.User != "0:0" || c.WorkingDir != "/mnt/server" ||
		strings.Join(c.Env, ",") != "A=1,B=2" || c.Labels[LabelRole] != RoleInstall || c.Labels[LabelManaged] != "true" ||
		c.Labels[LabelWatchtower] != "false" || c.Labels[LabelNode] != d.o.NodeID {
		t.Fatalf("config %+v", c)
	}
	if strings.Join(hc.CapDrop, ",") != "ALL" || strings.Join(hc.CapAdd, ",") != "CHOWN,DAC_OVERRIDE,FOWNER,SETUID,SETGID" ||
		hc.SecurityOpt[0] != "no-new-privileges:true" || hc.Privileged || hc.NetworkMode != "bridge" ||
		hc.Memory != 512<<20 || hc.MemorySwap != 512<<20 || hc.NanoCPUs != 1_500_000_000 || *hc.PidsLimit != installPidsLimit {
		t.Fatalf("host config %+v", hc)
	}
	if len(hc.Mounts) != 2 || hc.Mounts[0].Target != "/mnt/server" || hc.Mounts[0].ReadOnly ||
		hc.Mounts[1].Target != "/mnt/install" || !hc.Mounts[1].ReadOnly {
		t.Fatalf("mounts %+v", hc.Mounts)
	}
	for _, m := range hc.Mounts {
		if strings.Contains(m.Source, "docker.sock") {
			t.Fatal("docker socket mounted")
		}
	}
}
