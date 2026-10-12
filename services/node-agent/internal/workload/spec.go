// Package workload is the Docker workload driver: hardened containers named bf-<workloadId>,
// idempotent ensure by spec hash, lifecycle (start/stop/kill/remove), Docker event watching,
// an agent-side restart policy, log following and a persistent stdin attach for the console.
//
// The driver only ever lists, inspects, attaches to or controls containers carrying the label
// io.blockforge.managed=true, and only creates/uses networks named bf-*.
package workload

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	"github.com/blockforge/node-agent/internal/protocol"
)

// Labels set on every managed container.
const (
	LabelManaged  = "io.blockforge.managed"
	LabelWorkload = "io.blockforge.workload"
	LabelSpecHash = "io.blockforge.spec-hash"
	LabelKind     = "io.blockforge.kind"
	// LabelNode marks bf-* networks with the id of the node agent that created them.
	LabelNode       = "io.blockforge.node"
	LabelWatchtower = "com.centurylinklabs.watchtower.enable"

	// ProbeJarContainerPath is where the JVM probe is bind-mounted read-only.
	ProbeJarContainerPath = "/opt/blockforge/jvm-probe.jar"
	// ProbeOutputContainerPath is where the probe writes its JSON (inside the data dir).
	ProbeOutputContainerPath = "/data/.blockforge/jvm.json"

	// hardeningVersion is part of the spec hash so changes to the hardening profile recreate containers.
	hardeningVersion = "h1"
	tmpfsSize        = "268435456" // 256 MiB /tmp (counts against the memory limit)
)

// ContainerName is the Docker name of a workload container.
func ContainerName(workloadID string) string { return "bf-" + workloadID }

// HostOptions are agent-side settings that shape every container.
type HostOptions struct {
	DataDir      string // host path of <dataRoot>/servers/<id>/data
	ProbeJarPath string // host path of <dataRoot>/runtime/jvm-probe.jar
	UID, GID     int
}

// SpecHash is a stable digest of the spec plus the agent-side hardening inputs.
func SpecHash(spec *protocol.WorkloadSpec, h HostOptions) string {
	b, _ := json.Marshal(struct {
		Spec      *protocol.WorkloadSpec `json:"spec"`
		Hardening string                 `json:"hardening"`
		UID       int                    `json:"uid"`
		GID       int                    `json:"gid"`
		DataDir   string                 `json:"dataDir"`
	}{spec, hardeningVersion, h.UID, h.GID, h.DataDir})
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// BuildCreateOptions renders a spec into Docker create options with the mandatory hardening:
// unprivileged UID/GID, no-new-privileges, cap-drop ALL, read-only rootfs + tmpfs /tmp, pids and
// memory limits (swap = memory), NanoCPUs, never privileged / host network / Docker socket,
// /data bind-mount, working dir /data, stdin open without TTY, Docker restart policy off.
func BuildCreateOptions(spec *protocol.WorkloadSpec, h HostOptions) (client.ContainerCreateOptions, error) {
	hash := SpecHash(spec, h)
	labels := map[string]string{}
	for k, v := range spec.Labels {
		labels[k] = v
	}
	labels[LabelManaged] = "true"
	labels[LabelWorkload] = spec.WorkloadID
	labels[LabelSpecHash] = hash
	labels[LabelKind] = spec.Kind
	labels[LabelWatchtower] = "false"

	env := make([]string, 0, len(spec.Env)+2)
	keys := make([]string, 0, len(spec.Env))
	for k := range spec.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	toolOpts := ""
	hasHome := false
	for _, k := range keys {
		if k == "JAVA_TOOL_OPTIONS" {
			toolOpts = spec.Env[k]
			continue
		}
		if k == "HOME" {
			hasHome = true
		}
		env = append(env, k+"="+spec.Env[k])
	}
	if spec.JvmProbe {
		probe := "-javaagent:" + ProbeJarContainerPath + "=" + ProbeOutputContainerPath
		toolOpts = strings.TrimSpace(probe + " " + toolOpts)
	}
	if toolOpts != "" {
		env = append(env, "JAVA_TOOL_OPTIONS="+toolOpts)
	}
	if !hasHome {
		// The image user does not exist in /etc/passwd and the rootfs is read-only.
		env = append(env, "HOME=/tmp")
	}

	exposed := network.PortSet{}
	bindings := network.PortMap{}
	for _, p := range spec.Ports {
		port, err := network.ParsePort(fmt.Sprintf("%d/%s", p.ContainerPort, p.Protocol))
		if err != nil {
			return client.ContainerCreateOptions{}, protocol.Errorf(protocol.CodeValidationFailed, "invalid port %d/%s", p.ContainerPort, p.Protocol)
		}
		ip, err := netip.ParseAddr(p.HostIP)
		if err != nil {
			return client.ContainerCreateOptions{}, protocol.Errorf(protocol.CodeValidationFailed, "invalid hostIp %q", p.HostIP)
		}
		exposed[port] = struct{}{}
		bindings[port] = append(bindings[port], network.PortBinding{HostIP: ip, HostPort: strconv.Itoa(p.HostPort)})
	}

	mounts := []mount.Mount{{
		Type: mount.TypeBind, Source: h.DataDir, Target: "/data",
		BindOptions: &mount.BindOptions{Propagation: mount.PropagationRPrivate},
	}}
	if spec.JvmProbe {
		mounts = append(mounts, mount.Mount{
			Type: mount.TypeBind, Source: h.ProbeJarPath, Target: ProbeJarContainerPath, ReadOnly: true,
			BindOptions: &mount.BindOptions{Propagation: mount.PropagationRPrivate},
		})
	}

	pids := spec.PidsLimit
	init := true
	stopTimeout := int((spec.StopTimeoutMs + 999) / 1000)
	cfg := &container.Config{
		Image:        spec.Image,
		Entrypoint:   []string{spec.Command[0]},
		Cmd:          append([]string{}, spec.Command[1:]...),
		Env:          env,
		User:         fmt.Sprintf("%d:%d", h.UID, h.GID),
		WorkingDir:   "/data",
		OpenStdin:    true,
		StdinOnce:    false,
		Tty:          false,
		AttachStdin:  false,
		AttachStdout: false,
		AttachStderr: false,
		Labels:       labels,
		ExposedPorts: exposed,
		StopSignal:   "SIGTERM",
		StopTimeout:  &stopTimeout,
	}
	if len(cfg.Cmd) == 0 {
		cfg.Cmd = nil
	}
	hc := &container.HostConfig{
		Mounts:         mounts,
		PortBindings:   bindings,
		RestartPolicy:  container.RestartPolicy{Name: container.RestartPolicyDisabled},
		ReadonlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,nosuid,nodev,size=" + tmpfsSize + ",mode=1777"},
		SecurityOpt:    []string{"no-new-privileges:true"},
		CapDrop:        []string{"ALL"},
		Privileged:     false,
		IpcMode:        "private",
		Init:           &init,
		LogConfig:      container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "50m", "max-file": "3"}},
		Resources: container.Resources{
			Memory:     spec.MemoryLimitBytes,
			MemorySwap: spec.MemoryLimitBytes,
			PidsLimit:  &pids,
		},
	}
	if spec.CPULimitMillicores != nil {
		hc.Resources.NanoCPUs = *spec.CPULimitMillicores * 1_000_000
	}
	nc := &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{}}
	if len(spec.Networks) > 0 {
		hc.NetworkMode = container.NetworkMode(spec.Networks[0].Name)
		for _, n := range spec.Networks {
			nc.EndpointsConfig[n.Name] = &network.EndpointSettings{Aliases: append([]string{}, n.Aliases...)}
		}
	} else {
		hc.NetworkMode = "bridge"
	}
	return client.ContainerCreateOptions{
		Name: ContainerName(spec.WorkloadID), Config: cfg, HostConfig: hc, NetworkingConfig: nc,
	}, nil
}
