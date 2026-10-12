package artifact

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/blockforge/node-agent/internal/fileutil"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
)

// Cache is the node's content-addressed artifact cache: <dir>/<algorithm>/<hex value>. Entries are
// verified when they are downloaded, stored read-only (0444, agent-owned, outside every sandbox) and
// re-verified while being copied into a sandbox, so a corrupted entry is evicted and re-downloaded
// instead of being handed out. Concurrent fetches of the same artifact share one download.
//
// Entries are COPIED into sandboxes, never hard-linked: a hard link shares the inode, and in-place
// writers inside a workload (an egg install script's `curl -o server.jar`, plugin updaters, a root
// install container) would modify the cached file and every other server's copy with it.
type Cache struct {
	Dir      string
	MaxBytes int64

	mu    sync.Mutex
	locks map[string]*keyLock
	evMu  sync.Mutex
	now   func() time.Time
}

type keyLock struct {
	mu   sync.Mutex
	refs int
}

// NewCache creates the cache directory (0700) if needed.
func NewCache(dir string, maxBytes int64) (*Cache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Cache{Dir: dir, MaxBytes: maxBytes, locks: map[string]*keyLock{}, now: time.Now}, nil
}

func (c *Cache) path(alg, value string) string { return filepath.Join(c.Dir, alg, value) }

// acquire serialises work on one key (download dedupe); the returned func releases it.
func (c *Cache) acquire(key string) func() {
	c.mu.Lock()
	l := c.locks[key]
	if l == nil {
		l = &keyLock{}
		c.locks[key] = l
	}
	l.refs++
	c.mu.Unlock()
	l.mu.Lock()
	return func() {
		l.mu.Unlock()
		c.mu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(c.locks, key)
		}
		c.mu.Unlock()
	}
}

var errCacheUnusable = errors.New("cache entry unusable")

// install copies a cache entry into the sandbox, verifying its digest on the way.
func (c *Cache) install(root *fsops.Root, dest, cachePath string, sum *protocol.Checksum) (*Result, error) {
	src, err := os.Open(cachePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, errCacheUnusable // evicted concurrently
		}
		return nil, protocol.Errorf(protocol.CodeInternal, "open cache entry: %v", err)
	}
	defer src.Close()
	h, err := newHash(sum.Algorithm)
	if err != nil {
		return nil, err
	}
	if err := root.MkdirAll(path.Dir(dest)); err != nil {
		return nil, err
	}
	tf, err := root.CreateTemp(dest, 0o644)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(io.MultiWriter(tf, h), src); err != nil {
		tf.Abort()
		return nil, fsops.MapError("write", dest, err)
	}
	if checkDigest(h, sum) != nil {
		tf.Abort()
		return nil, errCacheUnusable
	}
	digest, size, err := tf.Commit()
	if err != nil {
		return nil, err
	}
	now := c.now()
	_ = os.Chtimes(cachePath, now, now) // LRU: mtime = last use
	return &Result{Bytes: size, Sha256: digest}, nil
}

// evict removes least recently used entries until the cache fits MaxBytes.
func (c *Cache) evict() {
	c.evMu.Lock()
	defer c.evMu.Unlock()
	type ent struct {
		path string
		size int64
		mod  time.Time
	}
	var all []ent
	var total int64
	for alg := range checksumLen {
		entries, err := os.ReadDir(filepath.Join(c.Dir, alg))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") || !e.Type().IsRegular() {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			all = append(all, ent{filepath.Join(c.Dir, alg, e.Name()), info.Size(), info.ModTime()})
			total += info.Size()
		}
	}
	if total <= c.MaxBytes {
		return
	}
	sort.Slice(all, func(i, j int) bool { return all[i].mod.Before(all[j].mod) })
	for _, e := range all {
		if total <= c.MaxBytes {
			return
		}
		if removeEntry(e.path) == nil {
			total -= e.size
		}
	}
}

// Size returns the current total size of cached entries (tests, diagnostics).
func (c *Cache) Size() int64 {
	var total int64
	for alg := range checksumLen {
		entries, _ := os.ReadDir(filepath.Join(c.Dir, alg))
		for _, e := range entries {
			if info, err := e.Info(); err == nil && e.Type().IsRegular() && !strings.HasPrefix(e.Name(), ".") {
				total += info.Size()
			}
		}
	}
	return total
}

// fetchCached serves artifact.fetch from the cache, downloading into it on a miss.
func (f *Fetcher) fetchCached(ctx context.Context, root *fsops.Root, dest string, u *url.URL, p *protocol.ArtifactFetchPayload, progress Progress) (*Result, error) {
	c := f.Cache
	sum := &protocol.Checksum{Algorithm: p.Checksum.Algorithm, Value: strings.ToLower(p.Checksum.Value)}
	release := c.acquire(sum.Algorithm + "/" + sum.Value)
	defer release()
	cachePath := c.path(sum.Algorithm, sum.Value)
	if fi, err := os.Lstat(cachePath); err == nil && fi.Mode().IsRegular() {
		if fi.Size() > p.MaxBytes {
			return nil, protocol.Errorf(protocol.CodeQuotaExceeded, "artifact is %d bytes (limit %d)", fi.Size(), p.MaxBytes)
		}
		res, err := c.install(root, dest, cachePath, sum)
		if err == nil {
			res.Cached = true
			if progress != nil {
				progress(res.Bytes, res.Bytes)
			}
			return res, nil
		}
		if !errors.Is(err, errCacheUnusable) {
			return nil, err
		}
		_ = removeEntry(cachePath) // corrupted or vanished: download again
	}
	if err := f.downloadToCache(ctx, u, p.MaxBytes, sum, cachePath, progress); err != nil {
		return nil, err
	}
	res, err := c.install(root, dest, cachePath, sum)
	if errors.Is(err, errCacheUnusable) {
		return nil, protocol.RetryableErrorf(protocol.CodeInternal, "artifact cache entry changed during install")
	}
	if err != nil {
		return nil, err
	}
	c.evict()
	return res, nil
}

func (f *Fetcher) downloadToCache(ctx context.Context, u *url.URL, maxBytes int64, sum *protocol.Checksum, cachePath string, progress Progress) error {
	dir := filepath.Dir(cachePath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return protocol.Errorf(protocol.CodeInternal, "artifact cache: %v", err)
	}
	h, err := newHash(sum.Algorithm)
	if err != nil {
		return err
	}
	var tmp *os.File
	defer func() {
		if tmp != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	_, err = f.download(ctx, u, maxBytes, progress, func() (io.Writer, error) {
		t, err := os.CreateTemp(dir, ".dl-*")
		if err != nil {
			return nil, protocol.Errorf(protocol.CodeInternal, "artifact cache: %v", err)
		}
		tmp = t
		return io.MultiWriter(tmp, h), nil
	})
	if err != nil {
		return err
	}
	if err := checkDigest(h, sum); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return protocol.Errorf(protocol.CodeInternal, "artifact cache: %v", err)
	}
	name := tmp.Name()
	tmp.Close()
	if err := os.Chmod(name, 0o444); err != nil {
		os.Remove(name)
		tmp = nil
		return protocol.Errorf(protocol.CodeInternal, "artifact cache: %v", err)
	}
	if err := os.Rename(name, cachePath); err != nil {
		os.Remove(name)
		tmp = nil
		return protocol.Errorf(protocol.CodeInternal, "artifact cache: %v", err)
	}
	tmp = nil
	fileutil.SyncDir(dir)
	return nil
}

// removeEntry deletes a read-only cache entry (Windows refuses to delete read-only files).
func removeEntry(p string) error {
	_ = os.Chmod(p, 0o600)
	return os.Remove(p)
}
