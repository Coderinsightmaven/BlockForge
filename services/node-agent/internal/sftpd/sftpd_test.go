package sftpd

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
)

const (
	wid     = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
	uidRW   = "11111111-1111-4111-8111-111111111111"
	uidRO   = "22222222-2222-4222-8222-222222222222"
	pwRW    = "correct horse battery staple"
	userRW  = "alice.1a2b3c4d"
	userRO  = "bob.1a2b3c4d"
	userKey = "carol.1a2b3c4d"
)

type fakeAuth struct {
	mu       sync.Mutex
	calls    int
	ttl      time.Duration
	denyAll  bool
	denylist []string
	keyLine  string
	reqs     []protocol.SftpAuthRequest
}

func (f *fakeAuth) Authenticate(_ context.Context, r protocol.SftpAuthRequest) (*protocol.SftpAuthResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.reqs = append(f.reqs, r)
	if f.denyAll {
		return nil, ErrDenied
	}
	ttl := f.ttl
	if ttl == 0 {
		ttl = time.Hour
	}
	resp := &protocol.SftpAuthResponse{WorkloadID: wid, Denylist: f.denylist, ExpiresAt: time.Now().Add(ttl).UnixMilli()}
	switch {
	case r.Method == "password" && r.Username == userRW && r.Password == pwRW:
		resp.UserID, resp.Permissions = uidRW, []string{"read", "write"}
	case r.Method == "password" && r.Username == userRO && r.Password == pwRW:
		resp.UserID, resp.Permissions = uidRO, []string{"read"}
	case r.Method == "publickey" && r.Username == userKey && r.PublicKey == f.keyLine:
		resp.UserID, resp.Permissions = uidRW, []string{"read", "write"}
	default:
		return nil, ErrDenied
	}
	return resp, nil
}

type env struct {
	t      *testing.T
	srv    *Server
	auth   *fakeAuth
	data   string
	base   string
	addr   string
	mu     sync.Mutex
	events []protocol.SftpActivityEvent
	cancel context.CancelFunc
	now    atomic.Int64 // unix ms offset applied to the server clock
}

func newEnv(t *testing.T, tweak func(*Options)) *env {
	t.Helper()
	base := t.TempDir()
	sb := &fsops.Sandbox{DataRoot: base, UID: 1000, GID: 1000}
	if err := sb.EnsureDataDir(wid); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, auth: &fakeAuth{}, data: sb.DataDir(wid), base: base}
	o := Options{
		Listen: "127.0.0.1:0", HostKeyPath: filepath.Join(base, "host_key"), Sandbox: sb, Auth: e.auth,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Emit: func(ev string, data any) {
			if ev == protocol.EventSftpActivity {
				e.mu.Lock()
				e.events = append(e.events, data.(protocol.SftpActivityEvent))
				e.mu.Unlock()
			}
		},
		Now: func() time.Time { return time.Now().Add(time.Duration(e.now.Load()) * time.Millisecond) },
	}
	if tweak != nil {
		tweak(&o)
	}
	srv, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.Listen(); err != nil {
		t.Fatal(err)
	}
	e.srv = srv
	e.addr = srv.ln.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	e.cancel = cancel
	go srv.Serve(ctx)
	t.Cleanup(cancel)
	return e
}

func (e *env) dial(user string, auth ...ssh.AuthMethod) (*ssh.Client, error) {
	cfg := &ssh.ClientConfig{User: user, Auth: auth, Timeout: 5 * time.Second,
		HostKeyCallback: ssh.FixedHostKey(e.srv.signer.PublicKey())}
	return ssh.Dial("tcp", e.addr, cfg)
}

func (e *env) sftp(user string, auth ...ssh.AuthMethod) *sftp.Client {
	e.t.Helper()
	c, err := e.dial(user, auth...)
	if err != nil {
		e.t.Fatalf("ssh dial %s: %v", user, err)
	}
	e.t.Cleanup(func() { c.Close() })
	sc, err := sftp.NewClient(c)
	if err != nil {
		e.t.Fatalf("sftp: %v", err)
	}
	e.t.Cleanup(func() { sc.Close() })
	return sc
}

// isPerm: the pkg/sftp client turns SSH_FX_PERMISSION_DENIED into os.ErrPermission for most calls.
func isPerm(err error) bool {
	var se *sftp.StatusError
	if errors.As(err, &se) {
		return se.FxCode() == sftp.ErrSSHFxPermissionDenied
	}
	return errors.Is(err, os.ErrPermission)
}

func (e *env) actions(wait time.Duration) []protocol.SftpAction {
	time.Sleep(wait)
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []protocol.SftpAction
	for _, ev := range e.events {
		if ev.WorkloadID != wid || ev.SessionID == "" || ev.ClientIP != "127.0.0.1" || len(ev.Actions) > 100 {
			e.t.Fatalf("bad event %+v", ev)
		}
		out = append(out, ev.Actions...)
	}
	return out
}

func TestPasswordLoginAndMutations(t *testing.T) {
	e := newEnv(t, nil)
	c := e.sftp(userRW, ssh.Password(pwRW))
	f, err := c.Create("/server.properties")
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("motd=hi\n"))
	f.Close()
	if b, _ := os.ReadFile(filepath.Join(e.data, "server.properties")); string(b) != "motd=hi\n" {
		t.Fatalf("uploaded %q", b)
	}
	rf, err := c.Open("server.properties")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(rf)
	rf.Close()
	if string(b) != "motd=hi\n" {
		t.Fatal("read back")
	}
	if err := c.Mkdir("plugins"); err != nil {
		t.Fatal(err)
	}
	if err := c.Mkdir("plugins"); err == nil {
		t.Fatal("mkdir of an existing dir must fail")
	}
	if err := c.Rename("server.properties", "plugins/x.properties"); err != nil {
		t.Fatal(err)
	}
	if err := c.Chmod("plugins/x.properties", 0o4755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(filepath.Join(e.data, "plugins", "x.properties"))
		if fi.Mode()&os.ModeSetuid != 0 || fi.Mode().Perm() != 0o755 {
			t.Fatalf("chmod must keep permission bits only: %v", fi.Mode())
		}
	}
	if err := c.Chtimes("plugins/x.properties", time.Unix(1_700_000_000, 0), time.Unix(1_700_000_000, 0)); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	if err := c.Chown("plugins/x.properties", 0, 0); !isPerm(err) {
		t.Fatalf("chown must be refused: %v", err)
	}
	if err := c.Truncate("plugins/x.properties", 1); !isPerm(err) {
		t.Fatalf("setstat size must be refused: %v", err)
	}
	entries, err := c.ReadDir("/")
	if err != nil || len(entries) != 2 { // .blockforge, plugins
		t.Fatalf("readdir %v %d", err, len(entries))
	}
	if err := c.Remove("plugins/x.properties"); err != nil {
		t.Fatal(err)
	}
	if err := c.RemoveDirectory("plugins"); err != nil {
		t.Fatal(err)
	}
	if err := c.Remove("/"); err == nil {
		t.Fatal("removing the root succeeded")
	}
	acts := e.actions(1300 * time.Millisecond)
	var names []string
	for _, a := range acts {
		names = append(names, a.Action+":"+a.Path+">"+a.To)
	}
	want := "upload:server.properties>,mkdir:plugins>,rename:server.properties>plugins/x.properties,chmod:plugins/x.properties>,delete:plugins/x.properties>,delete:plugins>"
	if strings.Join(names, ",") != want {
		t.Fatalf("activity\n got %s\nwant %s", strings.Join(names, ","), want)
	}
	e.auth.mu.Lock()
	r := e.auth.reqs[0]
	e.auth.mu.Unlock()
	if r.Method != "password" || r.Username != userRW || r.ClientIP != "127.0.0.1" || len(r.SessionID) != 32 {
		t.Fatalf("auth request %+v", r)
	}
}

func TestLoginFailuresAndBackoff(t *testing.T) {
	e := newEnv(t, nil)
	if _, err := e.dial(userRW, ssh.Password("wrong")); err == nil {
		t.Fatal("wrong password accepted")
	}
	// Malformed usernames are refused locally (no control-plane call).
	before := e.auth.calls
	if _, err := e.dial("root", ssh.Password(pwRW)); err == nil {
		t.Fatal("bad username accepted")
	}
	if e.auth.calls != before {
		t.Fatal("malformed username reached the control plane")
	}
	// Third failure → the IP is blocked for a minute, even with the right password.
	e.dial(userRW, ssh.Password("wrong again"))
	if _, err := e.dial(userRW, ssh.Password(pwRW)); err == nil {
		t.Fatal("blocked IP could log in")
	}
	e.now.Store(int64(61 * time.Second / time.Millisecond))
	if _, err := e.dial(userRW, ssh.Password(pwRW)); err != nil {
		t.Fatalf("block did not expire: %v", err)
	}
}

func TestPublicKeyLogin(t *testing.T) {
	e := newEnv(t, nil)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(priv)
	e.auth.keyLine = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	c := e.sftp(userKey, ssh.PublicKeys(signer))
	if _, err := c.Stat("/"); err != nil {
		t.Fatal(err)
	}
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	os2, _ := ssh.NewSignerFromKey(other)
	if _, err := e.dial(userKey, ssh.PublicKeys(os2)); err == nil {
		t.Fatal("unknown key accepted")
	}
}

func TestReadOnlyAndDenylist(t *testing.T) {
	e := newEnv(t, nil)
	e.auth.denylist = []string{"*.secret", "/config/private", "!keep.secret"}
	os.MkdirAll(filepath.Join(e.data, "config", "private"), 0o755)
	os.WriteFile(filepath.Join(e.data, "config", "private", "token.txt"), []byte("T"), 0o644)
	os.WriteFile(filepath.Join(e.data, "forwarding.secret"), []byte("S"), 0o644)
	os.WriteFile(filepath.Join(e.data, "keep.secret"), []byte("K"), 0o644)
	os.WriteFile(filepath.Join(e.data, "server.jar"), []byte("JAR"), 0o644)
	ro := e.sftp(userRO, ssh.Password(pwRW))
	if f, err := ro.Open("server.jar"); err != nil {
		t.Fatalf("read-only user cannot read: %v", err)
	} else {
		f.Close()
	}
	if _, err := ro.Create("new.txt"); !isPerm(err) {
		t.Fatalf("read-only user created a file: %v", err)
	}
	if f, err := ro.OpenFile("server.jar", os.O_WRONLY|os.O_TRUNC); !isPerm(err) {
		if f != nil {
			f.Close()
		}
		t.Fatalf("read-only user opened for write: %v", err)
	}
	for name, err := range map[string]error{
		"mkdir": ro.Mkdir("d"), "remove": ro.Remove("server.jar"), "rename": ro.Rename("server.jar", "x.jar"),
		"chmod": ro.Chmod("server.jar", 0o600),
	} {
		if !isPerm(err) {
			t.Fatalf("read-only %s: %v", name, err)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(e.data, "server.jar")); string(b) != "JAR" {
		t.Fatal("read-only user modified a file")
	}
	rw := e.sftp(userRW, ssh.Password(pwRW))
	for _, p := range []string{"forwarding.secret", "config/private/token.txt", "config/private"} {
		if f, err := rw.Open(p); !isPerm(err) && p != "config/private" {
			if f != nil {
				f.Close()
			}
			t.Fatalf("denylisted %s readable: %v", p, err)
		}
	}
	if _, err := rw.Create("config/private/new.txt"); !isPerm(err) {
		t.Fatalf("write below a denylisted dir: %v", err)
	}
	if err := rw.Remove("forwarding.secret"); !isPerm(err) {
		t.Fatalf("delete denylisted: %v", err)
	}
	if err := rw.Rename("server.jar", "x.secret"); !isPerm(err) {
		t.Fatalf("rename onto a denylisted name: %v", err)
	}
	if f, err := rw.Open("keep.secret"); err != nil {
		t.Fatalf("negated pattern not honoured: %v", err)
	} else {
		f.Close()
	}
	if entries, err := rw.ReadDir("/"); err != nil || len(entries) < 4 {
		t.Fatalf("listing must still work: %v", err)
	}
	if acts := e.actions(1200 * time.Millisecond); len(acts) != 0 {
		t.Fatalf("refused operations produced activity: %+v", acts)
	}
}

func TestTraversalAndLinks(t *testing.T) {
	e := newEnv(t, nil)
	os.WriteFile(filepath.Join(e.base, "outside.txt"), []byte("OUT"), 0o644)
	symlinked := os.Symlink(filepath.Join(e.base, "outside.txt"), filepath.Join(e.data, "escape")) == nil
	os.Symlink(e.base, filepath.Join(e.data, "escdir"))
	c := e.sftp(userRW, ssh.Password(pwRW))
	for _, p := range []string{"../../outside.txt", "/../outside.txt", "..", "/../../../etc/passwd"} {
		f, err := c.Open(p)
		if err == nil {
			b, _ := io.ReadAll(f)
			f.Close()
			if strings.Contains(string(b), "OUT") || strings.Contains(string(b), "root:") {
				t.Fatalf("%s escaped the sandbox", p)
			}
		}
	}
	if f, err := c.Create("../planted.txt"); err == nil {
		f.Close()
	}
	if _, err := os.Stat(filepath.Join(e.base, "planted.txt")); err == nil {
		t.Fatal("file planted outside the sandbox")
	}
	if symlinked {
		if f, err := c.Open("escape"); err == nil {
			f.Close()
			t.Fatal("symlink out of the sandbox was followed")
		}
		if f, err := c.Create("escdir/planted2.txt"); err == nil {
			f.Close()
			t.Fatal("write through a symlinked directory")
		}
		if _, err := os.Stat(filepath.Join(e.base, "planted2.txt")); err == nil {
			t.Fatal("file planted outside via symlinked dir")
		}
		if fi, err := c.Lstat("escape"); err != nil || fi.Mode()&fs.ModeSymlink == 0 {
			t.Fatalf("lstat symlink: %v", err)
		}
		if _, err := c.ReadLink("escape"); err == nil {
			t.Fatal("readlink must be unsupported")
		}
	}
	os.WriteFile(filepath.Join(e.data, "a.txt"), []byte("A"), 0o644)
	if err := c.Symlink("/etc/passwd", "lnk"); !isPerm(err) {
		t.Fatalf("symlink creation: %v", err)
	}
	if err := c.Link("a.txt", "hard"); !isPerm(err) {
		t.Fatalf("hardlink creation: %v", err)
	}
	if runtime.GOOS != "windows" {
		if err := mkfifo(filepath.Join(e.data, "pipe")); err == nil {
			done := make(chan error, 1)
			go func() {
				f, err := c.Open("pipe")
				if f != nil {
					f.Close()
				}
				done <- err
			}()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("FIFO opened")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("opening a FIFO hung the session")
			}
		}
	}
}

func TestReauthAndSessionLimits(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.SessionsPerKey = 2 })
	e.auth.ttl = 1500 * time.Millisecond
	c := e.sftp(userRW, ssh.Password(pwRW))
	if _, err := c.Stat("/"); err != nil {
		t.Fatal(err)
	}
	// Re-auth succeeds while the user is still allowed.
	time.Sleep(1800 * time.Millisecond)
	if _, err := c.Stat("/"); err != nil {
		t.Fatalf("after successful re-auth: %v", err)
	}
	// Revoke: the next re-auth fails and the session is closed.
	e.auth.mu.Lock()
	e.auth.denyAll = true
	e.auth.mu.Unlock()
	time.Sleep(1800 * time.Millisecond)
	if _, err := c.Stat("/"); err == nil {
		t.Fatal("revoked session still usable")
	}
	e.auth.mu.Lock()
	e.auth.denyAll, e.auth.ttl = false, time.Hour
	e.auth.mu.Unlock()
	// Session limit per user+server.
	e.sftp(userRW, ssh.Password(pwRW))
	e.sftp(userRW, ssh.Password(pwRW))
	cl, err := e.dial(userRW, ssh.Password(pwRW))
	if err == nil {
		if _, err := sftp.NewClient(cl); err == nil {
			t.Fatal("third concurrent session allowed")
		}
		cl.Close()
	}
}

func TestNoShellNoForwarding(t *testing.T) {
	e := newEnv(t, nil)
	cl, err := e.dial(userRW, ssh.Password(pwRW))
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	s, err := cl.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if out, err := s.CombinedOutput("id"); err == nil {
		t.Fatalf("exec allowed: %s", out)
	}
	s2, _ := cl.NewSession()
	if err := s2.Shell(); err == nil {
		t.Fatal("shell allowed")
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	if c, err := cl.Dial("tcp", ln.Addr().String()); err == nil {
		c.Close()
		t.Fatal("direct-tcpip forwarding allowed")
	}
	if _, err := cl.Listen("tcp", "127.0.0.1:0"); err == nil {
		t.Fatal("remote forwarding allowed")
	}
}

func TestHostKeyPersisted(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "k")
	a, err := LoadOrCreateHostKey(p)
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadOrCreateHostKey(p)
	if err != nil || ssh.FingerprintSHA256(a.PublicKey()) != ssh.FingerprintSHA256(b.PublicKey()) {
		t.Fatal("host key not stable across restarts")
	}
	if !strings.HasPrefix(ssh.FingerprintSHA256(a.PublicKey()), "SHA256:") || a.PublicKey().Type() != ssh.KeyAlgoED25519 {
		t.Fatal("fingerprint/type")
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
			t.Fatalf("host key mode %v", fi.Mode())
		}
	}
}

func TestHTTPAuthenticator(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/v1/sftp/auth" || r.Header.Get("Authorization") != "BFAgent tok" {
			w.WriteHeader(500)
			return
		}
		var req protocol.SftpAuthRequest
		json.NewDecoder(r.Body).Decode(&req)
		if req.Password != pwRW {
			w.WriteHeader(401)
			return
		}
		json.NewEncoder(w).Encode(protocol.SftpAuthResponse{WorkloadID: wid, UserID: uidRW, Permissions: []string{"read"}, Denylist: []string{}, ExpiresAt: time.Now().Add(time.Hour).UnixMilli()})
	}))
	defer srv.Close()
	h := &HTTPAuthenticator{Client: srv.Client(), URL: srv.URL + "/agent/v1/sftp/auth", Header: func() (string, error) { return "BFAgent tok", nil }}
	resp, err := h.Authenticate(context.Background(), protocol.SftpAuthRequest{Method: "password", Username: userRW, Password: pwRW})
	if err != nil || resp.UserID != uidRW {
		t.Fatalf("%v %+v", err, resp)
	}
	if _, err := h.Authenticate(context.Background(), protocol.SftpAuthRequest{Method: "password", Username: userRW, Password: "x"}); !errors.Is(err, ErrDenied) {
		t.Fatalf("401: %v", err)
	}
}

// TestOpenSSHClient drives the server with the real OpenSSH `sftp` client (Linux only).
func TestOpenSSHClient(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("OpenSSH client key permissions are not portable to the Windows test runner")
	}
	bin, err := exec.LookPath("sftp")
	if err != nil {
		t.Skip("OpenSSH sftp client not installed")
	}
	e := newEnv(t, nil)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(priv)
	e.auth.keyLine = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	dir := t.TempDir()
	block, _ := ssh.MarshalPrivateKey(priv, "")
	keyFile := filepath.Join(dir, "id_ed25519")
	os.WriteFile(keyFile, pem.EncodeToMemory(block), 0o600)
	known := filepath.Join(dir, "known_hosts")
	host, port, _ := net.SplitHostPort(e.addr)
	os.WriteFile(known, []byte("[127.0.0.1]:"+port+" "+string(ssh.MarshalAuthorizedKey(e.srv.signer.PublicKey()))), 0o600)
	local := filepath.Join(dir, "upload.txt")
	os.WriteFile(local, []byte("from openssh\n"), 0o644)
	batch := filepath.Join(dir, "batch")
	os.WriteFile(batch, []byte("mkdir cfg\nput "+local+" cfg/upload.txt\nls -l cfg\nrename cfg/upload.txt cfg/moved.txt\nget cfg/moved.txt "+filepath.Join(dir, "back.txt")+"\n-symlink cfg/moved.txt lnk\nrm cfg/moved.txt\nrmdir cfg\nbye\n"), 0o644)
	cmd := exec.Command(bin, "-b", batch, "-i", keyFile, "-P", port, "-o", "UserKnownHostsFile="+known,
		"-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", userKey+"@"+host)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("openssh sftp: %v\n%s", err, out)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "back.txt")); string(b) != "from openssh\n" {
		t.Fatalf("round trip %q\n%s", b, out)
	}
	if !strings.Contains(string(out), "moved.txt") && !strings.Contains(string(out), "upload.txt") {
		t.Logf("%s", out)
	}
	if _, err := os.Lstat(filepath.Join(e.data, "lnk")); err == nil {
		t.Fatal("OpenSSH client created a symlink")
	}
	if _, err := os.Stat(filepath.Join(e.data, "cfg")); err == nil {
		t.Fatal("rmdir did not run")
	}
	t.Logf("openssh session:\n%s", out)
	acts := e.actions(1300 * time.Millisecond)
	if len(acts) < 5 {
		t.Fatalf("activity %+v", acts)
	}
}

func TestIdleTimeout(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.IdleTimeout = 700 * time.Millisecond })
	c := e.sftp(userRW, ssh.Password(pwRW))
	for i := 0; i < 4; i++ { // activity keeps the session alive past the timeout
		if _, err := c.Stat("/"); err != nil {
			t.Fatalf("active session closed: %v", err)
		}
		time.Sleep(300 * time.Millisecond)
	}
	time.Sleep(1500 * time.Millisecond)
	if _, err := c.Stat("/"); err == nil {
		t.Fatal("idle session not closed")
	}
}
