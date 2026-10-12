package agent

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"github.com/blockforge/node-agent/internal/fsops"
)

// TestAgentSFTPAndFileCommands: the agent's SFTP service authenticates through the control plane
// (BFAgent-signed POST /agent/v1/sftp/auth), reports its host key in hello facts, and mutations
// reach the control plane as sftp.activity events. Also exercises the Phase 3 fs commands.
func TestAgentSFTPAndFileCommands(t *testing.T) {
	cp := newFakeCP(t)
	dir, cfg := enrollAgent(t, cp)
	sb := fsops.NewSandbox(cfg.DataRoot, 1000, 1000)
	if err := sb.EnsureDataDir(testWID); err != nil {
		t.Fatal(err)
	}
	startAgent(t, cp, dir)
	hello := cp.waitFrame(30*time.Second, func(m map[string]any) bool { return m["t"] == "hello" })
	facts := hello["facts"].(map[string]any)
	sf, ok := facts["sftp"].(map[string]any)
	if !ok || !strings.HasPrefix(sf["hostKeyFingerprint"].(string), "SHA256:") || sf["port"].(float64) <= 0 {
		t.Fatalf("hello facts sftp: %v", facts["sftp"])
	}
	port := int(sf["port"].(float64))
	if fi, err := os.Stat(filepath.Join(dir, "sftp_host_ed25519_key")); err != nil || (runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600) {
		t.Fatalf("host key file: %v", err)
	}

	var hostKey ssh.PublicKey
	cl, err := ssh.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), &ssh.ClientConfig{
		User: "alice.1a2b3c4d", Auth: []ssh.AuthMethod{ssh.Password(sftpPassword)}, Timeout: 5 * time.Second,
		HostKeyCallback: func(_ string, _ net.Addr, k ssh.PublicKey) error { hostKey = k; return nil },
	})
	if err != nil {
		t.Fatalf("sftp login through the control plane: %v", err)
	}
	defer cl.Close()
	if ssh.FingerprintSHA256(hostKey) != sf["hostKeyFingerprint"] {
		t.Fatal("reported fingerprint does not match the served host key")
	}
	sc, err := sftp.NewClient(cl)
	if err != nil {
		t.Fatal(err)
	}
	defer sc.Close()
	f, err := sc.Create("/start.sh")
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("#!/bin/sh\necho hi\n"))
	f.Close()
	ev := cp.waitFrame(10*time.Second, func(m map[string]any) bool { return m["t"] == "event" && m["event"] == "sftp.activity" })
	d := ev["data"].(map[string]any)
	acts := d["actions"].([]any)
	if d["workloadId"] != testWID || d["clientIp"] != "127.0.0.1" || acts[0].(map[string]any)["action"] != "upload" ||
		acts[0].(map[string]any)["path"] != "start.sh" {
		t.Fatalf("sftp.activity %v", d)
	}
	if _, err := ssh.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), &ssh.ClientConfig{
		User: "alice.1a2b3c4d", Auth: []ssh.AuthMethod{ssh.Password("wrong")}, Timeout: 5 * time.Second,
		HostKeyCallback: ssh.InsecureIgnoreHostKey()}); err == nil {
		t.Fatal("wrong password accepted")
	}

	run := func(typ string, payload map[string]any) map[string]any {
		t.Helper()
		frame := cp.signCmd(nextID(), typ, payload, time.Now(), time.Minute)
		var b struct{ ID string }
		json.Unmarshal([]byte(frame.Body), &b)
		cp.send(frame)
		return cp.result(b.ID, 20*time.Second)
	}
	r := run("fs.chmod", map[string]any{"workloadId": testWID, "path": "start.sh", "mode": 0o755})
	if r["ok"] != true {
		t.Fatalf("chmod %v", r)
	}
	r = run("fs.copy", map[string]any{"workloadId": testWID, "path": "start.sh"})
	if r["ok"] != true || r["data"].(map[string]any)["path"] != "start copy.sh" {
		t.Fatalf("copy %v", r)
	}
	r = run("fs.find", map[string]any{"workloadId": testWID, "path": "", "query": "START"})
	if r["ok"] != true || len(r["data"].(map[string]any)["matches"].([]any)) != 2 || r["data"].(map[string]any)["truncated"] != false {
		t.Fatalf("find %v", r)
	}
	r = run("fs.compress", map[string]any{"workloadId": testWID, "root": "", "paths": []string{"start.sh", "start copy.sh"},
		"format": "zip", "destPath": "scripts.zip", "maxTotalBytes": 1 << 20})
	if r["ok"] != true || r["data"].(map[string]any)["entries"].(float64) != 2 {
		t.Fatalf("compress %v", r)
	}
	r = run("fs.list", map[string]any{"workloadId": testWID, "path": ""})
	if r["ok"] != true || r["data"].(map[string]any)["truncated"] != false {
		t.Fatalf("list %v", r)
	}
	r = run("node.ports", map[string]any{})
	if runtime.GOOS == "linux" {
		if r["ok"] != true {
			t.Fatalf("node.ports %v", r)
		}
		found := false
		for _, p := range r["data"].(map[string]any)["tcp"].([]any) {
			if int(p.(float64)) == port {
				found = true
			}
		}
		if !found {
			t.Fatalf("SFTP port %d missing from node.ports %v", port, r["data"])
		}
	} else if errCode(r) != "RUNTIME_ERROR" {
		t.Fatalf("node.ports off Linux: %v", r)
	}
}
