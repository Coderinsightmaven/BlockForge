package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/md5"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/artifact"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
)

const (
	wid = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
	bid = "2b3c4d5e-6f70-4a81-9b2c-3d4e5f607182"
)

type fakeClaims struct {
	mu   sync.Mutex
	held map[string]string
}

func (f *fakeClaims) Claim(_ context.Context, id, what string) (func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.held == nil {
		f.held = map[string]string{}
	}
	if h, ok := f.held[id]; ok {
		return nil, protocol.RetryableErrorf(protocol.CodeBusy, "%s in progress", h)
	}
	f.held[id] = what
	return func() { f.mu.Lock(); delete(f.held, id); f.mu.Unlock() }, nil
}

func code(err error) protocol.ErrorCode {
	if pe, ok := protocol.AsError(err); ok {
		return pe.Code
	}
	if err == nil {
		return ""
	}
	return protocol.ErrorCode("raw:" + err.Error())
}

func newManager(t *testing.T) (*Manager, string) {
	t.Helper()
	base := t.TempDir()
	sb := &fsops.Sandbox{DataRoot: base, UID: 1000, GID: 1000}
	if err := sb.EnsureDataDir(wid); err != nil {
		t.Fatal(err)
	}
	m := &Manager{DataRoot: base, Sandbox: sb, Claims: &fakeClaims{}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		RetryBase: 10 * time.Millisecond}
	return m, sb.DataDir(wid)
}

func write(t *testing.T, dir, rel, content string, mode os.FileMode) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	os.Chmod(p, mode)
}

func populate(t *testing.T, data string) {
	write(t, data, "server.properties", "motd=hi\n", 0o644)
	write(t, data, "start.sh", "#!/bin/sh\n", 0o755)
	write(t, data, "world/level.dat", "LEVEL", 0o644)
	write(t, data, "world/region/r.0.0.mca", strings.Repeat("R", 10000), 0o644)
	write(t, data, "logs/latest.log", "noise", 0o644)
	write(t, data, "logs/keep.log", "keep me", 0o644)
	write(t, data, "crash.tmp", "tmp", 0o644)
	write(t, data, "cache/huge.bin", "cached", 0o644)
	write(t, data, "old.bak", "bak", 0o644)
	write(t, data, ".blockforge/jvm.json", "{}", 0o644)
	write(t, data, ".pteroignore", "cache/\n", 0o644)
	write(t, data, ".blockforgeignore", "# comment\r\n*.bak\r\n", 0o644)
}

func listArchive(t *testing.T, p string) map[string]string {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	out := map[string]string{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		out[h.Name] = fmt.Sprintf("%o:%s", h.Mode, b)
	}
}

func sha(p string) string {
	b, _ := os.ReadFile(p)
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func createPayload() *protocol.BackupCreatePayload {
	return &protocol.BackupCreatePayload{WorkloadID: wid, BackupID: bid, Ignore: []string{"logs/", "*.tmp", "!logs/keep.log"}, MaxBytes: 1 << 30}
}

func TestCreateFiltersAndIsDeterministic(t *testing.T) {
	m, data := newManager(t)
	populate(t, data)
	specials := 0
	if os.Symlink("server.properties", filepath.Join(data, "link")) == nil {
		specials++
	}
	if mkfifo(filepath.Join(data, "pipe")) == nil {
		specials++
	}
	var stages []string
	res, err := m.Create(context.Background(), createPayload(), func(stage, msg string, _ *float64) { stages = append(stages, stage) })
	if err != nil {
		t.Fatal(err)
	}
	p := m.ArchivePath(wid, bid)
	entries := listArchive(t, p)
	var names []string
	for n := range entries {
		names = append(names, n)
	}
	sort.Strings(names)
	want := ".blockforgeignore,.pteroignore,logs/keep.log,server.properties,start.sh,world/,world/level.dat,world/region/,world/region/r.0.0.mca"
	if strings.Join(names, ",") != want {
		t.Fatalf("archive entries\n got %s\nwant %s", strings.Join(names, ","), want)
	}
	if runtime.GOOS != "windows" && !strings.HasPrefix(entries["start.sh"], "755:") {
		t.Fatalf("mode not archived: %s", entries["start.sh"])
	}
	if res.Files != 7 || res.SkippedSymlinks != int64(specials) || res.SizeBytes <= 0 || res.Sha256 != sha(p) || len(stages) == 0 {
		t.Fatalf("result %+v (specials %d, stages %v)", res, specials, stages)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
			t.Fatalf("archive mode %v", fi.Mode())
		}
	}
	// Same data → byte-identical archive (deterministic order, fixed gzip header).
	p2 := *createPayload()
	p2.BackupID = "3b3c4d5e-6f70-4a81-9b2c-3d4e5f607182"
	res2, err := m.Create(context.Background(), &p2, nil)
	if err != nil || res2.Sha256 != res.Sha256 {
		t.Fatalf("not deterministic: %v %s vs %s", err, res2.Sha256, res.Sha256)
	}
	_, err = m.Create(context.Background(), createPayload(), nil)
	if code(err) != protocol.CodeAlreadyExists {
		t.Fatalf("duplicate backup id: %v", err)
	}
}

func noTemps(t *testing.T, dir string) {
	t.Helper()
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") && e.Name() != ".tmp" {
			t.Fatalf("temp file left: %s", e.Name())
		}
	}
}

func TestCreateQuotaAndBusy(t *testing.T) {
	m, data := newManager(t)
	populate(t, data)
	p := createPayload()
	p.MaxBytes = 100
	if _, err := m.Create(context.Background(), p, nil); code(err) != protocol.CodeQuotaExceeded {
		t.Fatalf("maxBytes: %v", err)
	}
	m.FreeSpace = func(string) (int64, error) { return 1 << 20, nil } // below the 2 GiB default reserve
	if _, err := m.Create(context.Background(), createPayload(), nil); code(err) != protocol.CodeQuotaExceeded {
		t.Fatalf("reserve: %v", err)
	}
	m.FreeSpace = nil
	if _, err := os.Stat(m.ArchivePath(wid, bid)); err == nil {
		t.Fatal("archive published after a quota failure")
	}
	noTemps(t, m.dir(wid))
	release, _ := m.Claims.Claim(context.Background(), wid, "backup")
	if _, err := m.Create(context.Background(), createPayload(), nil); code(err) != protocol.CodeBusy {
		t.Fatalf("concurrent backup: %v", err)
	}
	release()
}

func TestRestoreLocalTruncateAndIntegrity(t *testing.T) {
	m, data := newManager(t)
	populate(t, data)
	res, err := m.Create(context.Background(), createPayload(), nil)
	if err != nil {
		t.Fatal(err)
	}
	// Damage the server after the backup.
	write(t, data, "server.properties", "motd=CHANGED\n", 0o644)
	write(t, data, "griefed.txt", "x", 0o644)
	os.RemoveAll(filepath.Join(data, "world"))
	write(t, data, ".blockforge/keep", "agent state", 0o644)

	bad := &protocol.BackupRestorePayload{WorkloadID: wid, BackupID: bid, Source: protocol.BackupSource{Type: "local"},
		Sha256: strings.Repeat("0", 64), Truncate: true, MaxTotalBytes: 1 << 30}
	if _, err := m.Restore(context.Background(), bad, nil); code(err) != protocol.CodeChecksumMismatch {
		t.Fatalf("sha mismatch: %v", err)
	}
	if _, err := os.Stat(filepath.Join(data, "griefed.txt")); err != nil {
		t.Fatal("data touched before the checksum was verified")
	}
	ok := *bad
	ok.Sha256 = res.Sha256
	var stages []string
	rr, err := m.Restore(context.Background(), &ok, func(stage, msg string, _ *float64) { stages = append(stages, stage) })
	if err != nil {
		t.Fatal(err)
	}
	if rr.Files != 7 || rr.Bytes <= 0 {
		t.Fatalf("restore result %+v", rr)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "server.properties")); string(b) != "motd=hi\n" {
		t.Fatalf("server.properties %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "world", "region", "r.0.0.mca")); len(b) != 10000 {
		t.Fatal("world not restored")
	}
	if _, err := os.Stat(filepath.Join(data, "griefed.txt")); err == nil {
		t.Fatal("truncate did not remove extra files")
	}
	if b, _ := os.ReadFile(filepath.Join(data, ".blockforge", "keep")); string(b) != "agent state" {
		t.Fatal(".blockforge/ was not preserved")
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(filepath.Join(data, "start.sh")); fi.Mode().Perm() != 0o755 {
			t.Fatalf("permissions not restored: %v", fi.Mode())
		}
	}
	if strings.Join(stages, ",") == "" || !strings.Contains(strings.Join(stages, ","), "truncate") {
		t.Fatalf("stages %v", stages)
	}
	// Without truncate: merge (extra files stay).
	write(t, data, "extra.txt", "stays", 0o644)
	ok.Truncate = false
	if _, err := m.Restore(context.Background(), &ok, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(data, "extra.txt")); err != nil {
		t.Fatal("merge restore removed files")
	}
	// Restore of an unknown local backup.
	missing := ok
	missing.BackupID = "4b3c4d5e-6f70-4a81-9b2c-3d4e5f607182"
	if _, err := m.Restore(context.Background(), &missing, nil); code(err) != protocol.CodeNotFound {
		t.Fatalf("missing: %v", err)
	}
}

// s3Fake is an httptest TLS server acting as S3 multipart: PUT ?partNumber=N stores the part and
// answers with ETag = "md5(part)"; GET serves an object.
type s3Fake struct {
	srv      *httptest.Server
	mu       sync.Mutex
	parts    map[int][]byte
	lengths  map[int]int64
	inflight atomic.Int32
	maxIn    atomic.Int32
	fail500  map[int]int // part → remaining 500 answers
	forbid   map[int]bool
	object   []byte
	redirect bool
	puts     atomic.Int32
}

func newS3(t *testing.T) *s3Fake {
	s := &s3Fake{parts: map[int][]byte{}, lengths: map[int]int64{}, fail500: map[int]int{}, forbid: map[int]bool{}}
	s.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.redirect {
			http.Redirect(w, r, "https://example.com/elsewhere", http.StatusTemporaryRedirect)
			return
		}
		if r.URL.Query().Get("X-Amz-Signature") == "" {
			w.WriteHeader(403)
			return
		}
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Length", strconv.Itoa(len(s.object)))
			w.Write(s.object)
		case http.MethodPut:
			s.puts.Add(1)
			n := s.inflight.Add(1)
			defer s.inflight.Add(-1)
			for {
				m := s.maxIn.Load()
				if n <= m || s.maxIn.CompareAndSwap(m, n) {
					break
				}
			}
			pn, _ := strconv.Atoi(r.URL.Query().Get("partNumber"))
			body, _ := io.ReadAll(r.Body)
			time.Sleep(30 * time.Millisecond)
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.forbid[pn] {
				w.WriteHeader(403)
				return
			}
			if s.fail500[pn] > 0 {
				s.fail500[pn]--
				w.WriteHeader(500)
				return
			}
			s.parts[pn] = body
			s.lengths[pn] = r.ContentLength
			sum := md5.Sum(body)
			w.Header().Set("ETag", `"`+hex.EncodeToString(sum[:])+`"`)
			w.WriteHeader(200)
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *s3Fake) url(part int) string {
	return fmt.Sprintf("%s/bucket/k?partNumber=%d&uploadId=u&X-Amz-Signature=secret%d", s.srv.URL, part, part)
}

func TestUploadMultipart(t *testing.T) {
	m, data := newManager(t)
	write(t, data, "world/region/r.mca", strings.Repeat("x", 3<<20)+string(make([]byte, 1<<20)), 0o644)
	// Incompressible content so the archive spans several parts.
	rnd := make([]byte, 12<<20)
	crand.Read(rnd)
	os.WriteFile(filepath.Join(data, "noise.bin"), rnd, 0o644)
	if _, err := m.Create(context.Background(), createPayload(), nil); err != nil {
		t.Fatal(err)
	}
	archive := m.ArchivePath(wid, bid)
	fi, _ := os.Stat(archive)
	whole, _ := os.ReadFile(archive)
	s3 := newS3(t)
	m.Transport = s3.srv.Client().Transport
	const partSize = 5 << 20
	n := int((fi.Size() + partSize - 1) / partSize)
	if n < 3 {
		t.Fatalf("test archive too small: %d parts", n)
	}
	var parts []protocol.BackupUploadPart
	for i := n; i >= 1; i-- { // out of order on purpose
		parts = append(parts, protocol.BackupUploadPart{PartNumber: i, URL: s3.url(i)})
	}
	s3.fail500[2] = 2 // transient failures are retried
	res, err := m.Upload(context.Background(), &protocol.BackupUploadPayload{WorkloadID: wid, BackupID: bid, PartSize: partSize,
		Parts: parts, DeleteLocal: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var joined []byte
	for i, p := range res.Parts {
		if p.PartNumber != i+1 {
			t.Fatalf("parts not ordered: %+v", res.Parts)
		}
		body := s3.parts[p.PartNumber]
		sum := md5.Sum(body)
		if p.ETag != `"`+hex.EncodeToString(sum[:])+`"` || s3.lengths[p.PartNumber] != int64(len(body)) {
			t.Fatalf("part %d etag/length mismatch", p.PartNumber)
		}
		if p.PartNumber < n && len(body) != partSize {
			t.Fatalf("part %d is %d bytes", p.PartNumber, len(body))
		}
		joined = append(joined, body...)
	}
	if string(joined) != string(whole) {
		t.Fatal("uploaded parts do not reassemble the archive")
	}
	if m := s3.maxIn.Load(); m > 3 {
		t.Fatalf("%d parts in flight (max 3)", m)
	}
	if _, err := os.Stat(archive); err == nil {
		t.Fatal("deleteLocal did not remove the archive")
	}
}

func TestUploadFailuresNeverLeakURLs(t *testing.T) {
	m, data := newManager(t)
	write(t, data, "a.txt", "a", 0o644)
	if _, err := m.Create(context.Background(), createPayload(), nil); err != nil {
		t.Fatal(err)
	}
	s3 := newS3(t)
	m.Transport = s3.srv.Client().Transport
	up := func(parts ...protocol.BackupUploadPart) error {
		_, err := m.Upload(context.Background(), &protocol.BackupUploadPayload{WorkloadID: wid, BackupID: bid, PartSize: 5 << 20, Parts: parts, DeleteLocal: true}, nil)
		return err
	}
	s3.forbid[1] = true
	err := up(protocol.BackupUploadPart{PartNumber: 1, URL: s3.url(1)})
	if code(err) != protocol.CodeDownloadFailed || strings.Contains(err.Error(), "secret") || s3.puts.Load() != 1 {
		t.Fatalf("403 must fail once without retry and without the URL: %v (puts %d)", err, s3.puts.Load())
	}
	s3.forbid[1] = false
	s3.redirect = true
	if err := up(protocol.BackupUploadPart{PartNumber: 1, URL: s3.url(1)}); code(err) != protocol.CodeDownloadFailed {
		t.Fatalf("redirect must not be followed: %v", err)
	}
	s3.redirect = false
	if err := up(protocol.BackupUploadPart{PartNumber: 1, URL: s3.url(1)}, protocol.BackupUploadPart{PartNumber: 2, URL: s3.url(2)}); code(err) != protocol.CodeValidationFailed {
		t.Fatalf("part count mismatch: %v", err)
	}
	if err := up(protocol.BackupUploadPart{PartNumber: 1, URL: strings.Replace(s3.url(1), "https://", "http://", 1)}); code(err) != protocol.CodeValidationFailed {
		t.Fatalf("http part URL: %v", err)
	}
	// Network failure: the error message carries no query string.
	dead := "https://127.0.0.1:1/bucket/k?partNumber=1&X-Amz-Signature=topsecret"
	err = up(protocol.BackupUploadPart{PartNumber: 1, URL: dead})
	if err == nil || strings.Contains(err.Error(), "topsecret") || strings.Contains(err.Error(), "X-Amz") {
		t.Fatalf("network error leaked the URL: %v", err)
	}
	if _, err := os.Stat(m.ArchivePath(wid, bid)); err != nil {
		t.Fatal("archive deleted although the upload failed")
	}
}

func TestRestoreFromURL(t *testing.T) {
	m, data := newManager(t)
	populate(t, data)
	res, err := m.Create(context.Background(), createPayload(), nil)
	if err != nil {
		t.Fatal(err)
	}
	s3 := newS3(t)
	s3.object, _ = os.ReadFile(m.ArchivePath(wid, bid))
	m.Transport = s3.srv.Client().Transport
	m.Delete(&protocol.BackupRefPayload{WorkloadID: wid, BackupID: bid})
	os.RemoveAll(filepath.Join(data, "world"))
	p := &protocol.BackupRestorePayload{WorkloadID: wid, BackupID: bid, Source: protocol.BackupSource{Type: "url", URL: s3.url(0)},
		Sha256: res.Sha256, Truncate: true, MaxTotalBytes: 1 << 30}
	if _, err := m.Restore(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "world", "level.dat")); string(b) != "LEVEL" {
		t.Fatal("world not restored from URL")
	}
	tmpDir := filepath.Join(m.DataRoot, "backups", ".tmp")
	if es, _ := os.ReadDir(tmpDir); len(es) != 0 {
		t.Fatalf("download temp files left: %v", es)
	}
	// Corrupted download → CHECKSUM_MISMATCH, data untouched, temp removed.
	s3.object = append([]byte{}, s3.object...)
	s3.object[len(s3.object)/2] ^= 0xff
	write(t, data, "marker.txt", "untouched", 0o644)
	if _, err := m.Restore(context.Background(), p, nil); code(err) != protocol.CodeChecksumMismatch {
		t.Fatalf("corrupt download: %v", err)
	}
	if _, err := os.Stat(filepath.Join(data, "marker.txt")); err != nil {
		t.Fatal("data touched by a corrupt restore")
	}
	if es, _ := os.ReadDir(tmpDir); len(es) != 0 {
		t.Fatal("temp file left after mismatch")
	}
	// Size limit, redirect, bad status.
	small := *p
	small.MaxTotalBytes = 10
	if _, err := m.Restore(context.Background(), &small, nil); code(err) != protocol.CodeQuotaExceeded {
		t.Fatalf("size limit: %v", err)
	}
	s3.redirect = true
	if _, err := m.Restore(context.Background(), p, nil); code(err) != protocol.CodeDownloadFailed {
		t.Fatalf("redirect: %v", err)
	}
	s3.redirect = false
	nosig := *p
	nosig.Source.URL = s3.srv.URL + "/bucket/k"
	if _, err := m.Restore(context.Background(), &nosig, nil); code(err) != protocol.CodeDownloadFailed || strings.Contains(fmt.Sprint(err), "?") {
		t.Fatalf("403: %v", err)
	}
}

func TestDeleteIdempotentAndTransferPush(t *testing.T) {
	m, data := newManager(t)
	write(t, data, "a.txt", "a", 0o644)
	res, err := m.Create(context.Background(), createPayload(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var got []byte
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "BFAgent t" || r.URL.Path != "/agent/v1/transfers/5b3c4d5e-6f70-4a81-9b2c-3d4e5f607182" {
			w.WriteHeader(401)
			return
		}
		got, _ = io.ReadAll(r.Body)
		w.WriteHeader(204)
	}))
	defer cp.Close()
	m.Transfers = &artifact.Transfers{Client: cp.Client(), URL: func(id string) string { return cp.URL + "/agent/v1/transfers/" + id },
		Auth: func() (string, error) { return "BFAgent t", nil }}
	pr, err := m.TransferPush(context.Background(), &protocol.BackupTransferPushPayload{WorkloadID: wid, BackupID: bid, TransferID: "5b3c4d5e-6f70-4a81-9b2c-3d4e5f607182"})
	if err != nil || pr.Sha256 != res.Sha256 || int64(len(got)) != res.SizeBytes {
		t.Fatalf("push: %v %+v", err, pr)
	}
	ref := &protocol.BackupRefPayload{WorkloadID: wid, BackupID: bid}
	if err := m.Delete(ref); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(ref); err != nil {
		t.Fatalf("delete is not idempotent: %v", err)
	}
	if _, err := m.TransferPush(context.Background(), &protocol.BackupTransferPushPayload{WorkloadID: wid, BackupID: bid, TransferID: "5b3c4d5e-6f70-4a81-9b2c-3d4e5f607182"}); code(err) != protocol.CodeNotFound {
		t.Fatalf("push of a deleted backup: %v", err)
	}
}
