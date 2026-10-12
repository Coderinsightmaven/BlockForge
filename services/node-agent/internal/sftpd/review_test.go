package sftpd

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/blockforge/node-agent/internal/protocol"
)

// Finding 1: the denylist must hold for symlinked files, symlinked parents and link chains.
func TestDenylistNotBypassedBySymlinks(t *testing.T) {
	e := newEnv(t, nil)
	e.auth.denylist = []string{"server.properties", "/config/private"}
	os.WriteFile(filepath.Join(e.data, "server.properties"), []byte("rcon.password=hunter2\n"), 0o644)
	os.MkdirAll(filepath.Join(e.data, "config", "private"), 0o755)
	os.WriteFile(filepath.Join(e.data, "config", "private", "token.txt"), []byte("TOKEN"), 0o644)
	os.WriteFile(filepath.Join(e.data, "config", "public.yml"), []byte("ok"), 0o644)
	if err := os.Symlink("server.properties", filepath.Join(e.data, "public.properties")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	os.Symlink("config", filepath.Join(e.data, "pubdir"))
	os.Symlink("public.properties", filepath.Join(e.data, "chain1"))
	os.Symlink("chain1", filepath.Join(e.data, "chain2"))
	c := e.sftp(userRW, ssh.Password(pwRW))

	for _, p := range []string{"public.properties", "chain2", "pubdir/private/token.txt"} {
		if f, err := c.Open(p); !isPerm(err) {
			if f != nil {
				b, _ := io.ReadAll(f)
				f.Close()
				t.Fatalf("read %s through a symlink: %q", p, b)
			}
			t.Fatalf("read %s: %v", p, err)
		}
	}
	if f, err := c.Open("pubdir/public.yml"); err != nil {
		t.Fatalf("allowed file through symlinked parent: %v", err)
	} else {
		f.Close()
	}
	// Writing (incl. truncating open) through the link must not touch the protected file.
	if f, err := c.OpenFile("public.properties", os.O_WRONLY|os.O_TRUNC); !isPerm(err) {
		if f != nil {
			f.Close()
		}
		t.Fatalf("truncating open via symlink: %v", err)
	}
	if f, err := c.Create("chain2"); !isPerm(err) {
		if f != nil {
			f.Write([]byte("pwned"))
			f.Close()
		}
		t.Fatalf("create via chain: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(e.data, "server.properties")); string(b) != "rcon.password=hunter2\n" {
		t.Fatalf("protected file modified: %q", b)
	}
	for name, err := range map[string]error{
		"create below symlinked dir": func() error {
			f, err := c.Create("pubdir/private/new.txt")
			if f != nil {
				f.Close()
			}
			return err
		}(),
		"mkdir below symlinked dir": c.Mkdir("pubdir/private/sub"),
		"remove via symlinked dir":  c.Remove("pubdir/private/token.txt"),
		"rename tree":               c.Rename("config", "cfg"),
		"posix-rename tree":         c.PosixRename("config", "cfg2"),
		"rename link":               c.Rename("public.properties", "x.properties"),
		"rename onto denied":        c.PosixRename("pubdir/public.yml", "pubdir/private/public.yml"),
		"chmod via link":            c.Chmod("chain2", 0o600),
		"chtimes via link":          c.Chtimes("public.properties", time.Unix(1, 0), time.Unix(1, 0)),
	} {
		if !isPerm(err) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(e.data, "config", "private", "token.txt")); err != nil {
		t.Fatal("protected tree changed")
	}
	// Listing and stat still show the entries (Wings semantics).
	if _, err := c.Lstat("public.properties"); err != nil {
		t.Fatal(err)
	}
	if es, err := c.ReadDir("/"); err != nil || len(es) < 5 {
		t.Fatalf("listing: %v", err)
	}
	if acts := e.actions(1200 * time.Millisecond); len(acts) != 0 {
		t.Fatalf("refused operations reported as activity: %+v", acts)
	}
}

// Findings 5 + 6: timestamp-only setstat is reported as "utime"; the root can never be setstat'ed.
func TestSetstatRootAndUtime(t *testing.T) {
	e := newEnv(t, nil)
	c := e.sftp(userRW, ssh.Password(pwRW))
	before, _ := os.Stat(e.data)
	if err := c.Chtimes("/", time.Unix(1, 0), time.Unix(1, 0)); !isPerm(err) {
		t.Fatalf("chtimes on the data root: %v", err)
	}
	if err := c.Chmod("/", 0o700); !isPerm(err) {
		t.Fatalf("chmod on the data root: %v", err)
	}
	if after, _ := os.Stat(e.data); !after.ModTime().Equal(before.ModTime()) || after.Mode() != before.Mode() {
		t.Fatal("data root attributes changed")
	}
	os.WriteFile(filepath.Join(e.data, "a.txt"), []byte("a"), 0o644)
	if err := c.Chtimes("a.txt", time.Unix(1_700_000_000, 0), time.Unix(1_700_000_000, 0)); err != nil {
		t.Fatal(err)
	}
	acts := e.actions(1300 * time.Millisecond)
	if len(acts) != 1 || acts[0].Action != "utime" || acts[0].Path != "a.txt" {
		t.Fatalf("activity %+v", acts)
	}
}

// Finding 2: bytes trickled before authentication must not extend the pre-auth deadline.
func TestPreAuthDeadlineIsAbsolute(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.HandshakeTimeout = time.Second })
	nc, err := net.Dial("tcp", e.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	start := time.Now()
	closed := make(chan time.Duration, 1)
	go func() {
		buf := make([]byte, 256)
		for {
			if _, err := nc.Read(buf); err != nil {
				closed <- time.Since(start)
				return
			}
		}
	}()
	go func() { // slowloris: one byte every 100 ms, never completing the version line
		for i := 0; i < 50; i++ {
			if _, err := nc.Write([]byte("S")); err != nil {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	}()
	select {
	case d := <-closed:
		if d > 2500*time.Millisecond {
			t.Fatalf("closed only after %v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("trickling client kept the pre-auth slot past the deadline")
	}
}

// slowAuth counts concurrent and total control-plane verifications.
type slowAuth struct {
	fakeAuth
	inflight, maxInflight, total atomic.Int32
}

func (s *slowAuth) Authenticate(ctx context.Context, r protocol.SftpAuthRequest) (*protocol.SftpAuthResponse, error) {
	n := s.inflight.Add(1)
	defer s.inflight.Add(-1)
	s.total.Add(1)
	for {
		m := s.maxInflight.Load()
		if n <= m || s.maxInflight.CompareAndSwap(m, n) {
			break
		}
	}
	time.Sleep(200 * time.Millisecond)
	return s.fakeAuth.Authenticate(ctx, r)
}

// Finding 3: auth attempts cannot amplify into unbounded control-plane requests.
func TestAuthAmplificationBounded(t *testing.T) {
	sa := &slowAuth{}
	e := newEnv(t, func(o *Options) {
		o.Auth = sa
		o.AuthConcurrency, o.AuthRate, o.AuthBurst = 2, 5, 5
		o.FailuresPerIP = 1000 // isolate the global limits from the per-IP limiter
	})
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			e.dial(userRW, ssh.Password("wrong"))
		}()
	}
	wg.Wait()
	if m := sa.maxInflight.Load(); m > 2 {
		t.Fatalf("%d verifications in flight (cap 2)", m)
	}
	if n := sa.total.Load(); n > 5+5*4 { // burst + rate × test duration (generous)
		t.Fatalf("%d control-plane calls for 20 connections", n)
	}
	t.Logf("20 connections → %d control-plane calls, max %d in flight", sa.total.Load(), sa.maxInflight.Load())

	// One connection may try at most maxAuthTries passwords.
	sa2 := &slowAuth{}
	e2 := newEnv(t, func(o *Options) { o.Auth = sa2; o.FailuresPerIP = 1000 })
	tries := 0
	e2.dial(userRW, ssh.RetryableAuthMethod(ssh.PasswordCallback(func() (string, error) {
		tries++
		return "wrong", nil
	}), 10))
	if n := sa2.total.Load(); n > maxAuthTries {
		t.Fatalf("%d verifications on one connection (max %d)", n, maxAuthTries)
	}

	// Once the per-IP limiter trips, attempts never reach the control plane.
	sa3 := &slowAuth{}
	e3 := newEnv(t, func(o *Options) { o.Auth = sa3 })
	for i := 0; i < 3; i++ {
		e3.dial(userRW, ssh.Password("wrong"))
	}
	before := sa3.total.Load()
	for i := 0; i < 5; i++ {
		e3.dial(userRW, ssh.Password(pwRW))
	}
	if sa3.total.Load() != before {
		t.Fatalf("blocked IP still reached the control plane (%d → %d)", before, sa3.total.Load())
	}
}
