package agent

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/blockforge/node-agent/internal/auth"
	"github.com/blockforge/node-agent/internal/protocol"
)

const (
	testNodeID = "6f1c2b9a-4d3e-4f5a-9b8c-7d6e5f4a3b2c"
	cpSeed     = "0101010101010101010101010101010101010101010101010101010101010101"
)

// fakeCP is a minimal in-process control plane implementing the agent endpoints with the
// verification rules from agent-protocol.md §3 (token signature, audience, lifetime, jti replay,
// active + pending keys) so the agent can be exercised end to end without the real control plane.
type fakeCP struct {
	t   *testing.T
	srv *httptest.Server
	cp  ed25519.PrivateKey

	mu            sync.Mutex
	activeKey     ed25519.PublicKey
	pendingKey    ed25519.PublicKey
	rejectPending bool
	jtis          map[string]bool
	approved      bool
	conn          *websocket.Conn
	frames        chan map[string]any
	rawFrames     chan []byte
	connects      int
	authWith      []string // "active" | "pending"
	transfers     map[string][]byte
	welcomeHB     int64
}

func newFakeCP(t *testing.T) *fakeCP {
	cp, _ := auth.KeyFromSeedHex(cpSeed)
	f := &fakeCP{t: t, cp: cp, jtis: map[string]bool{}, approved: true, frames: make(chan map[string]any, 4096),
		rawFrames: make(chan []byte, 4096), transfers: map[string][]byte{}, welcomeHB: 300}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /agent/v1/enroll", f.enroll)
	mux.HandleFunc("GET /agent/v1/connect", f.connect)
	mux.HandleFunc("POST /agent/v1/transfers/{id}", f.upload)
	mux.HandleFunc("GET /agent/v1/transfers/{id}", f.download)
	mux.HandleFunc("POST /agent/v1/sftp/auth", f.sftpAuth)
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeCP) enroll(w http.ResponseWriter, r *http.Request) {
	var req protocol.EnrollRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !strings.HasPrefix(req.Token, "bfe_") {
		http.Error(w, `{"error":{"code":"VALIDATION_FAILED","message":"bad"}}`, 400)
		return
	}
	if req.Token == "bfe_ffffffffffffffff_"+strings.Repeat("A", 43) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":{"code":"ENROLLMENT_TOKEN_INVALID","message":"invalid token"}}`))
		return
	}
	pub, err := auth.ParsePublicKeyB64(req.PublicKey)
	if err != nil || req.ProtocolVersion != 1 || req.Facts.DataRoot == "" || req.Facts.CPULogicalCores <= 0 {
		http.Error(w, "bad request", 400)
		return
	}
	f.mu.Lock()
	f.activeKey = pub
	f.mu.Unlock()
	w.WriteHeader(201)
	json.NewEncoder(w).Encode(protocol.EnrollResponse{NodeID: testNodeID, Approved: true,
		ControlPlaneSigningKey: protocol.B64.EncodeToString(f.cp.Public().(ed25519.PublicKey)),
		HeartbeatIntervalMs:    15000, MetricsIntervalMs: 1000})
}

// authenticate applies §3: active or pending key, aud, lifetime, skew, jti not reused.
func (f *fakeCP) authenticate(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	f.mu.Lock()
	defer f.mu.Unlock()
	try := func(k ed25519.PublicKey, name string) (string, bool) {
		if k == nil {
			return "", false
		}
		claims, err := auth.VerifyToken(h, k, time.Now())
		if err != nil || claims.Nid != testNodeID || f.jtis[claims.Jti] {
			return "", false
		}
		f.jtis[claims.Jti] = true
		return name, true
	}
	if n, ok := try(f.activeKey, "active"); ok {
		return n, true
	}
	if !f.rejectPending {
		if n, ok := try(f.pendingKey, "pending"); ok {
			// First successful auth with the pending key promotes it (§3.1 step 3).
			f.activeKey, f.pendingKey = f.pendingKey, nil
			return n, true
		}
	}
	return "", false
}

func (f *fakeCP) connect(w http.ResponseWriter, r *http.Request) {
	which, ok := f.authenticate(r)
	if !ok {
		http.Error(w, "unauthorized", 401)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	c.SetReadLimit(protocol.MaxFrameBytes)
	ctx := r.Context()
	_, hello, err := c.Read(ctx)
	if err != nil {
		return
	}
	f.mu.Lock()
	f.conn = c
	f.connects++
	f.authWith = append(f.authWith, which)
	approved, hb := f.approved, f.welcomeHB
	f.mu.Unlock()
	f.push(hello)
	wb, _ := json.Marshal(protocol.WelcomeFrame{T: "welcome", NodeID: testNodeID, ServerTime: time.Now().UnixMilli(),
		Approved: approved, HeartbeatIntervalMs: hb, MetricsIntervalMs: 1000})
	c.Write(ctx, websocket.MessageText, wb)
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		f.push(data)
	}
}

func (f *fakeCP) push(data []byte) {
	var m map[string]any
	if json.Unmarshal(data, &m) == nil {
		select {
		case f.frames <- m:
		default:
		}
		select {
		case f.rawFrames <- data:
		default:
		}
	}
}

func (f *fakeCP) upload(w http.ResponseWriter, r *http.Request) {
	if _, ok := f.authenticate(r); !ok {
		http.Error(w, "unauthorized", 401)
		return
	}
	b, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.transfers[r.PathValue("id")] = b
	f.mu.Unlock()
	w.WriteHeader(204)
}

func (f *fakeCP) download(w http.ResponseWriter, r *http.Request) {
	if _, ok := f.authenticate(r); !ok {
		http.Error(w, "unauthorized", 401)
		return
	}
	f.mu.Lock()
	b, ok := f.transfers[r.PathValue("id")]
	f.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Write(b)
}

// signCmd builds a cmd frame signed with the TEST-ONLY control-plane key.
func (f *fakeCP) signCmd(id, typ string, payload any, issued time.Time, lifetime time.Duration) protocol.CommandFrame {
	p, _ := json.Marshal(payload)
	body, _ := json.Marshal(protocol.CommandBody{ID: id, NodeID: testNodeID, Type: typ, IssuedAt: issued.UnixMilli(),
		ExpiresAt: issued.Add(lifetime).UnixMilli(), Payload: p})
	return protocol.CommandFrame{T: "cmd", Body: string(body), Sig: protocol.B64.EncodeToString(ed25519.Sign(f.cp, body))}
}

func (f *fakeCP) send(frame protocol.CommandFrame) {
	b, _ := json.Marshal(frame)
	f.mu.Lock()
	c := f.conn
	f.mu.Unlock()
	if c == nil {
		f.t.Fatal("no agent connection")
	}
	if err := c.Write(context.Background(), websocket.MessageText, b); err != nil {
		f.t.Fatalf("send: %v", err)
	}
}

// waitFrame returns the next frame matching pred.
func (f *fakeCP) waitFrame(timeout time.Duration, pred func(map[string]any) bool) map[string]any {
	f.t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case m := <-f.frames:
			if pred(m) {
				return m
			}
		case <-deadline:
			f.t.Fatalf("timed out waiting for frame")
			return nil
		}
	}
}

func (f *fakeCP) result(id string, timeout time.Duration) map[string]any {
	f.t.Helper()
	return f.waitFrame(timeout, func(m map[string]any) bool { return m["t"] == "result" && m["id"] == id })
}

func errCode(m map[string]any) string {
	if e, ok := m["error"].(map[string]any); ok {
		s, _ := e["code"].(string)
		return s
	}
	return ""
}

// Fake SFTP users: "alice.1a2b3c4d" / sftpPassword (read+write on testWID).
const sftpPassword = "fake-cp-sftp-password"

func (f *fakeCP) sftpAuth(w http.ResponseWriter, r *http.Request) {
	if _, ok := f.authenticate(r); !ok {
		http.Error(w, "unauthorized", 401)
		return
	}
	var req protocol.SftpAuthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", 400)
		return
	}
	if req.Method != "password" || req.Username != "alice.1a2b3c4d" || req.Password != sftpPassword {
		w.WriteHeader(401)
		return
	}
	json.NewEncoder(w).Encode(protocol.SftpAuthResponse{WorkloadID: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
		UserID: "11111111-1111-4111-8111-111111111111", Permissions: []string{"read", "write"},
		Denylist: []string{}, ExpiresAt: time.Now().Add(time.Hour).UnixMilli()})
}
