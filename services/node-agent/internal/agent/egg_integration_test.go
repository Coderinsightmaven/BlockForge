//go:build integration && linux

package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/enroll"
	"github.com/blockforge/node-agent/internal/protocol"
)

// egg is the subset of a PTDL_v2 egg the test needs (the control plane's egg importer does this in
// production).
type egg struct {
	Name         string            `json:"name"`
	DockerImages map[string]string `json:"docker_images"`
	Startup      string            `json:"startup"`
	Config       struct {
		Startup string `json:"startup"`
		Stop    string `json:"stop"`
	} `json:"config"`
	Scripts struct {
		Installation struct {
			Script     string `json:"script"`
			Container  string `json:"container"`
			Entrypoint string `json:"entrypoint"`
		} `json:"installation"`
	} `json:"scripts"`
	Variables []struct {
		Env     string `json:"env_variable"`
		Default string `json:"default_value"`
	} `json:"variables"`
}

func loadEgg(t *testing.T, name string) *egg {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var e egg
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatal(err)
	}
	return &e
}

func (e *egg) done(t *testing.T) string {
	var d struct {
		Done string `json:"done"`
	}
	if err := json.Unmarshal([]byte(e.Config.Startup), &d); err != nil || d.Done == "" {
		t.Fatalf("egg done string: %v", err)
	}
	return d.Done
}

// stop maps the egg stop field: "^C" = SIGINT (Wings semantics), anything else = console command.
func (e *egg) stop() map[string]any {
	switch e.Config.Stop {
	case "^C":
		return map[string]any{"type": "signal", "signal": "SIGINT"}
	case "^\\":
		return map[string]any{"type": "signal", "signal": "SIGQUIT"}
	}
	return map[string]any{"type": "command", "command": e.Config.Stop}
}

func (e *egg) env(overrides map[string]string) map[string]string {
	env := map[string]string{"STARTUP": e.Startup, "TZ": "UTC"}
	for _, v := range e.Variables {
		env[v.Env] = v.Default
	}
	for k, v := range overrides {
		env[k] = v
	}
	return env
}

type eggRun struct {
	t   *testing.T
	cp  *fakeCP
	wid string
}

func (r *eggRun) do(typ string, payload any, timeout time.Duration) map[string]any {
	r.t.Helper()
	f := r.cp.signCmd(nextID(), typ, payload, time.Now(), 14*time.Minute)
	var b struct{ ID string }
	json.Unmarshal([]byte(f.Body), &b)
	start := time.Now()
	r.cp.send(f)
	res := r.cp.result(b.ID, timeout)
	if res["ok"] != true {
		r.t.Fatalf("%s failed: %v", typ, res)
	}
	r.t.Logf("%s ok in %v", typ, time.Since(start).Round(time.Millisecond))
	return res["data"].(map[string]any)
}

// cleanup removes the workload and waits for the agent's answer (never fails the test).
func (r *eggRun) cleanup() {
	f := r.cp.signCmd(nextID(), "workload.remove", map[string]any{"workloadId": r.wid, "deleteData": true}, time.Now(), time.Minute)
	var b struct{ ID string }
	json.Unmarshal([]byte(f.Body), &b)
	r.cp.send(f)
	deadline := time.After(60 * time.Second)
	for {
		select {
		case m := <-r.cp.frames:
			if m["t"] == "result" && m["id"] == b.ID {
				if m["ok"] != true {
					r.t.Logf("cleanup: remove failed: %v", m)
				}
				return
			}
		case <-deadline:
			r.t.Logf("cleanup: no answer to workload.remove")
			return
		}
	}
}

func randomUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func (r *eggRun) waitLog(source, needle string, timeout time.Duration) {
	r.t.Helper()
	r.cp.waitFrame(timeout, func(m map[string]any) bool {
		if m["t"] != "logs" || m["workloadId"] != r.wid {
			return false
		}
		if src, _ := m["source"].(string); (src == "install") != (source == "install") {
			return false
		}
		for _, l := range m["lines"].([]any) {
			if line := l.(map[string]any)["line"].(string); strings.Contains(line, needle) {
				r.t.Logf("[%s] %s", source, line)
				return true
			}
		}
		return false
	})
}

func startEggAgent(t *testing.T) (*fakeCP, string) {
	root := os.Getenv("BF_IT_DATA_ROOT")
	if root == "" || os.Getenv("BF_IT_EGG") != "1" {
		t.Skip("set BF_IT_DATA_ROOT and BF_IT_EGG=1 (scripts/test-linux.sh -tags integration)")
	}
	cp := newFakeCP(t)
	dataRoot := filepath.Join(root, "egg-"+nextID()[28:])
	dir := filepath.Join(t.TempDir(), "config")
	cfg, err := enroll.Run(context.Background(), enroll.Options{
		URL: cp.srv.URL, Token: "bfe_0123456789abcdef_" + protocol.B64.EncodeToString(make([]byte, 32)),
		ConfigDir: dir, DataRoot: dataRoot, InsecureAllowHTTP: true, WorkloadUID: 1000, WorkloadGID: 1000,
		HTTPClient: cp.srv.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg.SFTP.Listen = "127.0.0.1:0"
	cfg.Save(dir)
	t.Cleanup(func() { os.RemoveAll(dataRoot) })
	startAgent(t, cp, dir)
	cp.waitFrame(60*time.Second, func(m map[string]any) bool { return m["t"] == "hello" })
	return cp, dataRoot
}

// TestVanillaMinecraftEgg runs the official Pterodactyl Vanilla Minecraft egg: yolks:java_21 with the
// image entrypoint evaluating STARTUP, data at /home/container, the egg install script in
// installers:alpine, the egg's done string, SLP, and the egg's "stop" console command.
func TestVanillaMinecraftEgg(t *testing.T) {
	cp, dataRoot := startEggAgent(t)
	e := loadEgg(t, "egg-vanilla-minecraft.json")
	r := &eggRun{t: t, cp: cp, wid: randomUUID()}
	defer r.cleanup()
	image := e.DockerImages["Java 21"]
	env := e.env(map[string]string{"VANILLA_VERSION": "1.21.8", "SERVER_MEMORY": "1536", "SERVER_IP": "0.0.0.0",
		"SERVER_PORT": "25565", "P_SERVER_UUID": r.wid})
	ens := r.do("workload.ensure", map[string]any{
		"workloadId": r.wid, "kind": "minecraft", "image": image, "entrypoint": "image", "command": []string{},
		"env": env, "dataMountPath": "/home/container", "readOnlyRootfs": true,
		"memoryLimitBytes": 2 << 30, "cpuLimitMillicores": 2000,
		"ports": []map[string]any{{"containerPort": 25565, "hostPort": 25574, "hostIp": "127.0.0.1", "protocol": "tcp"}},
		"stop":  e.stop(), "stopTimeoutMs": 60000,
		"restartPolicy": map[string]any{"mode": "never"}, "jvmProbe": true,
	}, 15*time.Minute)
	if ens["created"] != true {
		t.Fatalf("ensure %v", ens)
	}
	inst := r.do("workload.install", map[string]any{
		"workloadId": r.wid, "image": e.Scripts.Installation.Container, "entrypoint": e.Scripts.Installation.Entrypoint,
		"script": e.Scripts.Installation.Script, "env": map[string]string{"SERVER_JARFILE": env["SERVER_JARFILE"], "VANILLA_VERSION": env["VANILLA_VERSION"]},
		"memoryLimitBytes": 512 << 20, "cpuLimitMillicores": nil, "timeoutMs": 600000,
	}, 15*time.Minute)
	tail := inst["logTail"].([]any)
	t.Logf("install: exitCode=%v durationMs=%v timedOut=%v lastLine=%v", inst["exitCode"], inst["durationMs"], inst["timedOut"], tail[len(tail)-1])
	if inst["exitCode"].(float64) != 0 || inst["timedOut"] != false {
		t.Fatalf("install %v", inst)
	}
	st := r.do("fs.stat", map[string]any{"workloadId": r.wid, "path": "server.jar"}, time.Minute)
	if st["size"].(float64) < 1<<20 {
		t.Fatalf("server.jar %v", st)
	}
	r.do("fs.write", map[string]any{"workloadId": r.wid, "path": "eula.txt", "content": "eula=true\n", "encoding": "utf8", "ifMatchSha256": nil}, time.Minute)
	r.do("workload.start", map[string]any{"workloadId": r.wid}, 5*time.Minute)
	started := time.Now()
	r.waitLog("workload", "container@pterodactyl~", time.Minute)
	r.waitLog("workload", e.done(t), 8*time.Minute)
	t.Logf("egg done string %q seen %v after start", e.done(t), time.Since(started).Round(time.Second))
	probe := r.do("node.probe", map[string]any{"host": "127.0.0.1", "port": 25574, "kind": "minecraft", "timeoutMs": 5000}, time.Minute)
	mc := probe["minecraft"].(map[string]any)
	t.Logf("SLP: %v", mc)
	if probe["reachable"] != true || mc["playersMax"].(float64) != 20 || mc["versionName"] != "1.21.8" {
		t.Fatalf("probe %v", probe)
	}
	// JVM probe works with the egg runtime (/home/container/.blockforge/jvm.json).
	cp.waitFrame(60*time.Second, func(m map[string]any) bool {
		if m["t"] != "metrics" {
			return false
		}
		for _, w := range m["workloads"].([]any) {
			w := w.(map[string]any)
			if w["workloadId"] == r.wid && w["jvm"] != nil {
				t.Logf("jvm: %v", w["jvm"])
				return true
			}
		}
		return false
	})
	stop := r.do("workload.stop", map[string]any{"workloadId": r.wid, "timeoutMs": 60000}, 3*time.Minute)
	t.Logf("stopped: state=%v exitCode=%v", stop["state"], stop["exitCode"])
	if stop["state"] != "exited" || stop["exitCode"].(float64) != 0 {
		t.Fatalf("graceful stop %v", stop)
	}
	if fi, err := os.Stat(filepath.Join(dataRoot, "servers", r.wid, "data", "world", "level.dat")); err != nil || fi.Size() == 0 {
		t.Fatalf("world not saved: %v", err)
	}
}

// TestTeamSpeakEggSignalStop runs the official TeamSpeak 3 egg (yolks:debian, stop "^C" = SIGINT).
func TestTeamSpeakEggSignalStop(t *testing.T) {
	cp, _ := startEggAgent(t)
	e := loadEgg(t, "egg-teamspeak3-server.json")
	r := &eggRun{t: t, cp: cp, wid: randomUUID()}
	defer r.cleanup()
	env := e.env(map[string]string{"SERVER_PORT": "9987", "SERVER_IP": "0.0.0.0", "SERVER_MEMORY": "512", "P_SERVER_UUID": r.wid})
	var image string
	for _, img := range e.DockerImages {
		image = img
	}
	if e.stop()["signal"] != "SIGINT" {
		t.Fatalf("egg stop %q", e.Config.Stop)
	}
	r.do("workload.ensure", map[string]any{
		"workloadId": r.wid, "kind": "generic", "image": image, "entrypoint": "image", "command": []string{},
		"env": env, "dataMountPath": "/home/container", "readOnlyRootfs": true,
		"memoryLimitBytes": 512 << 20, "cpuLimitMillicores": 1000,
		"ports": []map[string]any{
			{"containerPort": 9987, "hostPort": 29987, "hostIp": "127.0.0.1", "protocol": "udp"},
			{"containerPort": 10011, "hostPort": 20011, "hostIp": "127.0.0.1", "protocol": "tcp"},
		},
		"stop": e.stop(), "stopTimeoutMs": 30000, "restartPolicy": map[string]any{"mode": "on-failure"}, "jvmProbe": false,
	}, 15*time.Minute)
	inst := r.do("workload.install", map[string]any{
		"workloadId": r.wid, "image": e.Scripts.Installation.Container, "entrypoint": e.Scripts.Installation.Entrypoint,
		"script": e.Scripts.Installation.Script, "env": map[string]string{"TS_VERSION": env["TS_VERSION"]},
		"memoryLimitBytes": 512 << 20, "cpuLimitMillicores": nil, "timeoutMs": 600000,
	}, 15*time.Minute)
	t.Logf("install: exitCode=%v durationMs=%v", inst["exitCode"], inst["durationMs"])
	if inst["exitCode"].(float64) != 0 {
		t.Fatalf("install %v", inst)
	}
	r.do("workload.start", map[string]any{"workloadId": r.wid}, 5*time.Minute)
	r.waitLog("workload", e.done(t), 3*time.Minute)
	probe := r.do("node.probe", map[string]any{"host": "127.0.0.1", "port": 20011, "kind": "tcp", "timeoutMs": 3000}, time.Minute)
	if probe["reachable"] != true {
		t.Fatalf("query port %v", probe)
	}
	stopStart := time.Now()
	stop := r.do("workload.stop", map[string]any{"workloadId": r.wid, "timeoutMs": 30000}, 2*time.Minute)
	took := time.Since(stopStart)
	t.Logf("SIGINT stop: state=%v exitCode=%v in %v", stop["state"], stop["exitCode"], took.Round(time.Millisecond))
	// 130 = 128 + SIGINT (docker-init reports the child's terminating signal): the stop was delivered
	// as SIGINT, not escalated to SIGTERM (143) or SIGKILL (137).
	if stop["state"] != "exited" || stop["exitCode"].(float64) != 130 || took > 25*time.Second {
		t.Fatalf("signal stop: %v after %v", stop, took)
	}
	// on-failure must not restart after a deliberate stop.
	time.Sleep(3 * time.Second)
	if s := r.do("workload.status", map[string]any{"workloadId": r.wid}, time.Minute); s["workloads"].([]any)[0].(map[string]any)["state"] != "exited" {
		t.Fatalf("restarted after stop: %v", s)
	}
}
