package sftpd

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"github.com/blockforge/node-agent/internal/denylist"
	"github.com/blockforge/node-agent/internal/fileutil"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
)

// Limits (agent-protocol.md "SFTP service").
const (
	DefaultIdleTimeout    = 10 * time.Minute
	DefaultSessionsPerKey = 10
	DefaultFailuresPerIP  = 3
	failureWindow         = time.Minute
	handshakeTimeout      = 30 * time.Second
	maxUnauthPerIP        = 16
	maxConnections        = 512
	maxListEntries        = 100_000
	// maxAuthTries per SSH connection (each attempt may cost a control-plane request).
	maxAuthTries = 3
)

// ErrDenied is returned by an Authenticator when the control plane refused the login.
var ErrDenied = errors.New("login denied")

// Authenticator verifies a login with the control plane.
type Authenticator interface {
	Authenticate(ctx context.Context, req protocol.SftpAuthRequest) (*protocol.SftpAuthResponse, error)
}

// HTTPAuthenticator calls POST <cp>/agent/v1/sftp/auth with a fresh BFAgent header.
type HTTPAuthenticator struct {
	Client *http.Client
	URL    string
	Header func() (string, error)
}

// Authenticate implements Authenticator.
func (h *HTTPAuthenticator) Authenticate(ctx context.Context, req protocol.SftpAuthRequest) (*protocol.SftpAuthResponse, error) {
	body, _ := json.Marshal(req)
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, h.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	auth, err := h.Header()
	if err != nil {
		return nil, err
	}
	hr.Header.Set("Authorization", auth)
	hr.Header.Set("Content-Type", "application/json")
	resp, err := h.Client.Do(hr)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return nil, ErrDenied
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("sftp auth: HTTP %d", resp.StatusCode)
	}
	var out protocol.SftpAuthResponse
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("sftp auth: invalid response: %w", err)
	}
	return &out, nil
}

// Options configures the server.
type Options struct {
	Listen         string
	HostKeyPath    string
	Sandbox        *fsops.Sandbox
	Auth           Authenticator
	Emit           func(event string, data any)
	Logger         *slog.Logger
	IdleTimeout    time.Duration
	SessionsPerKey int
	FailuresPerIP  int
	Now            func() time.Time
	// AuthConcurrency bounds control-plane verifications in flight (default 16); AuthRate and
	// AuthBurst bound their rate per second (defaults 20 / 40).
	AuthConcurrency int
	// HandshakeTimeout is the absolute pre-authentication deadline (default 30 s).
	HandshakeTimeout time.Duration
	AuthRate         float64
	AuthBurst        float64
}

// Server is the SFTP service.
type Server struct {
	o      Options
	signer ssh.Signer

	mu       sync.Mutex
	ln       net.Listener
	failures map[string][]time.Time
	unauth   map[string]int
	sessions map[string]int
	conns    map[*conn]struct{}
	total    int

	authSem    chan struct{}
	authTokens float64
	authLast   time.Time
}

// LoadOrCreateHostKey reads the Ed25519 host key or generates it (0600) on first start.
func LoadOrCreateHostKey(p string) (ssh.Signer, error) {
	if b, err := os.ReadFile(p); err == nil {
		return ssh.ParsePrivateKey(b)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(priv, "blockforge-agent sftp host key")
	if err != nil {
		return nil, err
	}
	if err := fileutil.WriteFileAtomic(p, pem.EncodeToMemory(block), 0o600); err != nil {
		return nil, err
	}
	return ssh.NewSignerFromKey(priv)
}

// New prepares a server (the host key is created if missing).
func New(o Options) (*Server, error) {
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.Emit == nil {
		o.Emit = func(string, any) {}
	}
	if o.IdleTimeout <= 0 {
		o.IdleTimeout = DefaultIdleTimeout
	}
	if o.SessionsPerKey <= 0 {
		o.SessionsPerKey = DefaultSessionsPerKey
	}
	if o.FailuresPerIP <= 0 {
		o.FailuresPerIP = DefaultFailuresPerIP
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.HandshakeTimeout <= 0 {
		o.HandshakeTimeout = handshakeTimeout
	}
	if o.AuthConcurrency <= 0 {
		o.AuthConcurrency = 16
	}
	if o.AuthRate <= 0 {
		o.AuthRate = 20
	}
	if o.AuthBurst <= 0 {
		o.AuthBurst = 40
	}
	signer, err := LoadOrCreateHostKey(o.HostKeyPath)
	if err != nil {
		return nil, fmt.Errorf("sftp host key: %w", err)
	}
	return &Server{o: o, signer: signer, failures: map[string][]time.Time{}, unauth: map[string]int{},
		sessions: map[string]int{}, conns: map[*conn]struct{}{}, authSem: make(chan struct{}, o.AuthConcurrency),
		authTokens: o.AuthBurst, authLast: o.Now()}, nil
}

// Fingerprint is the OpenSSH-style SHA256 fingerprint of the host key.
func (s *Server) Fingerprint() string { return ssh.FingerprintSHA256(s.signer.PublicKey()) }

// Port returns the configured port (or the bound port once listening on :0).
func (s *Server) Port() int {
	s.mu.Lock()
	ln := s.ln
	s.mu.Unlock()
	if ln != nil {
		return ln.Addr().(*net.TCPAddr).Port
	}
	_, p, _ := net.SplitHostPort(s.o.Listen)
	n, _ := strconv.Atoi(p)
	return n
}

// Listen binds the listener (separate from Serve so callers can learn the port first).
func (s *Server) Listen() error {
	ln, err := net.Listen("tcp", s.o.Listen)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.ln = ln
	s.mu.Unlock()
	return nil
}

// Serve accepts connections until ctx is cancelled; active sessions are closed on return.
func (s *Server) Serve(ctx context.Context) error {
	if s.ln == nil {
		if err := s.Listen(); err != nil {
			return err
		}
	}
	go func() {
		<-ctx.Done()
		s.ln.Close()
		s.mu.Lock()
		for c := range s.conns {
			c.nc.Close()
		}
		s.mu.Unlock()
	}()
	s.o.Logger.Info("sftp server listening", "addr", s.ln.Addr().String(), "hostKey", s.Fingerprint())
	for {
		nc, err := s.ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return err
		}
		go s.handle(ctx, nc)
	}
}

func clientIP(a net.Addr) string {
	if ta, ok := a.(*net.TCPAddr); ok {
		return ta.IP.String()
	}
	h, _, _ := net.SplitHostPort(a.String())
	return h
}

func (s *Server) recentFailures(ip string) int {
	cutoff := s.o.Now().Add(-failureWindow)
	keep := s.failures[ip][:0]
	for _, t := range s.failures[ip] {
		if t.After(cutoff) {
			keep = append(keep, t)
		}
	}
	if len(keep) == 0 {
		delete(s.failures, ip)
	} else {
		s.failures[ip] = keep
	}
	return len(keep)
}

func (s *Server) blocked(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.recentFailures(ip) >= s.o.FailuresPerIP
}

func (s *Server) recordFailure(ip string) {
	s.mu.Lock()
	s.failures[ip] = append(s.failures[ip], s.o.Now())
	s.mu.Unlock()
}

// idleConn enforces an absolute deadline before authentication (traffic cannot extend it, so a
// slow client cannot hold a pre-auth slot) and an idle timeout afterwards.
type idleConn struct {
	net.Conn
	mu      sync.Mutex
	timeout time.Duration // 0 = absolute deadline mode
}

// setAbsoluteDeadline fixes the deadline at now+d; reads and writes do not extend it.
func (c *idleConn) setAbsoluteDeadline(d time.Duration) {
	c.mu.Lock()
	c.timeout = 0
	c.mu.Unlock()
	_ = c.Conn.SetDeadline(time.Now().Add(d))
}

// setIdleTimeout switches to idle mode: every read/write moves the deadline to now+d.
func (c *idleConn) setIdleTimeout(d time.Duration) {
	c.mu.Lock()
	c.timeout = d
	c.mu.Unlock()
	_ = c.Conn.SetDeadline(time.Now().Add(d))
}

func (c *idleConn) extend() {
	c.mu.Lock()
	d := c.timeout
	c.mu.Unlock()
	if d > 0 {
		_ = c.Conn.SetDeadline(time.Now().Add(d))
	}
}

func (c *idleConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.extend()
	}
	return n, err
}

func (c *idleConn) Write(b []byte) (int, error) {
	c.extend()
	return c.Conn.Write(b)
}

// authSlot takes a token from the global rate limiter and a slot from the concurrency cap. It
// never blocks for long: when the budget is exhausted the attempt is refused locally.
func (s *Server) authSlot() (func(), bool) {
	s.mu.Lock()
	now := s.o.Now()
	if now.After(s.authLast) {
		s.authTokens += now.Sub(s.authLast).Seconds() * s.o.AuthRate
		if s.authTokens > s.o.AuthBurst {
			s.authTokens = s.o.AuthBurst
		}
		s.authLast = now
	}
	if s.authTokens < 1 {
		s.mu.Unlock()
		return nil, false
	}
	s.authTokens--
	s.mu.Unlock()
	select {
	case s.authSem <- struct{}{}:
		return func() { <-s.authSem }, true
	case <-time.After(2 * time.Second):
		return nil, false
	}
}

var reUsername = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{2,31}\.[0-9a-f]{8}$`)

// conn is one SSH connection.
type conn struct {
	s         *Server
	nc        *idleConn
	ip        string
	sessionID string
	attempted bool

	mu      sync.Mutex
	pending map[string]*credential
	cred    *credential
	resp    *protocol.SftpAuthResponse
	deny    *denylist.List
	sshConn *ssh.ServerConn
	closed  bool
}

type credential struct {
	req protocol.SftpAuthRequest
}

func (c *conn) authCallback(meta ssh.ConnMetadata, req protocol.SftpAuthRequest) (*ssh.Permissions, error) {
	c.mu.Lock()
	c.attempted = true
	c.mu.Unlock()
	if c.s.blocked(c.ip) {
		return nil, errors.New("too many failed logins")
	}
	user := strings.ToLower(meta.User())
	if !reUsername.MatchString(user) {
		c.s.recordFailure(c.ip)
		return nil, ErrDenied
	}
	req.Username, req.ClientIP, req.SessionID = user, c.ip, c.sessionID
	// Bound what unauthenticated clients can make the control plane do: a global rate and a
	// global number of verifications in flight; excess attempts are refused locally.
	release, ok := c.s.authSlot()
	if !ok {
		c.s.o.Logger.Warn("sftp auth: control-plane verification budget exhausted; refusing attempt", "ip", c.ip)
		return nil, ErrDenied
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, err := c.s.o.Auth.Authenticate(ctx, req)
	if err != nil {
		if errors.Is(err, ErrDenied) {
			if req.Method == "password" {
				c.s.recordFailure(c.ip)
			}
		} else {
			c.s.o.Logger.Warn("sftp auth request failed", "err", err, "ip", c.ip)
		}
		return nil, ErrDenied
	}
	if err := validateResponse(resp, c.s.o.Now()); err != nil {
		c.s.o.Logger.Warn("sftp auth: invalid control-plane response", "err", err)
		return nil, ErrDenied
	}
	var tok [12]byte
	rand.Read(tok[:])
	key := hex.EncodeToString(tok[:])
	c.mu.Lock()
	c.pending[key] = &credential{req: req}
	c.mu.Unlock()
	b, _ := json.Marshal(resp)
	return &ssh.Permissions{Extensions: map[string]string{"bf-token": key, "bf-auth": string(b)}}, nil
}

func validateResponse(r *protocol.SftpAuthResponse, now time.Time) error {
	if !protocol.IsUUID(r.WorkloadID) || !protocol.IsUUID(r.UserID) {
		return errors.New("ids")
	}
	for _, p := range r.Permissions {
		if p != "read" && p != "write" {
			return fmt.Errorf("unknown permission %q", p)
		}
	}
	if len(r.Denylist) > 256 {
		return errors.New("denylist too long")
	}
	if r.ExpiresAt <= now.UnixMilli() {
		return errors.New("already expired")
	}
	return nil
}

func (s *Server) handle(ctx context.Context, raw net.Conn) {
	ip := clientIP(raw.RemoteAddr())
	s.mu.Lock()
	if s.total >= maxConnections || s.unauth[ip] >= maxUnauthPerIP || s.recentFailures(ip) >= s.o.FailuresPerIP {
		s.mu.Unlock()
		raw.Close()
		return
	}
	s.total++
	s.unauth[ip]++
	s.mu.Unlock()
	authDone := false
	defer func() {
		s.mu.Lock()
		s.total--
		if !authDone {
			s.unauth[ip]--
			if s.unauth[ip] <= 0 {
				delete(s.unauth, ip)
			}
		}
		s.mu.Unlock()
	}()

	nc := &idleConn{Conn: raw}
	nc.setAbsoluteDeadline(s.o.HandshakeTimeout)
	c := &conn{s: s, nc: nc, ip: ip, pending: map[string]*credential{}}
	cfg := &ssh.ServerConfig{
		ServerVersion: "SSH-2.0-BlockForge",
		MaxAuthTries:  maxAuthTries,
		PasswordCallback: func(meta ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			c.sessionID = sessionIDOf(meta)
			return c.authCallback(meta, protocol.SftpAuthRequest{Method: "password", Password: string(pw)})
		},
		PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			c.sessionID = sessionIDOf(meta)
			line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
			return c.authCallback(meta, protocol.SftpAuthRequest{Method: "publickey", PublicKey: line})
		},
	}
	cfg.AddHostKey(s.signer)
	sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		c.mu.Lock()
		attempted := c.attempted
		c.mu.Unlock()
		if attempted {
			s.recordFailure(ip)
		}
		raw.Close()
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs) // no port forwarding, no global requests

	var resp protocol.SftpAuthResponse
	if err := json.Unmarshal([]byte(sc.Permissions.Extensions["bf-auth"]), &resp); err != nil {
		return
	}
	c.mu.Lock()
	c.cred = c.pending[sc.Permissions.Extensions["bf-token"]]
	c.pending = nil
	c.resp, c.deny, c.sshConn = &resp, denylist.New(resp.Denylist), sc
	c.mu.Unlock()
	if c.cred == nil {
		return
	}

	key := resp.UserID + "/" + resp.WorkloadID
	s.mu.Lock()
	authDone = true
	s.unauth[ip]--
	if s.unauth[ip] <= 0 {
		delete(s.unauth, ip)
	}
	if s.sessions[key] >= s.o.SessionsPerKey {
		s.mu.Unlock()
		s.o.Logger.Warn("sftp: too many concurrent sessions", "user", resp.UserID, "workload", resp.WorkloadID)
		return
	}
	s.sessions[key]++
	s.conns[c] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.sessions[key]--
		if s.sessions[key] <= 0 {
			delete(s.sessions, key)
		}
		delete(s.conns, c)
		s.mu.Unlock()
	}()

	root, err := s.o.Sandbox.Open(resp.WorkloadID)
	if err != nil {
		s.o.Logger.Warn("sftp: workload data dir unavailable", "workload", resp.WorkloadID, "err", err)
		return
	}
	defer root.Close()
	nc.setIdleTimeout(s.o.IdleTimeout)
	act := newActivity(s.o.Emit, resp.WorkloadID, resp.UserID, c.sessionID, ip)
	defer act.close()
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go c.reauthLoop(sctx)

	h := &handler{c: c, root: root, act: act}
	for nch := range chans {
		if nch.ChannelType() != "session" {
			nch.Reject(ssh.UnknownChannelType, "only session channels are supported")
			continue
		}
		ch, chReqs, err := nch.Accept()
		if err != nil {
			continue
		}
		go serveSession(ch, chReqs, h)
	}
}

func sessionIDOf(meta ssh.ConnMetadata) string {
	id := meta.SessionID()
	if len(id) > 16 {
		id = id[:16]
	}
	return hex.EncodeToString(id)
}

func serveSession(ch ssh.Channel, reqs <-chan *ssh.Request, h *handler) {
	defer ch.Close()
	started := false
	for req := range reqs {
		ok := false
		if req.Type == "subsystem" && !started && len(req.Payload) >= 4 && string(req.Payload[4:]) == "sftp" {
			ok, started = true, true
		}
		if req.WantReply {
			req.Reply(ok, nil)
		}
		if ok {
			go func() {
				// Drain further requests (e.g. window changes) without granting anything.
				for r := range reqs {
					if r.WantReply {
						r.Reply(false, nil)
					}
				}
			}()
			srv := sftp.NewRequestServer(ch, sftp.Handlers{FileGet: h, FilePut: h, FileCmd: h, FileList: h},
				sftp.WithStartDirectory("/"))
			_ = srv.Serve()
			srv.Close()
			return
		}
	}
}

// reauthLoop re-validates the login with the control plane at expiresAt; failure closes the session.
func (c *conn) reauthLoop(ctx context.Context) {
	for {
		c.mu.Lock()
		exp := time.UnixMilli(c.resp.ExpiresAt)
		c.mu.Unlock()
		wait := time.Until(exp)
		if wait < time.Second {
			wait = time.Second
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		if err := c.reauth(); err != nil {
			c.s.o.Logger.Info("sftp: session closed after failed re-authentication", "err", err)
			c.close()
			return
		}
	}
}

func (c *conn) reauth() error {
	c.mu.Lock()
	req := c.cred.req
	old := c.resp
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, err := c.s.o.Auth.Authenticate(ctx, req)
	if err != nil {
		return err
	}
	if err := validateResponse(resp, c.s.o.Now()); err != nil {
		return err
	}
	if resp.WorkloadID != old.WorkloadID || resp.UserID != old.UserID {
		return errors.New("re-authentication resolved to a different user or server")
	}
	c.mu.Lock()
	c.resp, c.deny = resp, denylist.New(resp.Denylist)
	c.mu.Unlock()
	return nil
}

func (c *conn) close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	sc := c.sshConn
	c.mu.Unlock()
	if sc != nil {
		sc.Close()
	}
	c.nc.Close()
}

// access returns the current permissions; expired logins are re-authenticated first.
func (c *conn) access() (perms map[string]bool, deny *denylist.List, ok bool) {
	c.mu.Lock()
	expired := c.s.o.Now().UnixMilli() >= c.resp.ExpiresAt
	c.mu.Unlock()
	if expired {
		if err := c.reauth(); err != nil {
			c.close()
			return nil, nil, false
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	perms = map[string]bool{}
	for _, p := range c.resp.Permissions {
		perms[p] = true
	}
	return perms, c.deny, !c.closed
}
