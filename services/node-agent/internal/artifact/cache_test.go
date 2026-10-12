package artifact

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/config"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
)

type cacheEnv struct {
	srv   *httptest.Server
	hits  atomic.Int32
	f     *Fetcher
	root  *fsops.Root
	data  string
	cache *Cache
}

func newCacheEnv(t *testing.T, maxBytes int64, bodies map[string][]byte) *cacheEnv {
	t.Helper()
	e := &cacheEnv{}
	e.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.hits.Add(1)
		b, ok := bodies[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		time.Sleep(50 * time.Millisecond) // widen the window for concurrent requests
		w.Write(b)
	}))
	t.Cleanup(e.srv.Close)
	u, _ := url.Parse(e.srv.URL)
	base := t.TempDir()
	var err error
	if e.cache, err = NewCache(filepath.Join(base, "cache", "artifacts"), maxBytes); err != nil {
		t.Fatal(err)
	}
	e.f = &Fetcher{Hosts: config.NewHostAllowlist([]string{u.Host}), Transport: e.srv.Client().Transport, Cache: e.cache}
	s := &fsops.Sandbox{DataRoot: base, UID: 1000, GID: 1000}
	s.EnsureDataDir(wid)
	if e.root, err = s.Open(wid); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.root.Close() })
	e.data = s.DataDir(wid)
	return e
}

func sha1Hex(b []byte) string {
	h := sha1.Sum(b)
	return hex.EncodeToString(h[:])
}

func (e *cacheEnv) fetch(path, dest string, sum *protocol.Checksum, cache bool) (*Result, error) {
	return e.f.Fetch(context.Background(), e.root, &protocol.ArtifactFetchPayload{
		URL: e.srv.URL + path, DestPath: dest, Checksum: sum, MaxBytes: 1 << 20, Cache: cache}, nil)
}

func TestCacheHitAndDedupe(t *testing.T) {
	_, s256, _ := sums()
	e := newCacheEnv(t, 10<<20, map[string][]byte{"/file.jar": payload})
	sum := &protocol.Checksum{Algorithm: "sha256", Value: s256}
	res, err := e.fetch("/file.jar", "server.jar", sum, true)
	if err != nil || res.Cached || res.Sha256 != s256 {
		t.Fatalf("miss: %v %+v", err, res)
	}
	res, err = e.fetch("/file.jar", "other/server.jar", sum, true)
	if err != nil || !res.Cached || res.Bytes != int64(len(payload)) || e.hits.Load() != 1 {
		t.Fatalf("hit: %v %+v hits=%d", err, res, e.hits.Load())
	}
	if b, _ := os.ReadFile(filepath.Join(e.data, "other", "server.jar")); string(b) != string(payload) {
		t.Fatal("content")
	}
	// The sandbox copy is independent of the cache entry (no shared inode).
	os.WriteFile(filepath.Join(e.data, "server.jar"), []byte("modified in place by the workload"), 0o644)
	res, err = e.fetch("/file.jar", "third.jar", sum, true)
	if err != nil || !res.Cached || res.Sha256 != s256 {
		t.Fatalf("cache poisoned through the sandbox copy: %v %+v", err, res)
	}
	if runtime := cacheMode(t, e.cache.path("sha256", s256)); runtime&0o222 != 0 {
		t.Fatalf("cache entry writable: %o", runtime)
	}

	// 8 concurrent fetches of a new artifact → exactly one download.
	body := []byte(strings.Repeat("concurrent|", 1000))
	e2 := newCacheEnv(t, 10<<20, map[string][]byte{"/c.jar": body})
	sum1 := &protocol.Checksum{Algorithm: "sha1", Value: sha1Hex(body)}
	var wg sync.WaitGroup
	var cached atomic.Int32
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, err := e2.fetch("/c.jar", "c"+string(rune('a'+i))+".jar", sum1, true)
			if err != nil {
				errs <- err
				return
			}
			if r.Cached {
				cached.Add(1)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if e2.hits.Load() != 1 || cached.Load() != 7 {
		t.Fatalf("dedupe: %d downloads, %d cached", e2.hits.Load(), cached.Load())
	}
}

func cacheMode(t *testing.T, p string) os.FileMode {
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if os.PathSeparator == '\\' {
		return 0o444 // Windows has no POSIX mode bits beyond read-only
	}
	return fi.Mode().Perm()
}

func TestCacheCorruptionAndBypass(t *testing.T) {
	_, s256, _ := sums()
	e := newCacheEnv(t, 10<<20, map[string][]byte{"/file.jar": payload})
	sum := &protocol.Checksum{Algorithm: "sha256", Value: s256}
	if _, err := e.fetch("/file.jar", "a.jar", sum, true); err != nil {
		t.Fatal(err)
	}
	// Corrupt the entry behind the agent's back: it is detected, evicted and re-downloaded.
	cp := e.cache.path("sha256", s256)
	os.Chmod(cp, 0o644)
	os.WriteFile(cp, []byte("corrupted"), 0o444)
	res, err := e.fetch("/file.jar", "b.jar", sum, true)
	if err != nil || res.Cached || res.Sha256 != s256 || e.hits.Load() != 2 {
		t.Fatalf("corruption: %v %+v hits=%d", err, res, e.hits.Load())
	}
	// cache:false and checksum:null bypass the cache entirely.
	res, err = e.fetch("/file.jar", "c.jar", sum, false)
	if err != nil || res.Cached || e.hits.Load() != 3 {
		t.Fatalf("cache=false: %v %+v", err, res)
	}
	res, err = e.fetch("/file.jar", "d.jar", nil, true)
	if err != nil || res.Cached || e.hits.Load() != 4 {
		t.Fatalf("no checksum: %v %+v", err, res)
	}
	// A checksum mismatch on download leaves nothing in the cache or the sandbox.
	bad := &protocol.Checksum{Algorithm: "sha256", Value: strings.Repeat("ab", 32)}
	if _, err := e.fetch("/file.jar", "e.jar", bad, true); codeOf(err) != protocol.CodeChecksumMismatch {
		t.Fatalf("mismatch: %v", err)
	}
	if _, err := os.Stat(e.cache.path("sha256", bad.Value)); err == nil {
		t.Fatal("bad artifact cached")
	}
	if _, err := os.Stat(filepath.Join(e.data, "e.jar")); err == nil {
		t.Fatal("bad artifact installed")
	}
	entries, _ := os.ReadDir(filepath.Join(e.cache.Dir, "sha256"))
	for _, en := range entries {
		if strings.HasPrefix(en.Name(), ".") {
			t.Fatalf("temp file left in cache: %s", en.Name())
		}
	}
	// Wrong checksum length for the algorithm.
	if _, err := e.fetch("/file.jar", "f.jar", &protocol.Checksum{Algorithm: "sha512", Value: s256}, true); codeOf(err) != protocol.CodeValidationFailed {
		t.Fatalf("length: %v", err)
	}
	// Host allowlist applies even to cached artifacts.
	e.f.Hosts = config.NewHostAllowlist([]string{"elsewhere.example"})
	if _, err := e.fetch("/file.jar", "g.jar", sum, true); codeOf(err) != protocol.CodeHostNotAllowed {
		t.Fatalf("allowlist on hit: %v", err)
	}
}

func TestCacheLRUEviction(t *testing.T) {
	bodies := map[string][]byte{}
	sumsOf := map[string]string{}
	for _, n := range []string{"a", "b", "c"} {
		b := []byte(strings.Repeat(n, 4000))
		bodies["/"+n] = b
		sumsOf[n] = sha1Hex(b)
	}
	e := newCacheEnv(t, 9000, bodies) // room for two 4000-byte entries
	clock := time.Unix(1_760_000_000, 0)
	e.cache.now = func() time.Time { clock = clock.Add(time.Minute); return clock }
	get := func(n string) *Result {
		r, err := e.fetch("/"+n, n+"-"+clock.Format("150405")+".bin", &protocol.Checksum{Algorithm: "sha1", Value: sumsOf[n]}, true)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	get("a")
	get("b")
	get("a") // a is now more recently used than b
	get("c") // evicts b
	if _, err := os.Stat(e.cache.path("sha1", sumsOf["b"])); err == nil {
		t.Fatal("LRU entry b not evicted")
	}
	for _, n := range []string{"a", "c"} {
		if _, err := os.Stat(e.cache.path("sha1", sumsOf[n])); err != nil {
			t.Fatalf("%s evicted", n)
		}
	}
	if e.cache.Size() > 9000 {
		t.Fatalf("cache size %d", e.cache.Size())
	}
	if r := get("a"); !r.Cached {
		t.Fatal("a should still be cached")
	}
}
