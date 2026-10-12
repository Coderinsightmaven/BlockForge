//go:build integration && linux

package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/config"
	"github.com/blockforge/node-agent/internal/enroll"
	"github.com/blockforge/node-agent/internal/protocol"
)

// TestPaperEndToEnd drives a real Paper server through signed commands: ensure → artifact.fetch
// (fill-data.papermc.io, sha256 verified) → fs.write → start → "Done (" → SLP via metrics and
// node.probe → console → graceful stop → remove. Needs Internet access; enable with BF_IT_PAPER=1.
func TestPaperEndToEnd(t *testing.T) {
	root := os.Getenv("BF_IT_DATA_ROOT")
	if root == "" || os.Getenv("BF_IT_PAPER") != "1" {
		t.Skip("set BF_IT_DATA_ROOT and BF_IT_PAPER=1 (scripts/test-linux.sh -tags integration)")
	}
	version := os.Getenv("BF_IT_PAPER_VERSION")
	if version == "" {
		version = "1.21.8"
	}
	cp := newFakeCP(t)
	dataRoot := filepath.Join(root, "paper-"+nextID()[24:])
	dir := filepath.Join(t.TempDir(), "config")
	_, err := enroll.Run(context.Background(), enroll.Options{
		URL: cp.srv.URL, Token: "bfe_0123456789abcdef_" + protocol.B64.EncodeToString(make([]byte, 32)),
		ConfigDir: dir, DataRoot: dataRoot, InsecureAllowHTTP: true, WorkloadUID: 1000, WorkloadGID: 1000,
		HTTPClient: cp.srv.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dataRoot)
	startAgent(t, cp, dir)
	cp.waitFrame(60*time.Second, func(m map[string]any) bool { return m["t"] == "hello" })

	// Resolve the build from the Fill v3 API (the control plane's catalogue does this in production).
	resp, err := http.Get("https://fill.papermc.io/v3/projects/paper/versions/" + version + "/builds/latest")
	if err != nil {
		t.Fatal(err)
	}
	var build struct {
		ID        int `json:"id"`
		Downloads map[string]struct {
			Name      string            `json:"name"`
			Size      int64             `json:"size"`
			URL       string            `json:"url"`
			Checksums map[string]string `json:"checksums"`
		} `json:"downloads"`
	}
	json.NewDecoder(resp.Body).Decode(&build)
	resp.Body.Close()
	dl := build.Downloads["server:default"]
	if dl.URL == "" || dl.Checksums["sha256"] == "" {
		t.Fatalf("fill API: %+v", build)
	}
	t.Logf("paper %s build %d: %s (%d bytes, sha256 %s)", version, build.ID, dl.URL, dl.Size, dl.Checksums["sha256"])

	wid := "7e1c2b9a-4d3e-4f5a-9b8c-" + nextID()[24:]
	net := "bf-it-paper-" + nextID()[30:]
	do := func(typ string, payload any, timeout time.Duration) map[string]any {
		t.Helper()
		f := cp.signCmd(nextID(), typ, payload, time.Now(), 10*time.Minute)
		var b struct{ ID string }
		json.Unmarshal([]byte(f.Body), &b)
		start := time.Now()
		cp.send(f)
		r := cp.result(b.ID, timeout)
		if r["ok"] != true {
			t.Fatalf("%s failed: %v", typ, r)
		}
		t.Logf("%s ok in %v", typ, time.Since(start).Round(time.Millisecond))
		return r
	}
	defer func() {
		f := cp.signCmd(nextID(), "workload.remove", map[string]any{"workloadId": wid, "deleteData": true}, time.Now(), time.Minute)
		cp.send(f)
		time.Sleep(3 * time.Second)
	}()

	spec := map[string]any{
		"workloadId": wid, "kind": "minecraft", "image": "eclipse-temurin:21-jre",
		"command":          []string{"java", "-Xms512M", "-Xmx1024M", "-jar", "server.jar", "nogui"},
		"env":              map[string]string{"TZ": "UTC"},
		"memoryLimitBytes": 2 << 30, "cpuLimitMillicores": 2000, "pidsLimit": 4096,
		"ports":       []map[string]any{{"containerPort": 25565, "hostPort": 25571, "hostIp": "127.0.0.1", "protocol": "tcp"}},
		"networks":    []map[string]any{{"name": net, "aliases": []string{"paper"}}},
		"stopCommand": "stop", "stopTimeoutMs": 60000,
		"restartPolicy": map[string]any{"mode": "on-failure", "maxRetries": 3, "backoffMs": 10000},
		"jvmProbe":      true,
	}
	r := do("workload.ensure", spec, 10*time.Minute)
	if r["data"].(map[string]any)["created"] != true {
		t.Fatalf("ensure: %v", r)
	}
	r = do("artifact.fetch", map[string]any{"workloadId": wid, "url": dl.URL, "destPath": "server.jar",
		"checksum": map[string]any{"algorithm": "sha256", "value": dl.Checksums["sha256"]}, "maxBytes": 256 << 20}, 10*time.Minute)
	if int64(r["data"].(map[string]any)["bytes"].(float64)) != dl.Size || r["data"].(map[string]any)["sha256"] != dl.Checksums["sha256"] {
		t.Fatalf("fetch: %v", r)
	}
	do("fs.write", map[string]any{"workloadId": wid, "path": "eula.txt", "content": "eula=true\n", "encoding": "utf8", "ifMatchSha256": nil}, time.Minute)
	do("fs.write", map[string]any{"workloadId": wid, "path": "server.properties", "encoding": "utf8",
		"content": "server-port=25565\nmax-players=20\nmotd=BlockForge \\u00a7aIT\nlevel-type=minecraft\\:flat\nview-distance=4\nsimulation-distance=4\n"}, time.Minute)

	startAt := time.Now()
	do("workload.start", map[string]any{"workloadId": wid}, 5*time.Minute)
	logHas := func(needle string, timeout time.Duration) {
		t.Helper()
		cp.waitFrame(timeout, func(m map[string]any) bool {
			if m["t"] != "logs" || m["workloadId"] != wid {
				return false
			}
			for _, l := range m["lines"].([]any) {
				if line := l.(map[string]any)["line"].(string); strings.Contains(line, needle) {
					t.Logf("log: %s", line)
					return true
				}
			}
			return false
		})
	}
	logHas("Done (", 8*time.Minute)
	t.Logf("server ready %v after start", time.Since(startAt).Round(time.Second))

	// Metrics carry SLP (via the container IP on the bf network) and JVM probe stats.
	var wl map[string]any
	cp.waitFrame(90*time.Second, func(m map[string]any) bool {
		if m["t"] != "metrics" {
			return false
		}
		for _, w := range m["workloads"].([]any) {
			w := w.(map[string]any)
			if w["workloadId"] == wid && w["minecraft"] != nil && w["jvm"] != nil && w["cpuPct"] != nil {
				wl = w
				return true
			}
		}
		return false
	})
	mc := wl["minecraft"].(map[string]any)
	jvm := wl["jvm"].(map[string]any)
	if mc["playersOnline"].(float64) != 0 || mc["playersMax"].(float64) != 20 || !strings.Contains(mc["motd"].(string), "BlockForge") {
		t.Fatalf("slp in metrics: %v", mc)
	}
	if jvm["heapMaxBytes"].(float64) <= 0 || jvm["threads"].(float64) <= 0 {
		t.Fatalf("jvm: %v", jvm)
	}
	wb, _ := json.Marshal(wl)
	t.Logf("workload metric sample: %s", wb)

	// node.probe through the published port on loopback.
	r = do("node.probe", map[string]any{"host": "127.0.0.1", "port": 25571, "kind": "minecraft", "timeoutMs": 5000}, time.Minute)
	pm := r["data"].(map[string]any)["minecraft"].(map[string]any)
	if r["data"].(map[string]any)["reachable"] != true || pm["playersMax"].(float64) != 20 || !strings.Contains(pm["versionName"].(string), "1.21") {
		t.Fatalf("probe: %v", r)
	}
	t.Logf("node.probe: %v", r["data"])

	do("workload.console", map[string]any{"workloadId": wid, "line": "list"}, time.Minute)
	logHas("players online", time.Minute)

	r = do("workload.stop", map[string]any{"workloadId": wid, "timeoutMs": 60000}, 3*time.Minute)
	st := r["data"].(map[string]any)
	if st["state"] != "exited" || st["exitCode"].(float64) != 0 {
		t.Fatalf("graceful stop: %v", st)
	}
	t.Logf("stopped gracefully: %v", st)
	r = do("workload.logs.tail", map[string]any{"workloadId": wid, "lines": 50}, time.Minute)
	tail, _ := json.Marshal(r["data"])
	if !strings.Contains(string(tail), "Stopping") {
		t.Fatalf("tail lacks shutdown lines: %s", tail)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "servers", wid, "data", "world")); err != nil {
		t.Fatalf("world not created in sandbox: %v", err)
	}
	_ = config.ConfigFile
}
