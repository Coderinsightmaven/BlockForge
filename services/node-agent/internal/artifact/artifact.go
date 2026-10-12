// Package artifact implements artifact.fetch (allowlisted HTTPS downloads with streaming checksum
// verification) and the fs.transfer.push/pull streams to the control plane.
package artifact

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/blockforge/node-agent/internal/config"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
	"github.com/blockforge/node-agent/internal/version"
)

// Result is the {bytes, sha256} result shared by artifact.fetch and fs.transfer.*.
type Result struct {
	Bytes  int64  `json:"bytes"`
	Sha256 string `json:"sha256"`
	// Cached is true when artifact.fetch was served from the node cache (fs.transfer.*: always false).
	Cached bool `json:"cached"`
}

// Progress receives byte counts (total = -1 when unknown).
type Progress func(done, total int64)

// Fetcher downloads artifacts from allowlisted hosts.
type Fetcher struct {
	Hosts *config.HostAllowlist
	// Transport overrides the HTTP transport (tests inject a TLS test server's trust roots).
	Transport     http.RoundTripper
	IdleTimeout   time.Duration
	MaxRedirects  int
	ProgressEvery time.Duration
	// Cache is the content-addressed artifact cache (nil = disabled).
	Cache *Cache
}

// DefaultTransport is a hardened transport: TLS ≥ 1.2, no transparent decompression, header timeout.
func DefaultTransport(tlsConf *tls.Config) *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	if tlsConf == nil {
		tlsConf = &tls.Config{}
	}
	if tlsConf.MinVersion < tls.VersionTLS12 {
		tlsConf.MinVersion = tls.VersionTLS12
	}
	t.TLSClientConfig = tlsConf
	t.DisableCompression = true
	t.ResponseHeaderTimeout = 30 * time.Second
	t.MaxIdleConnsPerHost = 4
	return t
}

type hostRefused struct{ err error }

func (h *hostRefused) Error() string { return h.err.Error() }

func newHash(alg string) (hash.Hash, error) {
	switch alg {
	case "sha1":
		return sha1.New(), nil
	case "sha256":
		return sha256.New(), nil
	case "sha512":
		return sha512.New(), nil
	}
	return nil, protocol.Errorf(protocol.CodeValidationFailed, "unsupported checksum algorithm %q", alg)
}

// idleReader cancels the request when no bytes arrive for the idle timeout.
type idleReader struct {
	r     io.Reader
	timer *time.Timer
	d     time.Duration
}

func (ir *idleReader) Read(b []byte) (int, error) {
	n, err := ir.r.Read(b)
	if n > 0 {
		ir.timer.Reset(ir.d)
	}
	return n, err
}

func statusError(code int, what string) error {
	switch {
	case code == http.StatusNotFound || code == http.StatusGone:
		return protocol.Errorf(protocol.CodeDownloadFailed, "%s: HTTP %d", what, code)
	case code == http.StatusTooManyRequests || code >= 500:
		return protocol.RetryableErrorf(protocol.CodeDownloadFailed, "%s: HTTP %d", what, code)
	}
	return protocol.Errorf(protocol.CodeDownloadFailed, "%s: HTTP %d", what, code)
}

// checksumLen is the hex length of each supported digest.
var checksumLen = map[string]int{"sha1": 40, "sha256": 64, "sha512": 128}

// checkDigest compares a finished hash with the expected checksum (constant time).
func checkDigest(h hash.Hash, c *protocol.Checksum) error {
	got := hex.EncodeToString(h.Sum(nil))
	want := strings.ToLower(c.Value)
	if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		return protocol.Errorf(protocol.CodeChecksumMismatch, "%s mismatch", c.Algorithm).
			WithDetails(map[string]any{"algorithm": c.Algorithm, "expected": want, "actual": got})
	}
	return nil
}

// Fetch implements artifact.fetch into the workload sandbox. With a checksum and cache=true the
// node's content-addressed cache is used (see Cache).
func (f *Fetcher) Fetch(ctx context.Context, root *fsops.Root, p *protocol.ArtifactFetchPayload, progress Progress) (*Result, error) {
	dest, err := fsops.CleanPath(p.DestPath, true)
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(p.URL)
	if err != nil || u.Host == "" {
		return nil, protocol.Errorf(protocol.CodeValidationFailed, "invalid URL")
	}
	// The allowlist applies even when the artifact is already cached.
	if err := f.Hosts.Allowed(u); err != nil {
		return nil, protocol.Errorf(protocol.CodeHostNotAllowed, "%v", err)
	}
	var verify hash.Hash
	if p.Checksum != nil {
		if verify, err = newHash(p.Checksum.Algorithm); err != nil {
			return nil, err
		}
		if len(p.Checksum.Value) != checksumLen[p.Checksum.Algorithm] {
			return nil, protocol.Errorf(protocol.CodeValidationFailed, "%s checksum must be %d hex characters",
				p.Checksum.Algorithm, checksumLen[p.Checksum.Algorithm])
		}
		if p.Cache && f.Cache != nil {
			return f.fetchCached(ctx, root, dest, u, p, progress)
		}
	}
	var tf *fsops.TempFile
	defer func() {
		if tf != nil {
			tf.Abort()
		}
	}()
	_, err = f.download(ctx, u, p.MaxBytes, progress, func() (io.Writer, error) {
		if err := root.MkdirAll(path.Dir(dest)); err != nil {
			return nil, err
		}
		t, err := root.CreateTemp(dest, 0o644)
		if err != nil {
			return nil, err
		}
		tf = t
		if verify != nil {
			return io.MultiWriter(tf, verify), nil
		}
		return tf, nil
	})
	if err != nil {
		return nil, err
	}
	if verify != nil {
		if err := checkDigest(verify, p.Checksum); err != nil {
			return nil, err
		}
	}
	sum, size, err := tf.Commit()
	tf = nil
	if err != nil {
		return nil, err
	}
	return &Result{Bytes: size, Sha256: sum}, nil
}

// download performs the allowlisted HTTPS GET (redirects re-validated, idle timeout, size limit) and
// streams the body into the writer returned by open, which is only called for a 200 response.
func (f *Fetcher) download(ctx context.Context, u *url.URL, maxBytes int64, progress Progress, open func() (io.Writer, error)) (int64, error) {
	maxRedirects := f.MaxRedirects
	if maxRedirects == 0 {
		maxRedirects = 5
	}
	tr := f.Transport
	if tr == nil {
		tr = DefaultTransport(nil)
	}
	client := &http.Client{
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return &hostRefused{fmt.Errorf("too many redirects")}
			}
			if err := f.Hosts.Allowed(req.URL); err != nil {
				return &hostRefused{fmt.Errorf("redirect refused: %w", err)}
			}
			return nil
		},
	}
	idle := f.IdleTimeout
	if idle <= 0 {
		idle = 60 * time.Second
	}
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return 0, protocol.Errorf(protocol.CodeValidationFailed, "invalid URL")
	}
	req.Header.Set("User-Agent", "BlockForge-Agent/"+version.Version)
	resp, err := client.Do(req)
	if err != nil {
		var hr *hostRefused
		if errors.As(err, &hr) {
			return 0, protocol.Errorf(protocol.CodeHostNotAllowed, "%v", hr.err)
		}
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		return 0, protocol.RetryableErrorf(protocol.CodeDownloadFailed, "download failed: %s", sanitize(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, statusError(resp.StatusCode, "download")
	}
	if resp.ContentLength > maxBytes {
		return 0, protocol.Errorf(protocol.CodeQuotaExceeded, "artifact is %d bytes (limit %d)", resp.ContentLength, maxBytes)
	}
	w, err := open()
	if err != nil {
		return 0, err
	}
	timer := time.AfterFunc(idle, cancel)
	defer timer.Stop()
	var src io.Reader = &idleReader{r: resp.Body, timer: timer, d: idle}
	src = io.LimitReader(src, maxBytes+1)
	n, err := copyWithProgress(w, src, resp.ContentLength, progress, f.ProgressEvery)
	if err != nil {
		if ctx.Err() != nil {
			return n, ctx.Err()
		}
		if pe, ok := protocol.AsError(err); ok {
			return n, pe
		}
		if rctx.Err() != nil {
			return n, protocol.RetryableErrorf(protocol.CodeDownloadFailed, "download stalled for %s", idle)
		}
		return n, protocol.RetryableErrorf(protocol.CodeDownloadFailed, "download interrupted: %s", sanitize(err))
	}
	if n > maxBytes {
		return n, protocol.Errorf(protocol.CodeQuotaExceeded, "artifact exceeds %d bytes", maxBytes)
	}
	if resp.ContentLength >= 0 && n != resp.ContentLength {
		return n, protocol.RetryableErrorf(protocol.CodeDownloadFailed, "short download (%d of %d bytes)", n, resp.ContentLength)
	}
	return n, nil
}

func copyWithProgress(dst io.Writer, src io.Reader, total int64, progress Progress, every time.Duration) (int64, error) {
	if every <= 0 {
		every = time.Second
	}
	buf := make([]byte, 128*1024)
	var n int64
	last := time.Now()
	for {
		m, rerr := src.Read(buf)
		if m > 0 {
			if _, werr := dst.Write(buf[:m]); werr != nil {
				return n, fsops.MapError("write", "artifact", werr)
			}
			n += int64(m)
			if progress != nil && time.Since(last) >= every {
				last = time.Now()
				progress(n, total)
			}
		}
		if rerr == io.EOF {
			if progress != nil {
				progress(n, total)
			}
			return n, nil
		}
		if rerr != nil {
			return n, rerr
		}
	}
}

// sanitize keeps error messages short and free of URL query strings (which may carry tokens).
func sanitize(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	s := err.Error()
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// ---------------------------------------------------------------------------
// Control-plane transfers

// Transfers streams files between the sandbox and the control plane.
type Transfers struct {
	Client *http.Client
	// URL builds the transfer endpoint for an id.
	URL func(transferID string) string
	// Auth returns a fresh `BFAgent …` header value.
	Auth func() (string, error)
}

var bufPool = sync.Pool{New: func() any { b := make([]byte, 128*1024); return &b }}

// Push uploads a sandbox file (fs.transfer.push).
func (t *Transfers) Push(ctx context.Context, root *fsops.Root, p *protocol.FsTransferPushPayload) (*Result, error) {
	name, err := fsops.CleanPath(p.Path, true)
	if err != nil {
		return nil, err
	}
	f, fi, err := root.OpenForRead(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return t.PushReader(ctx, f, fi.Size(), p.TransferID)
}

// PushReader streams size bytes from r to POST <cp>/agent/v1/transfers/:id (also used for backups).
func (t *Transfers) PushReader(ctx context.Context, r io.Reader, size int64, transferID string) (*Result, error) {
	h := sha256.New()
	counter := &countingReader{r: io.TeeReader(r, h)}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.URL(transferID), counter)
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "build request: %v", err)
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", "application/octet-stream")
	auth, err := t.Auth()
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "auth: %v", err)
	}
	req.Header.Set("Authorization", auth)
	resp, err := t.Client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, protocol.RetryableErrorf(protocol.CodeDownloadFailed, "upload failed: %s", sanitize(err))
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, statusError(resp.StatusCode, "upload")
	}
	return &Result{Bytes: counter.n, Sha256: hex.EncodeToString(h.Sum(nil))}, nil
}

// Pull downloads a control-plane stream into the sandbox via temp file + rename (fs.transfer.pull).
// If the response carries X-BlockForge-Sha256, it is verified.
func (t *Transfers) Pull(ctx context.Context, root *fsops.Root, p *protocol.FsTransferPullPayload) (*Result, error) {
	name, err := fsops.CleanPath(p.Path, true)
	if err != nil {
		return nil, err
	}
	if err := root.CheckDenied(name); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.URL(p.TransferID), nil)
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "build request: %v", err)
	}
	auth, err := t.Auth()
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "auth: %v", err)
	}
	req.Header.Set("Authorization", auth)
	resp, err := t.Client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, protocol.RetryableErrorf(protocol.CodeDownloadFailed, "transfer failed: %s", sanitize(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusNotFound {
			return nil, protocol.Errorf(protocol.CodeNotFound, "transfer %s not found", p.TransferID)
		}
		return nil, statusError(resp.StatusCode, "transfer")
	}
	if resp.ContentLength > p.MaxBytes {
		return nil, protocol.Errorf(protocol.CodeQuotaExceeded, "transfer is %d bytes (limit %d)", resp.ContentLength, p.MaxBytes)
	}
	if err := root.MkdirAll(path.Dir(name)); err != nil {
		return nil, err
	}
	tf, err := root.CreateTemp(name, 0o644)
	if err != nil {
		return nil, err
	}
	bp := bufPool.Get().(*[]byte)
	defer bufPool.Put(bp)
	n, err := io.CopyBuffer(tf, io.LimitReader(resp.Body, p.MaxBytes+1), *bp)
	if err != nil {
		tf.Abort()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, protocol.RetryableErrorf(protocol.CodeDownloadFailed, "transfer interrupted: %s", sanitize(err))
	}
	if n > p.MaxBytes {
		tf.Abort()
		return nil, protocol.Errorf(protocol.CodeQuotaExceeded, "transfer exceeds %d bytes", p.MaxBytes)
	}
	if want := strings.ToLower(resp.Header.Get("X-BlockForge-Sha256")); want != "" && want != tf.Sha256() {
		tf.Abort()
		return nil, protocol.Errorf(protocol.CodeChecksumMismatch, "sha256 mismatch").
			WithDetails(map[string]any{"expected": want, "actual": tf.Sha256()})
	}
	sum, size, err := tf.Commit()
	if err != nil {
		return nil, err
	}
	return &Result{Bytes: size, Sha256: sum}, nil
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	c.n += int64(n)
	return n, err
}
