package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/protocol"
)

// failOpen makes the next file open fail with a real I/O error (Linux: RLIMIT_NOFILE → EMFILE) and
// returns the undo func; nil where unsupported.
var failOpen func(t *testing.T) func()

// lockedBuffer collects log output from several goroutines.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func symlinksOrSkip(t *testing.T, dir string) {
	t.Helper()
	p := filepath.Join(dir, ".probe-link")
	if err := os.Symlink("x", p); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	os.Remove(p)
}

func newBackupID(n int) string {
	return "5b3c4d5e-6f70-4a81-9b2c-" + strings.Repeat("0", 12-len(itoa(n))) + itoa(n)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

// TestCreateSwappedEntriesNotFollowed is review "agent backups" #1 made deterministic: right before
// the walk opens them, a regular file is replaced by a symlink to the agent area and a directory by
// a symlink to the agent area. Neither may be followed: nothing from .blockforge/ may end up in the
// archive under another name; both are skipped and counted.
func TestCreateSwappedEntriesNotFollowed(t *testing.T) {
	m, data := newManager(t)
	symlinksOrSkip(t, data)
	write(t, data, ".blockforge/secret.txt", "AGENT-SECRET", 0o644)
	write(t, data, "a.dat", "public", 0o644)
	write(t, data, "world/level.dat", "LEVEL", 0o644)
	write(t, data, "z.txt", "after", 0o644)
	m.beforeOpen = func(rel string) {
		switch rel {
		case "a.dat":
			os.Remove(filepath.Join(data, "a.dat"))
			os.Symlink(".blockforge/secret.txt", filepath.Join(data, "a.dat"))
		case "world":
			os.RemoveAll(filepath.Join(data, "world"))
			os.Symlink(".blockforge", filepath.Join(data, "world"))
		}
	}
	p := createPayload()
	p.Ignore = nil
	res, err := m.Create(context.Background(), p, nil)
	if err != nil {
		t.Fatal(err)
	}
	entries := listArchive(t, m.ArchivePath(wid, bid))
	for name, v := range entries {
		if strings.Contains(v, "AGENT-SECRET") || strings.Contains(name, "secret") || strings.HasPrefix(name, ".blockforge") {
			t.Fatalf("agent-area content archived as %s", name)
		}
	}
	if _, ok := entries["a.dat"]; ok {
		t.Fatal("swapped file archived")
	}
	if _, ok := entries["world/"]; ok {
		t.Fatal("swapped directory archived")
	}
	if _, ok := entries["z.txt"]; !ok || res.SkippedSymlinks != 2 || res.Files != 1 {
		t.Fatalf("entries %v result %+v", entries, res)
	}
}

// TestCreateVanishedAndUnreadable: files removed between the directory read and the open are
// skipped (agent log: skippedVanished, not in the result); anything else failing to open or read
// fails the backup instead of publishing an incomplete archive (review #2).
func TestCreateVanishedAndUnreadable(t *testing.T) {
	m, data := newManager(t)
	var logs lockedBuffer
	m.Logger = slog.New(slog.NewTextHandler(&logs, nil))
	populate(t, data)
	m.beforeOpen = func(rel string) {
		if rel == "world/level.dat" || rel == "logs" {
			os.RemoveAll(filepath.Join(data, filepath.FromSlash(rel)))
		}
	}
	p := createPayload()
	res, err := m.Create(context.Background(), p, nil)
	if err != nil {
		t.Fatal(err)
	}
	entries := listArchive(t, m.ArchivePath(wid, bid))
	if _, ok := entries["world/level.dat"]; ok {
		t.Fatal("vanished file archived")
	}
	if _, ok := entries["logs/keep.log"]; ok {
		t.Fatal("vanished directory archived")
	}
	if res.SkippedSymlinks != 0 || res.Files != 5 || !strings.Contains(logs.String(), "skippedVanished=2") {
		t.Fatalf("result %+v log %s", res, logs.String())
	}
	if failOpen == nil {
		return
	}
	// An open that fails for another reason (here EMFILE) fails the backup.
	write(t, data, "world/level.dat", "LEVEL", 0o644)
	var undo func()
	m.beforeOpen = func(rel string) {
		if rel == "server.properties" && undo == nil {
			undo = failOpen(t)
		}
	}
	p.BackupID = newBackupID(2)
	_, err = m.Create(context.Background(), p, nil)
	if undo != nil {
		undo()
	}
	if err == nil || undo == nil {
		t.Fatalf("a file that could not be opened was silently skipped (err %v)", err)
	}
	t.Logf("open failure: %v", err)
	if _, err := os.Stat(m.ArchivePath(wid, p.BackupID)); err == nil {
		t.Fatal("incomplete archive published")
	}
	noTemps(t, m.dir(wid))
}

// TestCreateLimits: entry cap and uncompressed cap (logical size, so a huge sparse file is refused
// up front), and the uncompressed cap while streaming a file that grew after the pre-walk (#2, #3).
func TestCreateLimits(t *testing.T) {
	m, data := newManager(t)
	populate(t, data)
	m.MaxEntries = 5
	if _, err := m.Create(context.Background(), createPayload(), nil); code(err) != protocol.CodeQuotaExceeded {
		t.Fatalf("entry cap: %v", err)
	}
	m.MaxEntries = 0
	logical := int64(64 << 20)
	if runtime.GOOS == "linux" {
		logical = 64 << 30 // sparse: no disk use, but 64 GiB of zeros to read without the cap
	}
	f, err := os.Create(filepath.Join(data, "sparse.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(logical); err != nil {
		t.Fatal(err)
	}
	f.Close()
	m.MaxUncompressedBytes = 1 << 20
	start := time.Now()
	if _, err := m.Create(context.Background(), createPayload(), nil); code(err) != protocol.CodeQuotaExceeded {
		t.Fatalf("uncompressed cap: %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("uncompressed cap enforced only after %v", time.Since(start))
	}
	os.Remove(filepath.Join(data, "sparse.bin"))
	// Growth between the pre-walk and the copy is caught while streaming.
	m.beforeOpen = func(rel string) {
		if rel == "world/region/r.0.0.mca" {
			os.Truncate(filepath.Join(data, "world", "region", "r.0.0.mca"), 2<<20)
		}
	}
	if _, err := m.Create(context.Background(), createPayload(), nil); code(err) != protocol.CodeQuotaExceeded {
		t.Fatalf("uncompressed cap while streaming: %v", err)
	}
	if _, err := os.Stat(m.ArchivePath(wid, bid)); err == nil {
		t.Fatal("archive published over the limit")
	}
	noTemps(t, m.dir(wid))
}

// localArchive stores a hand-made archive as a local backup and returns its sha256.
func localArchive(t *testing.T, m *Manager, entries ...[2]string) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		tw.WriteHeader(&tar.Header{Name: e[0], Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(e[1]))})
		tw.Write([]byte(e[1]))
	}
	tw.Close()
	gz.Close()
	os.MkdirAll(m.dir(wid), 0o700)
	if err := os.WriteFile(m.ArchivePath(wid, bid), buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	s := sha256.Sum256(buf.Bytes())
	return hex.EncodeToString(s[:])
}

func dataTree(t *testing.T, dir string) string {
	t.Helper()
	var out []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && p != dir && !d.IsDir() {
			b, _ := os.ReadFile(p)
			out = append(out, filepath.ToSlash(strings.TrimPrefix(p, dir))+"="+string(b))
		}
		return nil
	})
	return strings.Join(out, ",")
}

// TestRestoreIsStaged: review #4 through backup.restore. A truncate restore whose extraction fails
// half-way leaves the old data in place; the disk reserve is checked against the staged copy before
// anything is written; nothing is left behind.
func TestRestoreIsStaged(t *testing.T) {
	m, data := newManager(t)
	populate(t, data)
	before := dataTree(t, data)
	sum := localArchive(t, m, [2]string{"aaa.txt", "new"}, [2]string{"server.properties", "motd=new\n"},
		[2]string{"zzz", "file"}, [2]string{"zzz/inner", "below a file"})
	p := &protocol.BackupRestorePayload{WorkloadID: wid, BackupID: bid, Source: protocol.BackupSource{Type: "local"},
		Sha256: sum, Truncate: true, MaxTotalBytes: 1 << 30}
	if _, err := m.Restore(context.Background(), p, nil); err == nil {
		t.Fatal("restore of a failing archive succeeded")
	}
	if got := dataTree(t, data); got != before {
		t.Fatalf("failed truncate restore changed the data\n got %s\nwant %s", got, before)
	}
	base := m.Sandbox.WorkloadBase(wid)
	names, _ := os.ReadDir(base)
	for _, n := range names {
		if n.Name() != "data" {
			t.Fatalf("left behind: %s", n.Name())
		}
	}
	// Disk reserve: 2 GiB default reserve + 10 bytes free; the archive expands to more than 10 bytes.
	sum = localArchive(t, m, [2]string{"server.properties", "motd=from-backup\n"})
	p.Sha256 = sum
	m.FreeSpace = func(string) (int64, error) { return 2<<30 + 10, nil }
	_, err := m.Restore(context.Background(), p, nil)
	if code(err) != protocol.CodeQuotaExceeded {
		t.Fatalf("reserve vs staged copy: %v", err)
	}
	if got := dataTree(t, data); got != before {
		t.Fatal("restore refused for disk space changed the data")
	}
	m.FreeSpace = func(string) (int64, error) { return 3 << 30, nil }
	if _, err := m.Restore(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "server.properties")); string(b) != "motd=from-backup\n" {
		t.Fatalf("restored %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(data, ".blockforge", "jvm.json")); string(b) != "{}" {
		t.Fatal(".blockforge/ not carried over")
	}
}
