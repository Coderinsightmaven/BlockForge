// Package backup implements backup.create / upload / restore / delete / transfer.push
// (agent-protocol.md "Backups"). Archives live outside every sandbox at
// <dataRoot>/backups/<workloadId>/<backupId>.tar.gz (0600, agent-owned) and are NOT removed by
// workload.remove (the control plane deletes backups explicitly).
package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/blockforge/node-agent/internal/artifact"
	"github.com/blockforge/node-agent/internal/denylist"
	"github.com/blockforge/node-agent/internal/fileutil"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
	"github.com/blockforge/node-agent/internal/workload"
)

// Progress reports long-running progress (same shape as executor progress).
type Progress func(stage, message string, percent *float64)

// Claimer grants exclusive per-workload operations (the workload driver).
type Claimer interface {
	Claim(ctx context.Context, id, what string) (func(), error)
}

// Limits.
const (
	ignoreFileMax     = 64 * 1024
	freeCheckEvery    = 32 << 20
	restoreMaxEntries = 5_000_000
	defaultReserve    = 2 << 30
	progressEvery     = time.Second
	// DefaultMaxEntries bounds the entries a backup walks (config backupMaxEntries).
	DefaultMaxEntries = 2_000_000
	// DefaultMaxUncompressedBytes bounds the logical (uncompressed) bytes a backup reads, so sparse or
	// highly compressible files cannot cost unbounded I/O and CPU (config backupMaxUncompressedBytes).
	DefaultMaxUncompressedBytes = 256 << 30
)

// Manager runs backup commands.
type Manager struct {
	DataRoot string
	Sandbox  *fsops.Sandbox
	Claims   Claimer
	// FreeSpace reports free bytes on the filesystem of dir (nil = not checked).
	FreeSpace func(dir string) (int64, error)
	// Reserve is kept free while writing archives or restore downloads (default 2 GiB).
	Reserve int64
	// Transport for presigned S3 URLs (nil = hardened default transport).
	Transport http.RoundTripper
	Transfers *artifact.Transfers
	Logger    *slog.Logger
	// PartAttempts / RetryBase tune upload retries (defaults 4 / 1 s).
	PartAttempts int
	RetryBase    time.Duration
	// UploadConcurrency is the number of parts in flight (default 3).
	UploadConcurrency int
	// MaxEntries / MaxUncompressedBytes bound backup.create (defaults DefaultMaxEntries /
	// DefaultMaxUncompressedBytes).
	MaxEntries           int64
	MaxUncompressedBytes int64

	beforeOpen func(rel string) // test hook: runs right before the walk opens an entry
}

func (m *Manager) maxEntries() int64 {
	if m.MaxEntries > 0 {
		return m.MaxEntries
	}
	return DefaultMaxEntries
}

func (m *Manager) maxUncompressed() int64 {
	if m.MaxUncompressedBytes > 0 {
		return m.MaxUncompressedBytes
	}
	return DefaultMaxUncompressedBytes
}

func (m *Manager) logger() *slog.Logger {
	if m.Logger != nil {
		return m.Logger
	}
	return slog.Default()
}

func (m *Manager) reserve() int64 {
	if m.Reserve > 0 {
		return m.Reserve
	}
	return defaultReserve
}

func (m *Manager) dir(workloadID string) string {
	return filepath.Join(m.DataRoot, "backups", workloadID)
}

// ArchivePath is <dataRoot>/backups/<workloadId>/<backupId>.tar.gz (both ids are validated UUIDs).
func (m *Manager) ArchivePath(workloadID, backupID string) string {
	return filepath.Join(m.dir(workloadID), backupID+".tar.gz")
}

func (m *Manager) free(dir string) (int64, bool) {
	if m.FreeSpace == nil {
		return 0, false
	}
	f, err := m.FreeSpace(dir)
	if err != nil {
		return 0, false
	}
	return f, true
}

func (m *Manager) checkReserve(dir string) error {
	if f, ok := m.free(dir); ok && f < m.reserve() {
		return protocol.Errorf(protocol.CodeQuotaExceeded, "free disk space (%d bytes) is below the agent's reserve (%d bytes)", f, m.reserve())
	}
	return nil
}

func ptrPct(done, total int64) *float64 {
	if total <= 0 {
		return nil
	}
	p := float64(done) / float64(total) * 100
	if p > 100 {
		p = 100
	}
	return &p
}

func mib(n int64) int64 { return n >> 20 }

// ---------------------------------------------------------------------------
// backup.create

// CreateResult is the backup.create result.
type CreateResult struct {
	SizeBytes       int64  `json:"sizeBytes"`
	Sha256          string `json:"sha256"`
	Files           int64  `json:"files"`
	SkippedSymlinks int64  `json:"skippedSymlinks"`
	DurationMs      int64  `json:"durationMs"`
}

// archiveWriter counts and hashes written bytes and enforces maxBytes + the free-disk reserve.
type archiveWriter struct {
	m         *Manager
	w         io.Writer
	h         hash.Hash
	dir       string
	n         int64
	max       int64
	nextCheck int64
}

func (a *archiveWriter) Write(b []byte) (int, error) {
	if a.n+int64(len(b)) > a.max {
		return 0, protocol.Errorf(protocol.CodeQuotaExceeded, "archive exceeds maxBytes (%d)", a.max)
	}
	if a.n >= a.nextCheck {
		if err := a.m.checkReserve(a.dir); err != nil {
			return 0, err
		}
		a.nextCheck = a.n + freeCheckEvery
	}
	n, err := a.w.Write(b)
	a.h.Write(b[:n])
	a.n += int64(n)
	return n, err
}

// readIgnoreFile returns the patterns of an ignore file in the data root ("" lines kept out).
func readIgnoreFile(root *fsops.Root, name string) []string {
	f, _, err := root.OpenRegular(name)
	if err != nil {
		return nil
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, ignoreFileMax))
	var out []string
	for _, line := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n") {
		if l := strings.TrimSpace(line); l != "" && len(out) < 1000 {
			out = append(out, l)
		}
	}
	return out
}

// sourceReader remembers read errors (as opposed to archive write errors).
type sourceReader struct {
	f   *os.File
	err error
}

func (s *sourceReader) Read(b []byte) (int, error) {
	n, err := s.f.Read(b)
	if err != nil && err != io.EOF {
		s.err = err
	}
	return n, err
}

// zeroReader pads files that shrank while being archived (a running server).
type zeroReader struct{}

func (zeroReader) Read(b []byte) (int, error) {
	clear(b)
	return len(b), nil
}

// Create archives the data dir of a workload (may run while the server runs).
func (m *Manager) Create(ctx context.Context, p *protocol.BackupCreatePayload, progress Progress) (*CreateResult, error) {
	start := time.Now()
	release, err := m.Claims.Claim(ctx, p.WorkloadID, workload.ClaimBackup)
	if err != nil {
		return nil, err
	}
	defer release()
	root, err := m.Sandbox.Open(p.WorkloadID)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	dir := m.dir(p.WorkloadID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "backup dir: %v", err)
	}
	final := m.ArchivePath(p.WorkloadID, p.BackupID)
	if _, err := os.Lstat(final); err == nil {
		return nil, protocol.Errorf(protocol.CodeAlreadyExists, "backup %s already exists", p.BackupID)
	}
	if err := m.checkReserve(dir); err != nil {
		return nil, err
	}
	// Ignore rules: .pteroignore, then .blockforgeignore, then the request (last match wins).
	patterns := append(readIgnoreFile(root, ".pteroignore"), readIgnoreFile(root, ".blockforgeignore")...)
	patterns = append(patterns, p.Ignore...)
	ignore := denylist.New(patterns)
	prune := !ignore.Negates() // with "!" rules, ignored dirs must still be descended
	wo := fsops.WalkOptions{
		MaxEntries: m.maxEntries(),
		Skip: func(rel string, isDir bool) (bool, bool) {
			if rel == ".blockforge" || strings.HasPrefix(rel, ".blockforge/") {
				return true, true
			}
			if ignore.Denied(rel) {
				return true, prune
			}
			return false, false
		},
	}
	maxUnc := m.maxUncompressed()
	tooBig := func() error {
		return protocol.Errorf(protocol.CodeQuotaExceeded, "the data to back up exceeds the agent's uncompressed limit (%d bytes)", maxUnc)
	}
	// Pre-walk (no file is opened): totals for progress, and the entry / uncompressed-size limits are
	// enforced before anything is written. Sizes are logical sizes, so sparse files count in full.
	var totalBytes int64
	if _, err := root.WalkTree(ctx, ".", wo, func(e *fsops.TreeEntry) error {
		if e.Mode.IsRegular() {
			totalBytes += e.Size
			if totalBytes > maxUnc {
				return tooBig()
			}
		}
		return nil
	}); err != nil {
		return nil, walkError(err)
	}
	wo.BeforeOpen = m.beforeOpen // test hook, main walk only

	tmp, err := os.CreateTemp(dir, "."+p.BackupID+".tar.gz.tmp-*")
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "backup temp file: %v", err)
	}
	committed := false
	defer func() {
		if !committed {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	_ = tmp.Chmod(0o600)
	aw := &archiveWriter{m: m, w: tmp, h: sha256.New(), dir: dir, max: p.MaxBytes}
	// BestSpeed: world region files are already compressed, and backups often run next to a live server.
	gz, _ := gzip.NewWriterLevel(aw, gzip.BestSpeed)
	tw := tar.NewWriter(gz)
	res := &CreateResult{}
	var readBytes int64
	last := time.Now()
	// archiveFile streams one regular file and closes it before the walk moves on. Open/read errors
	// fail the backup; only entries that vanished or were replaced meanwhile are skipped.
	archiveFile := func(e *fsops.TreeEntry) error {
		f, fi, err := e.Open()
		if err != nil {
			if fsops.Skipped(err) {
				return nil // counted in the walk stats
			}
			return err
		}
		size := fi.Size()
		if readBytes+size > maxUnc {
			f.Close()
			return tooBig()
		}
		err = tw.WriteHeader(&tar.Header{Name: e.Rel, Typeflag: tar.TypeReg, Size: size, Mode: int64(fi.Mode().Perm()),
			ModTime: fi.ModTime(), Format: tar.FormatPAX})
		if err == nil {
			// Exactly `size` bytes: a file growing meanwhile is cut, a shrinking one zero-padded.
			src := &sourceReader{f: f}
			if _, err = io.CopyN(tw, io.MultiReader(src, zeroReader{}), size); err != nil && src.err != nil {
				err = fsops.MapError("read", e.Rel, src.err)
			}
		}
		f.Close()
		if err != nil {
			return err
		}
		res.Files++
		readBytes += size
		return nil
	}
	stats, walkErr := root.WalkTree(ctx, ".", wo, func(e *fsops.TreeEntry) error {
		switch {
		case e.Mode.IsDir():
			if err := tw.WriteHeader(&tar.Header{Name: e.Rel + "/", Typeflag: tar.TypeDir, Mode: int64(e.Info.Mode().Perm()),
				ModTime: e.Info.ModTime(), Format: tar.FormatPAX}); err != nil {
				return err
			}
		case e.Mode.IsRegular():
			if err := archiveFile(e); err != nil {
				return err
			}
		default:
			res.SkippedSymlinks++ // symlinks, FIFOs, sockets, devices
		}
		if progress != nil && time.Since(last) >= progressEvery {
			last = time.Now()
			progress("archive", fmt.Sprintf("%d files, %d of %d MiB", res.Files, mib(readBytes), mib(totalBytes)), ptrPct(readBytes, totalBytes))
		}
		return nil
	})
	if walkErr == nil {
		walkErr = tw.Close()
	}
	if walkErr == nil {
		walkErr = gz.Close()
	}
	if walkErr != nil {
		return nil, walkError(walkErr)
	}
	// Entries replaced while walking (a symlink or another object swapped in) are skipped and
	// reported with the other special entries; vanished ones only in the agent log.
	res.SkippedSymlinks += stats.Changed
	if err := tmp.Sync(); err != nil {
		return nil, fsops.MapError("backup", "archive", err)
	}
	if err := tmp.Close(); err != nil {
		return nil, fsops.MapError("backup", "archive", err)
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "publish backup: %v", err)
	}
	committed = true
	fileutil.SyncDir(dir)
	res.SizeBytes = aw.n
	res.Sha256 = hex.EncodeToString(aw.h.Sum(nil))
	res.DurationMs = time.Since(start).Milliseconds()
	m.logger().Info("backup created", "workload", p.WorkloadID, "backup", p.BackupID, "files", res.Files,
		"bytes", res.SizeBytes, "skippedSpecial", res.SkippedSymlinks-stats.Changed, "skippedChanged", stats.Changed,
		"skippedVanished", stats.Vanished, "entries", stats.Entries, "durationMs", res.DurationMs)
	if progress != nil {
		hundred := 100.0
		progress("archive", fmt.Sprintf("%d files, %d MiB archive", res.Files, mib(res.SizeBytes)), &hundred)
	}
	return res, nil
}

// walkError maps a walk/archive error to a protocol error (context errors pass through).
func walkError(err error) error {
	if pe, ok := protocol.AsError(err); ok {
		return pe
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return fsops.MapError("backup", "archive", err)
}

// ---------------------------------------------------------------------------
// backup.delete / backup.transfer.push

// Delete removes the local archive (idempotent).
func (m *Manager) Delete(p *protocol.BackupRefPayload) error {
	err := os.Remove(m.ArchivePath(p.WorkloadID, p.BackupID))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return protocol.Errorf(protocol.CodeInternal, "delete backup: %v", err)
	}
	return nil
}

func (m *Manager) openArchive(workloadID, backupID string) (*os.File, int64, error) {
	f, err := os.Open(m.ArchivePath(workloadID, backupID))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, 0, protocol.Errorf(protocol.CodeNotFound, "backup %s is not stored on this node", backupID)
		}
		return nil, 0, protocol.Errorf(protocol.CodeInternal, "open backup: %v", err)
	}
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		f.Close()
		return nil, 0, protocol.Errorf(protocol.CodeInternal, "backup %s is not a regular file", backupID)
	}
	return f, fi.Size(), nil
}

// TransferPush streams a local archive to the control plane.
func (m *Manager) TransferPush(ctx context.Context, p *protocol.BackupTransferPushPayload) (*artifact.Result, error) {
	f, size, err := m.openArchive(p.WorkloadID, p.BackupID)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return m.Transfers.PushReader(ctx, f, size, p.TransferID)
}

func randomName() string {
	var b [12]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
