//go:build integration

package agent

import (
	"encoding/json"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestComposeAgent runs the containerised agent from infra/compose/docker-compose.agent.yml against
// the in-process fake control plane on the host (reached via host.docker.internal). Run natively on
// the Docker Desktop host (not inside the test container): BF_IT_COMPOSE=1 go test -tags integration
// -run TestComposeAgent ./internal/agent/
func TestComposeAgent(t *testing.T) {
	if os.Getenv("BF_IT_COMPOSE") != "1" {
		t.Skip("set BF_IT_COMPOSE=1 to run the compose deployment test")
	}
	cp := newFakeCP(t)
	// Re-listen on all interfaces so the Docker Desktop VM can reach us through host.docker.internal.
	cp.srv.Close()
	ln, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(cp.srv.Config.Handler)
	srv.Listener = ln
	srv.Start()
	defer srv.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	repo, _ := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	compose := filepath.Join(repo, "infra", "compose", "docker-compose.agent.yml")
	dataRoot := "/var/lib/blockforge-compose-it"
	env := append(os.Environ(), "BF_DATA_ROOT="+dataRoot, "BF_DOCKER_GID=0", "MSYS_NO_PATHCONV=1",
		"COMPOSE_PROJECT_NAME=blockforge-agent-it",
		"BLOCKFORGE_ENROLL_TOKEN=bfe_0123456789abcdef_"+strings.Repeat("A", 43))
	dc := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("docker", append([]string{"compose", "-f", compose}, args...)...)
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("docker compose %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	defer func() {
		cmd := exec.Command("docker", "compose", "-f", compose, "down", "-t", "5")
		cmd.Env = env
		cmd.Run()
		exec.Command("docker", "run", "--rm", "-v", dataRoot+":/x", "alpine:3.22", "sh", "-c", "rm -rf /x/agent /x/servers /x/runtime").Run()
	}()
	dc("build", "agent")
	url := "http://host.docker.internal:" + strconv.Itoa(port)
	out := dc("run", "--rm", "-e", "BLOCKFORGE_ENROLL_TOKEN", "agent", "enroll", "--force", "--url", url, "--insecure-allow-http", "--name", "compose-it")
	if !strings.Contains(out, "enrolled: nodeId="+testNodeID) || !strings.Contains(out, "workload=1000:1000") {
		t.Fatalf("enroll output: %s", out)
	}
	dc("up", "-d", "agent")

	hello := cp.waitFrame(90*time.Second, func(m map[string]any) bool { return m["t"] == "hello" })
	facts := hello["facts"].(map[string]any)
	rt, _ := facts["containerRuntime"].(map[string]any)
	if facts["dataRoot"] != dataRoot || rt == nil || rt["healthy"] != true || len(facts["filesystems"].([]any)) == 0 {
		t.Fatalf("hello facts: %v", facts)
	}
	b, _ := json.MarshalIndent(facts, "", " ")
	t.Logf("containerised agent facts:\n%s", b)
	m := cp.waitFrame(60*time.Second, func(m map[string]any) bool { return m["t"] == "metrics" })
	node := m["node"].(map[string]any)
	nb, _ := json.Marshal(node)
	t.Logf("node metrics sample: %s", nb)
	for _, n := range node["network"].([]any) {
		name := n.(map[string]any)["iface"].(string)
		if strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "br-") || name == "docker0" || name == "lo" {
			t.Fatalf("excluded interface %s in metrics", name)
		}
	}
	nf := cp.signCmd(nextID(), "node.facts", map[string]any{}, time.Now(), time.Minute)
	var id struct{ ID string }
	json.Unmarshal([]byte(nf.Body), &id)
	cp.send(nf)
	if r := cp.result(id.ID, 60*time.Second); r["ok"] != true {
		t.Fatalf("node.facts: %v", r)
	}
	ps, _ := exec.Command("docker", "inspect", "-f", "{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.NetworkMode}}", "blockforge-agent").CombinedOutput()
	t.Logf("agent container: %s", ps)
	if !strings.HasPrefix(string(ps), "1000:1000 true [ALL] host") {
		t.Fatalf("agent container hardening: %s", ps)
	}
}
