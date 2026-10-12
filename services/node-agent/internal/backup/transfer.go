package backup

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/blockforge/node-agent/internal/artifact"
	"github.com/blockforge/node-agent/internal/protocol"
	"github.com/blockforge/node-agent/internal/workload"
)

// presignedClient talks to object storage: HTTPS only, redirects are never followed (a presigned
// URL redirecting elsewhere is treated as an error), no transparent decompression.
func (m *Manager) presignedClient() *http.Client {
	tr := m.Transport
	if tr == nil {
		tr = artifact.DefaultTransport(nil)
	}
	return &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

// scrub turns a transport error into a message without the URL (presigned query strings are
// credentials).
func scrub(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	s := err.Error()
	if i := strings.Index(s, "?"); i >= 0 {
		s = s[:i] + "?[REDACTED]"
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

func validPresigned(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return nil, protocol.Errorf(protocol.CodeValidationFailed, "presigned URLs must be https")
	}
	return u, nil
}

// ---------------------------------------------------------------------------
// backup.upload

// UploadPart is one uploaded part.
type UploadPart struct {
	PartNumber int    `json:"partNumber"`
	ETag       string `json:"etag"`
}

// UploadResult is the backup.upload result.
type UploadResult struct {
	Parts []UploadPart `json:"parts"`
}

// Upload PUTs the archive's parts to presigned multipart URLs (3 in flight, retries with backoff).
func (m *Manager) Upload(ctx context.Context, p *protocol.BackupUploadPayload, progress Progress) (*UploadResult, error) {
	f, size, err := m.openArchive(p.WorkloadID, p.BackupID)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	n := int((size + p.PartSize - 1) / p.PartSize)
	if n == 0 {
		n = 1
	}
	if len(p.Parts) != n {
		return nil, protocol.Errorf(protocol.CodeValidationFailed, "archive of %d bytes needs %d parts of %d bytes, got %d", size, n, p.PartSize, len(p.Parts)).
			WithDetails(map[string]any{"sizeBytes": size, "expectedParts": n})
	}
	seen := map[int]bool{}
	for _, part := range p.Parts {
		if part.PartNumber < 1 || part.PartNumber > n || seen[part.PartNumber] {
			return nil, protocol.Errorf(protocol.CodeValidationFailed, "parts must be numbered 1..%d exactly once", n)
		}
		seen[part.PartNumber] = true
		if _, err := validPresigned(part.URL); err != nil {
			return nil, err
		}
	}
	client := m.presignedClient()
	workers := m.UploadConcurrency
	if workers <= 0 {
		workers = 3
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan protocol.BackupUploadPart)
	var mu sync.Mutex
	var firstErr error
	var done int64
	out := make([]UploadPart, 0, len(p.Parts))
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for part := range jobs {
				off := int64(part.PartNumber-1) * p.PartSize
				length := min(p.PartSize, size-off)
				etag, err := m.putPart(ctx, client, f, part, off, length)
				mu.Lock()
				if err != nil {
					if firstErr == nil {
						firstErr = err
						cancel()
					}
				} else {
					out = append(out, UploadPart{PartNumber: part.PartNumber, ETag: etag})
					done += length
					if progress != nil {
						progress("upload", fmt.Sprintf("%d of %d parts, %d of %d MiB", len(out), n, mib(done), mib(size)), ptrPct(done, size))
					}
				}
				mu.Unlock()
			}
		}()
	}
	sorted := append([]protocol.BackupUploadPart(nil), p.Parts...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].PartNumber < sorted[j].PartNumber })
feed:
	for _, part := range sorted {
		select {
		case jobs <- part:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PartNumber < out[j].PartNumber })
	if p.DeleteLocal {
		f.Close()
		if err := os.Remove(m.ArchivePath(p.WorkloadID, p.BackupID)); err != nil {
			m.Logger.Warn("uploaded backup could not be deleted locally", "backup", p.BackupID, "err", err)
		}
	}
	return &UploadResult{Parts: out}, nil
}

// putPart uploads one part with retries on network errors, 429 and 5xx (exponential backoff with
// jitter); other statuses fail immediately (e.g. 403 for an expired signature).
func (m *Manager) putPart(ctx context.Context, client *http.Client, f *os.File, part protocol.BackupUploadPart, off, length int64) (string, error) {
	attempts := m.PartAttempts
	if attempts <= 0 {
		attempts = 4
	}
	base := m.RetryBase
	if base <= 0 {
		base = time.Second
	}
	var last error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			d := base << (i - 1)
			d = d/2 + time.Duration(rand.Int64N(int64(d/2)+1))
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(d):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, part.URL, io.NewSectionReader(f, off, length))
		if err != nil {
			return "", protocol.Errorf(protocol.CodeValidationFailed, "part %d: invalid URL", part.PartNumber)
		}
		req.ContentLength = length
		if length == 0 {
			req.Body = http.NoBody
		}
		resp, err := client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			last = protocol.RetryableErrorf(protocol.CodeDownloadFailed, "part %d: upload failed: %s", part.PartNumber, scrub(err))
			continue
		}
		io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusOK:
			etag := resp.Header.Get("ETag")
			if etag == "" || len(etag) > 256 {
				return "", protocol.Errorf(protocol.CodeDownloadFailed, "part %d: storage returned no usable ETag", part.PartNumber)
			}
			return etag, nil
		case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
			last = protocol.RetryableErrorf(protocol.CodeDownloadFailed, "part %d: HTTP %d", part.PartNumber, resp.StatusCode)
		default:
			return "", protocol.Errorf(protocol.CodeDownloadFailed, "part %d: HTTP %d", part.PartNumber, resp.StatusCode)
		}
	}
	return "", last
}

// ---------------------------------------------------------------------------
// backup.restore

// RestoreResult is the backup.restore result.
type RestoreResult struct {
	Files      int64 `json:"files"`
	Bytes      int64 `json:"bytes"`
	DurationMs int64 `json:"durationMs"`
}

func digestMatches(got []byte, want string) bool {
	return subtle.ConstantTimeCompare([]byte(hex.EncodeToString(got)), []byte(strings.ToLower(want))) == 1
}

// download fetches a presigned URL into a temp file under <dataRoot>/backups/.tmp, hashing on the
// way; at most maxBytes are accepted and the free-disk reserve is kept.
func (m *Manager) download(ctx context.Context, raw string, maxBytes int64, progress Progress) (*os.File, []byte, error) {
	if _, err := validPresigned(raw); err != nil {
		return nil, nil, err
	}
	tmpDir := filepath.Join(m.DataRoot, "backups", ".tmp")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return nil, nil, protocol.Errorf(protocol.CodeInternal, "restore temp dir: %v", err)
	}
	if err := m.checkReserve(tmpDir); err != nil {
		return nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, nil, protocol.Errorf(protocol.CodeValidationFailed, "invalid backup URL")
	}
	resp, err := m.presignedClient().Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		return nil, nil, protocol.RetryableErrorf(protocol.CodeDownloadFailed, "backup download failed: %s", scrub(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		retry := resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
		return nil, nil, &protocol.Error{Code: protocol.CodeDownloadFailed, Message: fmt.Sprintf("backup download: HTTP %d", resp.StatusCode), Retryable: retry}
	}
	if resp.ContentLength > maxBytes {
		return nil, nil, protocol.Errorf(protocol.CodeQuotaExceeded, "backup is %d bytes (limit %d)", resp.ContentLength, maxBytes)
	}
	tmp, err := os.OpenFile(filepath.Join(tmpDir, randomName()+".tar.gz"), os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, nil, protocol.Errorf(protocol.CodeInternal, "restore temp file: %v", err)
	}
	fail := func(e error) (*os.File, []byte, error) {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, nil, e
	}
	h := sha256.New()
	aw := &archiveWriter{m: m, w: tmp, h: h, dir: tmpDir, max: maxBytes}
	buf := make([]byte, 256*1024)
	last := time.Now()
	var n int64
	for {
		k, rerr := resp.Body.Read(buf)
		if k > 0 {
			if _, werr := aw.Write(buf[:k]); werr != nil {
				if pe, ok := protocol.AsError(werr); ok {
					return fail(pe)
				}
				return fail(protocol.Errorf(protocol.CodeInternal, "write restore temp file: %v", werr))
			}
			n += int64(k)
			if progress != nil && time.Since(last) >= progressEvery {
				last = time.Now()
				progress("download", fmt.Sprintf("%d MiB", mib(n)), ptrPct(n, resp.ContentLength))
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			if ctx.Err() != nil {
				return fail(ctx.Err())
			}
			return fail(protocol.RetryableErrorf(protocol.CodeDownloadFailed, "backup download interrupted: %s", scrub(rerr)))
		}
	}
	if resp.ContentLength >= 0 && n != resp.ContentLength {
		return fail(protocol.RetryableErrorf(protocol.CodeDownloadFailed, "short backup download (%d of %d bytes)", n, resp.ContentLength))
	}
	return tmp, h.Sum(nil), nil
}

// Restore replaces/merges the stopped workload's data with a backup, verifying it first.
func (m *Manager) Restore(ctx context.Context, p *protocol.BackupRestorePayload, progress Progress) (*RestoreResult, error) {
	start := time.Now()
	release, err := m.Claims.Claim(ctx, p.WorkloadID, workload.ClaimRestore)
	if err != nil {
		return nil, err
	}
	defer release()

	var f *os.File
	var digest []byte
	switch p.Source.Type {
	case "local":
		var size int64
		f, size, err = m.openArchive(p.WorkloadID, p.BackupID)
		if err != nil {
			return nil, err
		}
		h := sha256.New()
		if progress != nil {
			progress("verify", fmt.Sprintf("verifying %d MiB", mib(size)), nil)
		}
		if _, err := io.Copy(h, f); err != nil {
			f.Close()
			return nil, protocol.Errorf(protocol.CodeInternal, "read backup: %v", err)
		}
		digest = h.Sum(nil)
		defer f.Close()
	case "url":
		f, digest, err = m.download(ctx, p.Source.URL, p.MaxTotalBytes, progress)
		if err != nil {
			return nil, err
		}
		defer func() {
			f.Close()
			os.Remove(f.Name())
		}()
	default:
		return nil, protocol.Errorf(protocol.CodeValidationFailed, "unknown backup source %q", p.Source.Type)
	}
	// Integrity BEFORE the data dir is touched.
	if !digestMatches(digest, p.Sha256) {
		return nil, protocol.Errorf(protocol.CodeChecksumMismatch, "backup sha256 mismatch").
			WithDetails(map[string]any{"expected": strings.ToLower(p.Sha256), "actual": hex.EncodeToString(digest)})
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "rewind backup: %v", err)
	}
	fi, err := f.Stat()
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "stat backup: %v", err)
	}
	if err := m.Sandbox.EnsureDataDir(p.WorkloadID); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "prepare data directory: %v", err)
	}
	root, err := m.Sandbox.Open(p.WorkloadID)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	last := time.Now()
	res, err := root.ExtractFrom(f, fi.Size(), ".", fsopsArchiveOptions(p, root, progress, &last))
	if err != nil {
		return nil, err
	}
	return &RestoreResult{Files: res.Files, Bytes: res.Bytes, DurationMs: time.Since(start).Milliseconds()}, nil
}
