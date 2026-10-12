package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/auth"
	"github.com/blockforge/node-agent/internal/config"
	"github.com/blockforge/node-agent/internal/enroll"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
)

const testWID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

var cmdSeq = 0x100

func nextID() string {
	cmdSeq++
	return "00000000-0000-4000-8000-" + hexPad(cmdSeq)
}

func hexPad(n int) string {
	s := strings.Repeat("0", 12) + strings.TrimLeft(hex.EncodeToString([]byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)}), "")
	return s[len(s)-12:]
}

type harness struct {
	t      *testing.T
	cp     *fakeCP
	dir    string
	cfg    *config.Config
	cancel context.CancelFunc
	done   chan error
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func enrollAgent(t *testing.T, cp *fakeCP) (string, *config.Config) {
	dir := t.TempDir()
	cfg, err := enroll.Run(context.Background(), enroll.Options{
		URL: cp.srv.URL, Token: "bfe_0123456789abcdef_" + protocol.B64.EncodeToString(make([]byte, 32)),
		NodeName: "test-node", ConfigDir: filepath.Join(dir, "config"), DataRoot: filepath.Join(dir, "data"),
		InsecureAllowHTTP: true, WorkloadUID: 1000, WorkloadGID: 1000, HTTPClient: cp.srv.Client(),
		Facts: func(ctx context.Context, dataRoot string) protocol.NodeFacts {
			return protocol.NodeFacts{Hostname: "t", OS: "linux", Arch: "amd64", CPULogicalCores: 1, DataRoot: dataRoot,
				Interfaces: []protocol.NetworkInterfaceFact{}, Filesystems: []protocol.FilesystemFact{}, JavaRuntimes: []protocol.JavaRuntimeFact{}}
		},
	})
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	// Tests never bind the real SFTP port.
	cfg.SFTP.Listen = "127.0.0.1:0"
	if err := cfg.Save(filepath.Join(dir, "config")); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "config"), cfg
}

func startAgent(t *testing.T, cp *fakeCP, dir string) *harness {
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	a, err := New(cfg, dir, quietLogger())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h := &harness{t: t, cp: cp, dir: dir, cfg: cfg, cancel: cancel, done: make(chan error, 1)}
	go func() { h.done <- a.Run(ctx) }()
	t.Cleanup(h.stop)
	return h
}

func (h *harness) stop() {
	if h.cancel == nil {
		return
	}
	h.cancel()
	select {
	case <-h.done:
	case <-time.After(20 * time.Second):
		h.t.Error("agent did not stop")
	}
	h.cancel = nil
}

func TestEnrollRejections(t *testing.T) {
	cp := newFakeCP(t)
	dir := t.TempDir()
	base := enroll.Options{URL: cp.srv.URL, ConfigDir: dir, DataRoot: filepath.Join(dir, "d"), InsecureAllowHTTP: true,
		WorkloadUID: 1000, WorkloadGID: 1000, HTTPClient: cp.srv.Client(),
		Facts: func(context.Context, string) protocol.NodeFacts { return protocol.NodeFacts{} }}
	o := base
	o.Token = "not-a-token"
	if _, err := enroll.Run(context.Background(), o); err == nil {
		t.Fatal("malformed token accepted")
	}
	o = base
	o.Token = "bfe_ffffffffffffffff_" + strings.Repeat("A", 43)
	if _, err := enroll.Run(context.Background(), o); err == nil || !strings.Contains(err.Error(), "ENROLLMENT_TOKEN_INVALID") {
		t.Fatalf("invalid token: %v", err)
	}
	o.InsecureAllowHTTP = false
	if _, err := enroll.Run(context.Background(), o); err == nil || !strings.Contains(err.Error(), "http") {
		t.Fatalf("http without flag: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, config.ConfigFile)); err == nil {
		t.Fatal("config written on failed enrollment")
	}
}

func TestAgentEndToEndWithFakeControlPlane(t *testing.T) {
	cp := newFakeCP(t)
	dir, cfg := enrollAgent(t, cp)
	if fi, err := os.Stat(filepath.Join(dir, config.KeyFile)); err != nil || (fi.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/') {
		t.Fatalf("key file: %v %v", err, fi)
	}
	// Workload data dir for fs commands (normally created by workload.ensure).
	sb := fsops.NewSandbox(cfg.DataRoot, 1000, 1000)
	if err := sb.EnsureDataDir(testWID); err != nil {
		t.Fatal(err)
	}
	h := startAgent(t, cp, dir)

	hello := cp.waitFrame(30*time.Second, func(m map[string]any) bool { return m["t"] == "hello" })
	var hf protocol.HelloFrame
	b, _ := json.Marshal(hello)
	if err := json.Unmarshal(b, &hf); err != nil || hf.ProtocolVersion != 1 || hf.Facts.DataRoot != cfg.DataRoot || len(hf.Capabilities) == 0 {
		t.Fatalf("hello %+v err %v", hf, err)
	}
	cp.waitFrame(10*time.Second, func(m map[string]any) bool { return m["t"] == "heartbeat" })

	now := time.Now()
	// fs.write → ok
	content := "motd=Hello\nmax-players=20\n"
	writeCmd := cp.signCmd(nextID(), "fs.write", map[string]any{"workloadId": testWID, "path": "server.properties",
		"content": content, "encoding": "utf8", "ifMatchSha256": nil}, now, 5*time.Minute)
	cp.send(writeCmd)
	var bodyID struct{ ID string }
	json.Unmarshal([]byte(writeCmd.Body), &bodyID)
	res := cp.result(bodyID.ID, 10*time.Second)
	sum := sha256.Sum256([]byte(content))
	if res["ok"] != true || res["data"].(map[string]any)["sha256"] != hex.EncodeToString(sum[:]) {
		t.Fatalf("fs.write result %v", res)
	}
	got, _ := os.ReadFile(filepath.Join(sb.DataDir(testWID), "server.properties"))
	if string(got) != content {
		t.Fatalf("file %q", got)
	}
	// Replay of the same frame → identical cached result, no re-execution.
	os.Remove(filepath.Join(sb.DataDir(testWID), "server.properties"))
	cp.send(writeCmd)
	res2 := cp.result(bodyID.ID, 10*time.Second)
	if res2["ok"] != true || res2["ts"] != res["ts"] {
		t.Fatalf("replay not served from cache: %v", res2)
	}
	if _, err := os.Stat(filepath.Join(sb.DataDir(testWID), "server.properties")); err == nil {
		t.Fatal("replayed command was executed again")
	}

	// Tampered signature → COMMAND_REJECTED.
	bad := cp.signCmd(nextID(), "workload.kill", map[string]any{"workloadId": testWID}, now, time.Minute)
	bad.Body = strings.Replace(bad.Body, "workload.kill", "workload.stop", 1)
	cp.send(bad)
	json.Unmarshal([]byte(bad.Body), &bodyID)
	if r := cp.result(bodyID.ID, 10*time.Second); errCode(r) != "COMMAND_REJECTED" {
		t.Fatalf("bad sig: %v", r)
	}
	// Expired (past expiresAt + 30 s grace) → COMMAND_REJECTED.
	exp := cp.signCmd(nextID(), "node.facts", map[string]any{}, now.Add(-10*time.Minute), time.Minute)
	cp.send(exp)
	json.Unmarshal([]byte(exp.Body), &bodyID)
	if r := cp.result(bodyID.ID, 10*time.Second); errCode(r) != "COMMAND_REJECTED" {
		t.Fatalf("expired: %v", r)
	}
	// Lifetime > 15 min → COMMAND_REJECTED.
	long := cp.signCmd(nextID(), "node.facts", map[string]any{}, now, time.Hour)
	cp.send(long)
	json.Unmarshal([]byte(long.Body), &bodyID)
	if r := cp.result(bodyID.ID, 10*time.Second); errCode(r) != "COMMAND_REJECTED" {
		t.Fatalf("lifetime: %v", r)
	}
	// Unknown type → UNSUPPORTED_COMMAND.
	unk := cp.signCmd(nextID(), "backup.create", map[string]any{}, now, time.Minute)
	cp.send(unk)
	json.Unmarshal([]byte(unk.Body), &bodyID)
	if r := cp.result(bodyID.ID, 10*time.Second); errCode(r) != "UNSUPPORTED_COMMAND" {
		t.Fatalf("unknown type: %v", r)
	}
	// Root delete → VALIDATION_FAILED.
	rd := cp.signCmd(nextID(), "fs.delete", map[string]any{"workloadId": testWID, "path": "./", "recursive": true}, now, time.Minute)
	cp.send(rd)
	json.Unmarshal([]byte(rd.Body), &bodyID)
	if r := cp.result(bodyID.ID, 10*time.Second); errCode(r) != "VALIDATION_FAILED" {
		t.Fatalf("root delete: %v", r)
	}
	if _, err := os.Stat(sb.DataDir(testWID)); err != nil {
		t.Fatal("data root deleted")
	}
	// node.probe tcp against the fake CP itself.
	host, port := hostPort(t, cp.srv.URL)
	pr := cp.signCmd(nextID(), "node.probe", map[string]any{"host": host, "port": port, "kind": "tcp"}, now, time.Minute)
	cp.send(pr)
	json.Unmarshal([]byte(pr.Body), &bodyID)
	if r := cp.result(bodyID.ID, 10*time.Second); r["ok"] != true || r["data"].(map[string]any)["reachable"] != true {
		t.Fatalf("probe: %v", r)
	}
	// Transfers: push a file to the CP, pull it back elsewhere, both with BFAgent auth.
	os.WriteFile(filepath.Join(sb.DataDir(testWID), "world.zip"), []byte("ZIPDATA"), 0o644)
	tid := "11111111-2222-4333-8444-555555555555"
	push := cp.signCmd(nextID(), "fs.transfer.push", map[string]any{"workloadId": testWID, "path": "world.zip", "transferId": tid}, now, time.Minute)
	cp.send(push)
	json.Unmarshal([]byte(push.Body), &bodyID)
	if r := cp.result(bodyID.ID, 10*time.Second); r["ok"] != true {
		t.Fatalf("push: %v", r)
	}
	pull := cp.signCmd(nextID(), "fs.transfer.pull", map[string]any{"workloadId": testWID, "path": "restore/world.zip", "transferId": tid, "maxBytes": 1024}, now, time.Minute)
	cp.send(pull)
	json.Unmarshal([]byte(pull.Body), &bodyID)
	if r := cp.result(bodyID.ID, 10*time.Second); r["ok"] != true {
		t.Fatalf("pull: %v", r)
	}
	if b, _ := os.ReadFile(filepath.Join(sb.DataDir(testWID), "restore", "world.zip")); string(b) != "ZIPDATA" {
		t.Fatalf("pulled %q", b)
	}
	// Metrics frames arrive and validate against the struct.
	m := cp.waitFrame(15*time.Second, func(m map[string]any) bool { return m["t"] == "metrics" })
	var mf protocol.MetricsFrame
	mb, _ := json.Marshal(m)
	if err := json.Unmarshal(mb, &mf); err != nil || mf.Node.Memory.TotalBytes <= 0 || mf.Node.CPU.UsagePct > 100 {
		t.Fatalf("metrics %v %v", err, m)
	}

	// --- staged credential rotation (§3.1) ---
	oldPub := auth.PublicKeyB64(mustKey(t, filepath.Join(dir, config.KeyFile)))
	rot := cp.signCmd(nextID(), "credentials.rotate", map[string]any{}, time.Now(), time.Minute)
	json.Unmarshal([]byte(rot.Body), &bodyID)
	rotID := bodyID.ID
	cp.send(rot)
	r := cp.result(rotID, 10*time.Second)
	data := r["data"].(map[string]any)
	nextPub, proof := data["publicKey"].(string), data["proof"].(string)
	pk, err := auth.ParsePublicKeyB64(nextPub)
	if err != nil || !auth.VerifyRotationProof(pk, testNodeID, rotID, proof) || nextPub == oldPub {
		t.Fatalf("rotation proof invalid: %v", r)
	}
	if _, err := os.Stat(filepath.Join(dir, config.NextKeyFile)); err != nil {
		t.Fatal("agent.key.next not persisted")
	}
	cp.mu.Lock()
	cp.pendingKey = pk
	connectsBefore := cp.connects
	cp.mu.Unlock()
	// The agent closes and reconnects with the next key; promotion happens after welcome.
	cp.waitFrame(30*time.Second, func(m map[string]any) bool { return m["t"] == "hello" })
	waitFor(t, 10*time.Second, func() bool {
		_, err := os.Stat(filepath.Join(dir, config.NextKeyFile))
		return os.IsNotExist(err) && auth.PublicKeyB64(mustKey(t, filepath.Join(dir, config.KeyFile))) == nextPub
	})
	cp.mu.Lock()
	if cp.connects <= connectsBefore || cp.authWith[len(cp.authWith)-1] != "pending" {
		t.Fatalf("reconnect did not use the pending key: %v", cp.authWith)
	}
	cp.mu.Unlock()

	// Rotation where the control plane refuses the pending key: agent falls back and discards it.
	rot2 := cp.signCmd(nextID(), "credentials.rotate", map[string]any{}, time.Now(), time.Minute)
	json.Unmarshal([]byte(rot2.Body), &bodyID)
	cp.mu.Lock()
	cp.rejectPending = true
	cp.mu.Unlock()
	cp.send(rot2)
	r = cp.result(bodyID.ID, 10*time.Second)
	if r["ok"] != true {
		t.Fatalf("rotate 2: %v", r)
	}
	cp.waitFrame(90*time.Second, func(m map[string]any) bool { return m["t"] == "hello" })
	if _, err := os.Stat(filepath.Join(dir, config.NextKeyFile)); !os.IsNotExist(err) {
		t.Fatal("rejected staged key not discarded")
	}
	if auth.PublicKeyB64(mustKey(t, filepath.Join(dir, config.KeyFile))) != nextPub {
		t.Fatal("current key changed although the staged key was rejected")
	}

	// --- restart replay: a command id seen before the restart is rejected after it ---
	h.stop()
	cp.mu.Lock()
	cp.approved = false // also exercise pending-approval gating
	cp.mu.Unlock()
	startAgent(t, cp, dir)
	cp.waitFrame(30*time.Second, func(m map[string]any) bool { return m["t"] == "hello" })
	time.Sleep(200 * time.Millisecond)
	cp.send(writeCmd)
	json.Unmarshal([]byte(writeCmd.Body), &bodyID)
	if r := cp.result(bodyID.ID, 10*time.Second); errCode(r) != "COMMAND_REJECTED" ||
		!strings.Contains(r["error"].(map[string]any)["message"].(string), "duplicate") {
		t.Fatalf("restart replay: %v", r)
	}
	// Pending approval: mutations refused, node.facts allowed.
	mk := cp.signCmd(nextID(), "fs.mkdir", map[string]any{"workloadId": testWID, "path": "x"}, time.Now(), time.Minute)
	cp.send(mk)
	json.Unmarshal([]byte(mk.Body), &bodyID)
	if r := cp.result(bodyID.ID, 10*time.Second); errCode(r) != "COMMAND_REJECTED" {
		t.Fatalf("unapproved mutation: %v", r)
	}
	nf := cp.signCmd(nextID(), "node.facts", map[string]any{}, time.Now(), time.Minute)
	cp.send(nf)
	json.Unmarshal([]byte(nf.Body), &bodyID)
	if r := cp.result(bodyID.ID, 30*time.Second); r["ok"] != true {
		t.Fatalf("unapproved node.facts: %v", r)
	}
}

func mustKey(t *testing.T, p string) []byte {
	k, err := auth.LoadKey(p)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func waitFor(t *testing.T, d time.Duration, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func hostPort(t *testing.T, raw string) (string, int) {
	u := strings.TrimPrefix(raw, "http://")
	i := strings.LastIndex(u, ":")
	var p int
	for _, c := range u[i+1:] {
		p = p*10 + int(c-'0')
	}
	return u[:i], p
}
