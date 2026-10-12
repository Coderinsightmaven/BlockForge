package protocol_test

import (
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/auth"
	"github.com/blockforge/node-agent/internal/protocol"
)

var fixtureDir = filepath.Join("..", "..", "..", "..", "packages", "contracts", "fixtures", "agent")

type fixtureKeys struct {
	ControlPlane struct {
		SeedHex   string `json:"seedHex"`
		PublicKey string `json:"publicKey"`
	} `json:"controlPlane"`
	Agent struct {
		SeedHex   string `json:"seedHex"`
		PublicKey string `json:"publicKey"`
	} `json:"agent"`
	NodeID     string `json:"nodeId"`
	WorkloadID string `json:"workloadId"`
	Now        int64  `json:"now"`
}

func load(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return b
}

func keys(t *testing.T) fixtureKeys {
	var k fixtureKeys
	if err := json.Unmarshal(load(t, "keys.json"), &k); err != nil {
		t.Fatal(err)
	}
	return k
}

// verifyCommand mirrors verifyCommand() in packages/contracts/test/agent-fixtures.test.ts.
func verifyCommand(t *testing.T, raw []byte, k fixtureKeys, now time.Time) string {
	t.Helper()
	var frame protocol.CommandFrame
	if err := json.Unmarshal(raw, &frame); err != nil || frame.T != "cmd" {
		t.Fatalf("not a command frame: %v", err)
	}
	cpKey, err := auth.ParsePublicKeyB64(k.ControlPlane.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	body, reason := protocol.VerifyCommand(frame, cpKey, k.NodeID, now)
	if reason != "" {
		return reason
	}
	_, known, perr := protocol.ParsePayload(body.Type, body.Payload)
	if !known {
		return "unsupported"
	}
	if perr != nil {
		if perr.Code != protocol.CodeValidationFailed {
			t.Fatalf("unexpected code %s", perr.Code)
		}
		return "invalid-payload"
	}
	return "ok"
}

func TestCommandFixtures(t *testing.T) {
	k := keys(t)
	now := time.UnixMilli(k.Now)
	cases := map[string]string{
		"cmd-workload-start.json":             "ok",
		"cmd-workload-ensure.json":            "ok",
		"cmd-fs-write.json":                   "ok",
		"cmd-artifact-fetch.json":             "ok",
		"cmd-reject-bad-signature.json":       "bad-signature",
		"cmd-reject-wrong-node.json":          "wrong-node",
		"cmd-reject-wrong-key.json":           "bad-signature",
		"cmd-reject-lifetime.json":            "lifetime",
		"cmd-reject-root-delete.json":         "invalid-payload",
		"cmd-reject-reversed-timestamps.json": "lifetime",
		"cmd-credentials-rotate.json":         "ok",
		"cmd-workload-ensure-egg.json":        "ok",
		"cmd-workload-install.json":           "ok",
		"cmd-backup-create.json":              "ok",
		"cmd-backup-restore-url.json":         "ok",
		"cmd-backup-upload.json":              "ok",
	}
	for file, want := range cases {
		t.Run(file, func(t *testing.T) {
			if got := verifyCommand(t, load(t, file), k, now); got != want {
				t.Fatalf("%s: got %q want %q", file, got, want)
			}
		})
	}
}

func TestCommandExpiryGrace(t *testing.T) {
	k := keys(t)
	raw := load(t, "cmd-workload-start.json")
	// expiresAt = now + 300000; accepted up to expiresAt + 30000 inclusive.
	if got := verifyCommand(t, raw, k, time.UnixMilli(k.Now+300_000+30_000)); got != "ok" {
		t.Fatalf("at grace boundary: %s", got)
	}
	if got := verifyCommand(t, raw, k, time.UnixMilli(k.Now+300_000+30_001)); got != "expired" {
		t.Fatalf("past grace: %s", got)
	}
}

func TestPayloadDefaultsApplied(t *testing.T) {
	k := keys(t)
	var frame protocol.CommandFrame
	_ = json.Unmarshal(load(t, "cmd-workload-ensure.json"), &frame)
	cpKey, _ := auth.ParsePublicKeyB64(k.ControlPlane.PublicKey)
	body, reason := protocol.VerifyCommand(frame, cpKey, k.NodeID, time.UnixMilli(k.Now))
	if reason != "" {
		t.Fatal(reason)
	}
	p, _, perr := protocol.ParsePayload(body.Type, body.Payload)
	if perr != nil {
		t.Fatal(perr)
	}
	spec := p.(*protocol.WorkloadSpec)
	if spec.Image != "eclipse-temurin:21-jre" || spec.RestartPolicy.MaxRetries != 3 || !spec.JvmProbe ||
		*spec.CPULimitMillicores != 2000 || spec.Stop == nil || spec.Stop.Type != "command" || spec.Stop.Command != "stop" || spec.Entrypoint != "argv" || spec.DataMountPath != "/data" || !spec.ReadOnlyRootfs || spec.Networks[0].Aliases[0] != "lobby" {
		t.Fatalf("unexpected spec %+v", spec)
	}

	var fw protocol.CommandFrame
	_ = json.Unmarshal(load(t, "cmd-fs-write.json"), &fw)
	body, _ = protocol.VerifyCommand(fw, cpKey, k.NodeID, time.UnixMilli(k.Now))
	p, _, perr = protocol.ParsePayload(body.Type, body.Payload)
	if perr != nil {
		t.Fatal(perr)
	}
	w := p.(*protocol.FsWritePayload)
	if !w.IfMatchSha256.Set || !w.IfMatchSha256.Null || w.CreateParents {
		t.Fatalf("ifMatch null not preserved: %+v", w.IfMatchSha256)
	}
}

// roundTrip unmarshals a fixture into v, re-marshals it, and compares the generic JSON trees.
func roundTrip(t *testing.T, raw []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var a, b any
	_ = json.Unmarshal(raw, &a)
	_ = json.Unmarshal(out, &b)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("round trip mismatch:\nfixture: %s\nours:    %s", raw, out)
	}
}

func TestAgentFrameFixturesRoundTrip(t *testing.T) {
	cases := map[string]func() any{
		"hello.json":                     func() any { return &protocol.HelloFrame{} },
		"heartbeat.json":                 func() any { return &protocol.HeartbeatFrame{} },
		"progress.json":                  func() any { return &protocol.ProgressFrame{} },
		"result-ok.json":                 func() any { return &protocol.ResultFrame{} },
		"result-error.json":              func() any { return &protocol.ResultFrame{} },
		"result-credentials-rotate.json": func() any { return &protocol.ResultFrame{} },
		"event-workload-state.json":      func() any { return &protocol.EventFrame{} },
		"logs.json":                      func() any { return &protocol.LogsFrame{} },
		"metrics.json":                   func() any { return &protocol.MetricsFrame{} },
		"welcome.json":                   func() any { return &protocol.WelcomeFrame{} },
		"enroll-request.json":            func() any { return &protocol.EnrollRequest{} },
		"enroll-response.json":           func() any { return &protocol.EnrollResponse{} },
	}
	for file, mk := range cases {
		t.Run(file, func(t *testing.T) { roundTrip(t, load(t, file), mk()) })
	}
}

func TestNestedDataRoundTrip(t *testing.T) {
	var res protocol.ResultFrame
	_ = json.Unmarshal(load(t, "result-ok.json"), &res)
	roundTrip(t, res.Data, &protocol.WorkloadStatus{})

	var ev protocol.EventFrame
	_ = json.Unmarshal(load(t, "event-workload-state.json"), &ev)
	var st protocol.WorkloadStatus
	roundTrip(t, ev.Data, &st)
	if st.ExitCode == nil || *st.ExitCode != 137 || st.OOMKilled == nil || !*st.OOMKilled {
		t.Fatalf("event status fields lost: %+v", st)
	}

	var m protocol.MetricsFrame
	_ = json.Unmarshal(load(t, "metrics.json"), &m)
	if m.Node.CPU.StealPct == nil || *m.Node.CPU.StealPct != 0 {
		t.Fatal("zero-valued optional field must survive (stealPct: 0)")
	}
	if m.Workloads[0].BlkReadBytesPerSec == nil || *m.Workloads[0].BlkReadBytesPerSec != 0 {
		t.Fatal("blkReadBytesPerSec: 0 must survive")
	}
}

func TestAuthTokenFixture(t *testing.T) {
	k := keys(t)
	var fx struct {
		Header string                    `json:"header"`
		Claims protocol.AgentTokenClaims `json:"claims"`
	}
	if err := json.Unmarshal(load(t, "auth-token.json"), &fx); err != nil {
		t.Fatal(err)
	}
	pub, _ := auth.ParsePublicKeyB64(k.Agent.PublicKey)
	claims, err := auth.VerifyToken(fx.Header, pub, time.UnixMilli(k.Now))
	if err != nil {
		t.Fatalf("fixture token: %v", err)
	}
	if claims != fx.Claims {
		t.Fatalf("claims %+v != %+v", claims, fx.Claims)
	}
	// Our signer reproduces the fixture byte-for-byte (Ed25519 is deterministic, same field order).
	key, _ := auth.KeyFromSeedHex(k.Agent.SeedHex)
	if auth.PublicKeyB64(key) != k.Agent.PublicKey {
		t.Fatal("seed does not reproduce fixture public key")
	}
	h, err := auth.SignClaims(key, fx.Claims)
	if err != nil || h != fx.Header {
		t.Fatalf("header mismatch:\n%s\n%s", h, fx.Header)
	}
	// A freshly minted token verifies under the same TS-equivalent rules.
	now := time.Now()
	minted, mc, err := auth.NewToken(key, k.NodeID, now, auth.DefaultTokenTTL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := auth.VerifyToken(minted, pub, now); err != nil {
		t.Fatalf("minted token: %v", err)
	}
	if len(mc.Jti) < 16 {
		t.Fatal("jti too short")
	}
	// Wrong key / expired / too-long lifetime are rejected.
	other, _ := auth.KeyFromSeedHex(k.ControlPlane.SeedHex)
	if _, err := auth.VerifyToken(minted, other.Public().(ed25519.PublicKey), now); err == nil {
		t.Fatal("wrong key accepted")
	}
	if _, err := auth.VerifyToken(minted, pub, now.Add(61*time.Second)); err == nil {
		t.Fatal("expired token accepted")
	}
	long, _, _ := auth.NewToken(key, k.NodeID, now, 121*time.Second)
	if _, err := auth.VerifyToken(long, pub, now); err == nil {
		t.Fatal("token lifetime > 120s accepted")
	}
}

func TestRotationProofFixture(t *testing.T) {
	k := keys(t)
	var res protocol.ResultFrame
	_ = json.Unmarshal(load(t, "result-credentials-rotate.json"), &res)
	var data protocol.CredentialsRotateResult
	if err := json.Unmarshal(res.Data, &data); err != nil {
		t.Fatal(err)
	}
	// Seed of the "next" key in gen-fixtures.mjs (TEST ONLY).
	next, _ := auth.KeyFromSeedHex("0303030303030303030303030303030303030303030303030303030303030303")
	if auth.PublicKeyB64(next) != data.PublicKey {
		t.Fatal("next public key mismatch")
	}
	if proof := auth.RotationProof(next, k.NodeID, res.ID); proof != data.Proof {
		t.Fatalf("proof mismatch: %s vs %s", proof, data.Proof)
	}
	pub, _ := auth.ParsePublicKeyB64(data.PublicKey)
	if !auth.VerifyRotationProof(pub, k.NodeID, res.ID, data.Proof) {
		t.Fatal("proof does not verify with next key")
	}
	cur, _ := auth.ParsePublicKeyB64(k.Agent.PublicKey)
	if auth.VerifyRotationProof(cur, k.NodeID, res.ID, data.Proof) {
		t.Fatal("proof must not verify with the current key")
	}
}

// signed builds a cmd frame signed with the TEST-ONLY control-plane fixture key.
func signed(t *testing.T, k fixtureKeys, issuedAt, expiresAt any) []byte {
	t.Helper()
	cp, _ := auth.KeyFromSeedHex(k.ControlPlane.SeedHex)
	body, _ := json.Marshal(map[string]any{"id": "00000000-0000-4000-8000-0000000000f1", "nodeId": k.NodeID,
		"type": "workload.kill", "issuedAt": issuedAt, "expiresAt": expiresAt, "payload": map[string]any{"workloadId": k.WorkloadID}})
	f, _ := json.Marshal(protocol.CommandFrame{T: "cmd", Body: string(body), Sig: protocol.B64.EncodeToString(ed25519.Sign(cp, body))})
	return f
}

// TestCommandTimeWindow covers the agent-protocol.md §4 order:
// expired → reversed (lifetime) → future (issuedAt > now + 30 s) → lifetime (> 15 min).
func TestCommandTimeWindow(t *testing.T) {
	k := keys(t)
	t0 := k.Now
	now := time.UnixMilli(t0)
	const maxSafe = int64(1<<53 - 1)
	cases := []struct {
		name                string
		issuedAt, expiresAt any
		want                string
	}{
		{"normal", t0, t0 + 60_000, "ok"},
		{"reversed", t0 + 3_600_000, t0 + 60_000, "lifetime"},
		{"reversed by 1 ms", t0 + 1, t0, "lifetime"},
		{"issued exactly at skew limit", t0 + 30_000, t0 + 90_000, "ok"},
		{"issued 1 ms beyond skew", t0 + 30_001, t0 + 90_000, "future"},
		{"issued far in the future", t0 + 86_400_000, t0 + 86_400_000 + 60_000, "future"},
		{"max lifetime", t0, t0 + 900_000, "ok"},
		{"lifetime + 1 ms", t0, t0 + 900_001, "lifetime"},
		{"expired beyond grace", t0 - 120_000, t0 - 30_001, "expired"},
		{"expired within grace", t0 - 120_000, t0 - 30_000, "ok"},
		{"huge expiresAt", int64(0), maxSafe, "lifetime"},
		{"huge both, future", maxSafe - 1000, maxSafe, "future"},
		{"beyond safe integer", t0, maxSafe + 2, "malformed"},
		{"negative", int64(-1), t0, "malformed"},
		{"float", 1.5, t0, "malformed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := verifyCommand(t, signed(t, k, c.issuedAt, c.expiresAt), k, now); got != c.want {
				t.Fatalf("got %q want %q", got, c.want)
			}
		})
	}
	// Direct boundary checks on the int64 helper (no schema in front of it).
	if r := protocol.CheckCommandWindow(1<<62, 1<<62+1, t0); r != protocol.RejectMalformed {
		t.Fatalf("out-of-range accepted: %q", r)
	}
	if r := protocol.CheckCommandWindow(0, 1<<53-1, -1<<62); r != protocol.RejectFuture { // no overflow in issuedAt-now
		t.Fatalf("negative clock: %q", r)
	}
}

func decodeFixturePayload(t *testing.T, file string) any {
	t.Helper()
	k := keys(t)
	var f protocol.CommandFrame
	if err := json.Unmarshal(load(t, file), &f); err != nil {
		t.Fatal(err)
	}
	cpKey, _ := auth.ParsePublicKeyB64(k.ControlPlane.PublicKey)
	body, reason := protocol.VerifyCommand(f, cpKey, k.NodeID, time.UnixMilli(k.Now))
	if reason != "" {
		t.Fatal(reason)
	}
	p, _, perr := protocol.ParsePayload(body.Type, body.Payload)
	if perr != nil {
		t.Fatal(perr)
	}
	return p
}

func TestEggAndInstallFixturesDecode(t *testing.T) {
	spec := decodeFixturePayload(t, "cmd-workload-ensure-egg.json").(*protocol.WorkloadSpec)
	if spec.Kind != "generic" || spec.Entrypoint != protocol.EntrypointImage || len(spec.Command) != 0 ||
		spec.DataMountPath != "/home/container" || !spec.ReadOnlyRootfs || spec.Stop == nil ||
		spec.Stop.Type != "signal" || spec.Stop.Signal != "SIGINT" || spec.Env["SAVE_NAME"] != "gamesave" ||
		len(spec.Ports) != 2 || spec.Ports[1].Protocol != "udp" || spec.JvmProbe {
		t.Fatalf("egg spec %+v", spec)
	}
	in := decodeFixturePayload(t, "cmd-workload-install.json").(*protocol.WorkloadInstallPayload)
	if in.Image != "ghcr.io/pterodactyl/installers:debian" || in.Entrypoint != "bash" || in.TimeoutMs != 1_800_000 ||
		in.CPULimitMillicores != nil || in.MemoryLimitBytes != 1<<30 || !strings.Contains(in.Script, "marker.txt") {
		t.Fatalf("install %+v", in)
	}
}

func TestBackupFixturesDecode(t *testing.T) {
	c := decodeFixturePayload(t, "cmd-backup-create.json").(*protocol.BackupCreatePayload)
	if c.BackupID == "" || len(c.Ignore) != 3 || c.Ignore[2] != "!logs/keep.log" || c.MaxBytes != 53687091200 {
		t.Fatalf("create %+v", c)
	}
	r := decodeFixturePayload(t, "cmd-backup-restore-url.json").(*protocol.BackupRestorePayload)
	if r.Source.Type != "url" || !strings.HasPrefix(r.Source.URL, "https://s3.example.com/") || !r.Truncate || len(r.Sha256) != 64 {
		t.Fatalf("restore %+v", r)
	}
	u := decodeFixturePayload(t, "cmd-backup-upload.json").(*protocol.BackupUploadPayload)
	if u.PartSize != 64<<20 || len(u.Parts) != 2 || u.Parts[1].PartNumber != 2 || !u.DeleteLocal {
		t.Fatalf("upload %+v", u)
	}
}
